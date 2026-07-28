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
const isInteresting = (url) => /config|\.html|\/$/i.test(url) && !/bm8|infobox|styles/i.test(url);

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
