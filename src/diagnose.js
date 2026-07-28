// Endpoint diagnostics, meant to be read out of CI logs.
//
// The crawler can be developed anywhere, but ComEd is only reachable from a
// machine with open egress. When discovery fails, guessing from the outside is
// slow and wrong; printing what the map actually serves is fast and right.
// This dumps the small config files verbatim and, for the large bundles, the
// text surrounding every GUID — which is where a Storm Center deployment keeps
// its instance and view identifiers.

import { HttpClient } from './http.js';

const GUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const SCRIPT_SRC_RE = /<script[^>]+src=["']([^"']+)["']/gi;

// Printed in full. Anything larger only gets GUID context, or the log becomes
// unreadable — ComEd's main bundle alone is 4.5 MB.
const FULL_DUMP_LIMIT = 12_000;
const CONTEXT_CHARS = 90;

const PAGES = [
  'https://outagemap.comed.com/',
  'https://outagemap.comed.com/m.html',
  // ComEd's current map. Its hashed bundles cannot be fetched by guessed path —
  // the server returns this shell for anything unknown — so the shell's own
  // <base href> and script tags are the way in.
  'https://www.comed.com/Outages/CheckOutageStatus/Pages/OutageMap.aspx',
];

// Storm Center 4.x keeps its wiring here. Fetched directly rather than waiting
// to find them via <script src>, since the redirect stub links nothing.
const KNOWN_CONFIGS = [
  'https://outagemap.comed.com/scripts/mobile_impl/config.js',
  'https://outagemap.comed.com/scripts/mobile_impl/IFactorDataMonitor_config.js',
  'https://outagemap.comed.com/scripts/mobile_impl/IFactorLayersHandler_config.js',
  'https://outagemap.comed.com/scripts/mobile_impl/stormcenter_impl.js',
  'https://outagemap.comed.com/scripts/mobile/IFactorDataMonitor.js',
  'https://outagemap.comed.com/scripts/mobile/stormcenter.js',
];

// ComEd runs iFactor-era Storm Center, which has no instance/view GUIDs at all.
// What matters there is where the layers point: the *_config.js files name the
// tile directories and data URLs the map actually reads. Library code is noise.
const isInteresting = (url) =>
  /config|\.html|\.aspx|\/$/i.test(url) && !/bm8|infobox|styles/i.test(url);

export async function runDiagnose({ write = (s) => process.stdout.write(s) } = {}) {
  const http = new HttpClient({ concurrency: 6 });
  const targets = [...PAGES];

  write('='.repeat(72) + '\nComEd Storm Center endpoint diagnostics\n' + '='.repeat(72) + '\n\n');

  // Collect script URLs referenced by the pages, then add the known configs.
  for (const page of PAGES) {
    const res = await safeGet(http, page);
    if (!res.ok) continue;
    for (const match of res.body.matchAll(SCRIPT_SRC_RE)) {
      try {
        const url = new URL(match[1], page).toString();
        if (!/googletagmanager|google-analytics|bing\.com|recaptcha/i.test(url) && !targets.includes(url)) {
          targets.push(url);
        }
      } catch {
        /* unresolvable src */
      }
    }
  }
  for (const config of KNOWN_CONFIGS) if (!targets.includes(config)) targets.push(config);

  const allGuids = new Map(); // guid -> where it was seen

  for (const url of targets) {
    const res = await safeGet(http, url);
    write(`\n${'-'.repeat(72)}\n${url}\n  HTTP ${res.status}${res.ok ? ` · ${res.body.length} bytes` : ''}\n`);
    if (!res.ok) continue;

    for (const guid of res.body.match(GUID_RE) ?? []) {
      if (!allGuids.has(guid)) allGuids.set(guid, url);
    }

    if (!isInteresting(url)) {
      write('  (library code — skipped; only *_config.js name the data sources)\n');
      continue;
    }

    if (res.body.length <= FULL_DUMP_LIMIT) {
      write('--- full contents ---\n' + res.body + '\n--- end ---\n');
      continue;
    }

    // Too big to print. Show what surrounds each GUID instead — an id is only
    // useful alongside the key that names it.
    const seen = new Set();
    let shown = 0;
    for (const match of res.body.matchAll(GUID_RE)) {
      if (seen.has(match[0]) || shown >= 25) continue;
      seen.add(match[0]);
      shown++;
      const from = Math.max(0, match.index - CONTEXT_CHARS);
      const to = Math.min(res.body.length, match.index + match[0].length + CONTEXT_CHARS);
      write(`  …${res.body.slice(from, to).replace(/\s+/g, ' ')}…\n`);
    }
    if (shown === 0) write('  (no GUIDs in this file)\n');
  }

  write(`\n${'='.repeat(72)}\nAll GUIDs seen (${allGuids.size})\n${'='.repeat(72)}\n`);
  for (const [guid, source] of allGuids) {
    write(`  ${guid}  ${source.replace('https://', '')}\n`);
  }
  write(`\nRequests: ${http.requestCount}\n`);
}

