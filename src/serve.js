// Self-hosting mode: one process that polls in the background and serves the
// dashboard over HTTP, so you keep a tab open instead of re-running a command
// and reopening a file.
//
// Binds to localhost by default. This speaks to ComEd on your behalf and has no
// authentication, so exposing it to a network is opt-in via --host.

import { createServer } from 'node:http';

import { analyzeHistory } from './analyze.js';
import { renderHtml } from './html.js';
import { loadSnapshots } from './storage.js';

export function startServer({
  dataDir,
  zones,
  port = 8080,
  host = '127.0.0.1',
  poll,
  intervalMinutes = 10,
  log = () => {},
}) {
  let lastPollAt = null;
  let lastError = null;
  let polling = false;

  const analysis = () => analyzeHistory(loadSnapshots(dataDir), zones);

  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return send(res, 200, 'text/html; charset=utf-8', renderHtml(analysis(), { live: true }));
      }

      if (url.pathname === '/api.json') {
        const current = analysis();
        return send(
          res,
          200,
          'application/json; charset=utf-8',
          JSON.stringify(
            {
              capturedAt: current.empty ? null : current.latest.capturedAt,
              customersOut: current.empty ? null : current.latest.customersOut,
              outages: current.empty ? null : current.latest.outages,
              polling,
              lastPollAt,
              lastError,
              nextPollInMinutes: intervalMinutes,
            },
            null,
            2,
          ),
        );
      }

      if (url.pathname === '/refresh' && req.method === 'POST') {
        void pollOnce();
        return send(res, 202, 'application/json', '{"status":"polling"}');
      }

      return send(res, 404, 'text/plain; charset=utf-8', 'Not found');
    } catch (error) {
      return send(res, 500, 'text/plain; charset=utf-8', `Error: ${error.message}`);
    }
  });

  async function pollOnce() {
    if (polling) return; // never stack polls on a slow crawl
    polling = true;
    try {
      const snapshot = await poll();
      lastPollAt = snapshot.capturedAt;
      lastError = null;
    } catch (error) {
      // Keep serving the last good dashboard — ComEd's map goes down exactly
      // when a storm makes it interesting.
      lastError = error.message;
      log(`Poll failed: ${error.message}`);
    } finally {
      polling = false;
    }
  }

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, async () => {
      log(`Dashboard: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
      log(`Polling every ${intervalMinutes} min. Ctrl-C to stop.`);

      await pollOnce();
      const timer = setInterval(pollOnce, intervalMinutes * 60 * 1000);
      timer.unref?.();

      const shutdown = () => {
        clearInterval(timer);
        server.close(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      resolve(server);
    });
  });
}

function send(res, status, contentType, body) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
