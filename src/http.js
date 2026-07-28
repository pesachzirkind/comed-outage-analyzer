// Small fetch wrapper: browser-ish headers, timeouts, retries, and a
// concurrency limiter. Tile crawling issues hundreds of requests, so being
// polite (and bounded) matters.

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export class HttpClient {
  constructor({ timeoutMs = 20000, retries = 3, concurrency = 8 } = {}) {
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.concurrency = concurrency;
    this.requestCount = 0;
    this.bytesDownloaded = 0;
    this._active = 0;
    this._queue = [];
  }

  async _withSlot(task) {
    if (this._active >= this.concurrency) {
      await new Promise((resolve) => this._queue.push(resolve));
    }
    this._active++;
    try {
      return await task();
    } finally {
      this._active--;
      const next = this._queue.shift();
      if (next) next();
    }
  }

  /**
   * GET a URL. Returns { ok, status, body } — a 404 resolves normally with
   * ok:false because Kubra omits tiles that contain no outages, which is a
   * routine, expected outcome rather than an error.
   */
  async get(url, { accept = 'application/json' } = {}) {
    return this._withSlot(async () => {
      let lastError;
      for (let attempt = 0; attempt <= this.retries; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
          const res = await fetch(url, {
            signal: controller.signal,
            redirect: 'follow',
            headers: {
              'User-Agent': USER_AGENT,
              Accept: accept,
              'Accept-Language': 'en-US,en;q=0.9',
            },
          });
          const body = await res.text();
          this.requestCount++;
          this.bytesDownloaded += body.length;

          // 404 means "no data here" for tiles; do not burn retries on it.
          if (res.status === 404) return { ok: false, status: 404, body: '', url };
          if (!res.ok && res.status >= 500 && attempt < this.retries) {
            lastError = new Error(`HTTP ${res.status} from ${url}`);
            await sleep(backoffMs(attempt));
            continue;
          }
          return { ok: res.ok, status: res.status, body, url };
        } catch (error) {
          lastError = error;
          if (attempt < this.retries) await sleep(backoffMs(attempt));
        } finally {
          clearTimeout(timer);
        }
      }
      throw new Error(`Request failed after ${this.retries + 1} attempts: ${url}\n  ${lastError?.message}`);
    });
  }

  async getJson(url) {
    const res = await this.get(url);
    if (!res.ok) return null;
    try {
      return JSON.parse(res.body);
    } catch {
      throw new Error(`Expected JSON but got something else from ${url}`);
    }
  }

  async getText(url) {
    const res = await this.get(url, { accept: 'text/html,application/xhtml+xml,*/*' });
    return res.ok ? res.body : null;
  }
}

const backoffMs = (attempt) => 500 * 2 ** attempt;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run `worker` over every item with bounded concurrency, preserving order. */
export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