async function safeGet(http, url) {
  try {
    return await http.get(url, { accept: '*/*' });
  } catch (error) {
    return { ok: false, status: error.message, body: '', url };
  }
}

// --- iFactor data protocol probe -------------------------------------------
//
// ComEd's map polls a directory pointer rather than calling an API:
//
//   data/interval_generation_data/metadata.xml   -> current <directory>
//   {dir}/data.js                                -> system totals
//   {dir}/thematic/thematic_areas.js             -> per-county aggregates
//   {dir}/outages/<index>.js                     -> individual outages
//
// The exact path composition lives in a customGetFullDataDirectory function we
// cannot read, so this tries the plausible arrangements and prints what sticks.

const IFACTOR_BASE = 'https://outagemap.comed.com/';

// outagemap.comed.com answers every request correctly but its metadata pointer
// has been frozen at 2020_11_16_18_00_46 for years — a decommissioned host
// still serving its last snapshot. Any client built on it must check freshness,
// or it will publish six-year-old outages with total confidence.
export const STALE_AFTER_HOURS = 6;

/** Parse the timestamp encoded in an iFactor directory name (YYYY_MM_DD_HH_MM_SS). */
export function directoryTimestamp(directory) {
  const m = /(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})/.exec(directory ?? '');
  if (!m) return null;
  const [, y, mo, d, h, mi, sec] = m;
  const at = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${sec}Z`);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

/** Hours between an iFactor directory's timestamp and now, or null. */
export function directoryAgeHours(directory, now = Date.now()) {
  const at = directoryTimestamp(directory);
  return at === null ? null : (now - Date.parse(at)) / 3600000;
}

export async function probeIFactor({ write = (s) => process.stdout.write(s) } = {}) {
  const http = new HttpClient({ concurrency: 4 });
  const show = async (label, url, limit = 2500) => {
    const res = await safeGet(http, url);
    write(`\n### ${label}\n${url}\n  HTTP ${res.status}${res.ok ? ` · ${res.body.length} bytes` : ''}\n`);
    if (res.ok) write(res.body.slice(0, limit) + (res.body.length > limit ? '\n  …truncated…\n' : '\n'));
    return res;
  };

  write('\n' + '='.repeat(72) + '\niFactor data protocol probe\n' + '='.repeat(72) + '\n');

  const metadata = await show('metadata pointer', `${IFACTOR_BASE}data/interval_generation_data/metadata.xml`);
  if (!metadata.ok) return;

  // The pointer is XML; grab every element that could name a directory.
  const directories = [...metadata.body.matchAll(/<(\w*directory\w*)>([^<]+)<\/\1>/gi)].map((m) => m[2].trim());
  write(`\n  parsed directory values: ${JSON.stringify(directories)}\n`);
  if (directories.length === 0) return;

  for (const directory of [...new Set(directories)].slice(0, 3)) {
    // Both arrangements seen in iFactor deployments: the pointer is either a
    // full path from the web root, or a leaf under the data directory.
    const bases = [
      `${IFACTOR_BASE}${directory.replace(/^\/+/, '')}`,
      `${IFACTOR_BASE}data/interval_generation_data/${directory.replace(/^\/+/, '')}`,
    ];

    for (const base of bases) {
      const overview = await show(`overview for "${directory}"`, `${base.replace(/\/+$/, '')}/data.js`, 1800);
      if (!overview.ok) continue;

      await show('per-county aggregates', `${base.replace(/\/+$/, '')}/thematic/thematic_areas.js`, 3000);
      await show('per-ZIP aggregates', `${base.replace(/\/+$/, '')}/thematiczip/thematic_areas.js`, 800);

      // indexvectorlayer: an index names the tiles that actually hold outages.
      for (const candidate of ['index.js', 'data.js', '0.js', '03.js', '030.js']) {
        await show(`outages/${candidate}`, `${base.replace(/\/+$/, '')}/outages/${candidate}`, 900);
      }
      return; // first arrangement that works is the real one
    }
  }
}

// --- live (Angular) map probe ----------------------------------------------
//
// ComEd's current map is an Angular app. Its bundles cannot be found by
// guessing paths: the server answers any unknown path under that directory
// with the same shell, so a wrong guess looks like a 200. The shell is
// therefore compared byte-for-byte against every candidate — anything equal to
// it is the fallback, not a file — and whatever is genuinely different gets
// scanned for the URLs the app calls at runtime.

const LIVE_PAGE = 'https://www.comed.com/Outages/CheckOutageStatus/Pages/OutageMap.aspx';

// Strings that look like a data endpoint rather than an asset.
const ENDPOINT_HINTS =
  /(https?:\/\/[^"'`\s)]{8,140})|((?:\/[\w.-]+){1,6}\/(?:metadata\.xml|data\.js|[\w.-]*outage[\w.-]*\.(?:json|js|xml)))/gi;

export async function probeAngular({ write = (s) => process.stdout.write(s) } = {}) {
  const http = new HttpClient({ concurrency: 6 });
  write('\n' + '='.repeat(72) + '\nLive map (Angular) probe\n' + '='.repeat(72) + '\n');

  const shell = await safeGet(http, LIVE_PAGE);
  write(`\n${LIVE_PAGE}\n  HTTP ${shell.status} · ${shell.body.length} bytes\n`);
  if (!shell.ok) return;
  write('--- shell HTML ---\n' + shell.body + '\n--- end ---\n');

  const baseHref = /<base[^>]+href=["']([^"']+)["']/i.exec(shell.body)?.[1] ?? null;
  write(`\n  <base href> = ${baseHref ?? '(none)'}\n`);

  // Resolve every referenced asset against the base href AND the page, plus a
  // few roots Angular deployments commonly use.
  const referenced = [...shell.body.matchAll(SCRIPT_SRC_RE)].map((m) => m[1]);
  write(`  referenced scripts: ${JSON.stringify(referenced)}\n`);

  const roots = [
    baseHref ? new URL(baseHref, LIVE_PAGE).toString() : null,
    new URL('.', LIVE_PAGE).toString(),
    'https://www.comed.com/Outages/CheckOutageStatus/',
    'https://www.comed.com/',
  ].filter(Boolean);

  const tried = new Set();
  const realFiles = [];

  for (const name of referenced) {
    for (const root of roots) {
      let url;
      try {
        url = new URL(name, root).toString();
      } catch {
        continue;
      }
      if (tried.has(url)) continue;
      tried.add(url);

      const res = await safeGet(http, url);
      // The SPA fallback returns the shell verbatim; that is a miss, not a hit.
      const isFallback = res.ok && res.body === shell.body;
      write(`  ${url} -> HTTP ${res.status}${res.ok ? ` · ${res.body.length}B` : ''}${isFallback ? '  (shell fallback)' : ''}\n`);
      if (res.ok && !isFallback && res.body.length > 500) realFiles.push({ url, body: res.body });
    }
  }

  if (realFiles.length === 0) {
    write('\n  No real bundle reachable — every candidate returned the shell.\n');
    write('  The asset base is elsewhere; the endpoint cannot be read from here.\n');
    return;
  }

  // Angular builds most request URLs from relative paths and config constants,
  // so absolute-URL matching alone misses the API. Search the real bundles for
  // the terms an outage service would be named after and print the surrounding
  // source, which is where the path and any gateway host actually appear.
  const KEYWORDS = [
    'azure-api.net', 'subscription-key', 'Ocp-Apim',
    'outageMap', 'OutageMap', 'getOutage', 'outages/', 'outage-map',
    'interval_generation', 'metadata.xml', 'stormcenter', 'kubra',
    '/api/', '.svc/', 'apiUrl', 'baseUrl', 'environment.',
  ];
  for (const file of realFiles) {
    write(`\n--- keyword context in ${file.url} (${file.body.length} bytes) ---\n`);
    for (const keyword of KEYWORDS) {
      let from = 0;
      let hits = 0;
      while (hits < 4) {
        const at = file.body.indexOf(keyword, from);
        if (at === -1) break;
        hits++;
        from = at + keyword.length;
        const snippet = file.body.slice(Math.max(0, at - 130), at + keyword.length + 130);
        write(`  [${keyword}] …${snippet.replace(/\s+/g, ' ')}…\n`);
      }
      if (hits === 0) continue;
    }
  }

  for (const file of realFiles) {
    write(`\n--- endpoint-like strings in ${file.url} ---\n`);
    const seen = new Set();
    for (const match of file.body.matchAll(ENDPOINT_HINTS)) {
      const hit = match[0];
      if (seen.has(hit) || seen.size >= 60) continue;
      if (/\.(png|jpg|svg|gif|woff2?|css|ico)$/i.test(hit)) continue;
      if (/w3\.org|schemas\.|googleapis|gstatic|jquery|bootstrap/i.test(hit)) continue;
      seen.add(hit);
      write(`  ${hit}\n`);
    }
    if (seen.size === 0) write('  (none)\n');
  }
}
