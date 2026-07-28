#!/usr/bin/env node
// ComEd outage analyzer — CLI.
//
//   node comed.js check          poll, print what changed, refresh the dashboard
//   node comed.js watch          do that on a timer
//
// Everything else is a smaller piece of those two.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { analyzeHistory, sinceAnchor } from './src/analyze.js';
import { HttpClient } from './src/http.js';
import { KubraClient } from './src/kubra.js';
import { renderHtml } from './src/html.js';
import { renderTerminalReport } from './src/report.js';
import { startServer } from './src/serve.js';
import {
  DEFAULT_DATA_DIR,
  loadConfig,
  loadSnapshots,
  pruneSnapshots,
  saveConfig,
  saveSnapshot,
} from './src/storage.js';
import { loadZones } from './src/zones.js';

const USAGE = `
ComEd outage analyzer

Usage
  node comed.js <command> [options]

Commands
  serve              Run it as a local service: polls in the background and
                     serves a live dashboard at http://localhost:8080 that
                     refreshes itself. Leave a tab open and forget about it.
  check              Poll once, show what changed, and rebuild the dashboard.
                     This is the one to run every 5-10 minutes.
  poll               Fetch a snapshot and save it. No report.
  report             Analyze saved snapshots and print the terminal report.
  html               Rebuild dashboard.html from saved snapshots.
  watch              Run "check" on a timer until you stop it.
  demo               Generate synthetic snapshots so you can see the output
                     without touching the network.
  status             Show what has been collected so far.

Options
  --since <when>     Also report totals fixed since an earlier point:
                     "first", a duration ("90m", "3h"), a snapshot count back
                     ("5"), or an ISO timestamp.
  --port <n>         Port for serve (default 8080)
  --host <addr>      Bind address for serve (default 127.0.0.1, localhost only)
  --interval <min>   Polling interval for serve/watch (default 10). Rates are broken
                     out at 5m/15m/30m/1h/3h/6h/24h — poll at least as often as
                     the shortest window you care about.
  --keep-hours <h>   Delete snapshots older than this after each poll. Off by
                     default; used by the scheduled workflow to bound repo size.
  --data-dir <path>  Where snapshots live (default ./data)
  --zones <path>     Custom zone definitions (see zones.example.json)
  --out <path>       Dashboard output path (default ./dashboard.html)
  --max-zoom <n>     Tile crawl depth, 7-14 (default 11). Higher = more precise
                     per-incident tracking, more requests.
  --max-requests <n> Safety cap on requests per poll (default 1500)
  --instance <guid>  Storm Center instance id (skips auto-discovery)
  --view <guid>      Storm Center view id
  --rediscover       Ignore cached instance/view ids and find them again
  --open             Open the dashboard after building it
  --json             Print machine-readable JSON instead of the text report
  --quiet            Suppress progress chatter
`;

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === 'help' || options.help) {
    process.stdout.write(USAGE);
    return;
  }

  const dataDir = resolve(options['data-dir'] ?? DEFAULT_DATA_DIR);
  const zones = loadZones(options.zones ? resolve(options.zones) : null);
  const outPath = resolve(options.out ?? join(process.cwd(), 'dashboard.html'));
  const log = options.quiet ? () => {} : (message) => process.stderr.write(`${message}\n`);

  switch (command) {
    case 'poll':
      await runPoll({ dataDir, options, log });
      break;

    case 'check': {
      await runPoll({ dataDir, options, log });
      printReport({ dataDir, zones, options });
      buildHtml({ dataDir, zones, outPath, options, log });
      break;
    }

    case 'report':
      printReport({ dataDir, zones, options });
      break;

    case 'html':
      buildHtml({ dataDir, zones, outPath, options, log });
      break;

    case 'watch':
      await runWatch({ dataDir, zones, outPath, options, log });
      break;

    case 'serve': {
      const interval = Number(options.interval ?? 10);
      if (!Number.isFinite(interval) || interval < 1) {
        throw new Error('--interval must be at least 1 minute');
      }
      const port = Number(options.port ?? 8080);
      const host = options.host === true ? '0.0.0.0' : (options.host ?? '127.0.0.1');
      if (host !== '127.0.0.1') {
        log(`Warning: binding to ${host} exposes the dashboard beyond this machine. It has no authentication.`);
      }
      await startServer({
        dataDir,
        zones,
        port,
        host,
        intervalMinutes: interval,
        log,
        poll: () => runPoll({ dataDir, options, log }),
      });
      if (options.open) openInBrowser(`http://localhost:${port}`);
      break;
    }

    case 'demo':
      await runDemo({ dataDir, log });
      printReport({ dataDir, zones, options });
      buildHtml({ dataDir, zones, outPath, options, log });
      break;

    case 'status':
      printStatus({ dataDir });
      break;

    default:
      process.stderr.write(`Unknown command: ${command}\n${USAGE}`);
      process.exitCode = 1;
  }
}

// --- commands --------------------------------------------------------------

async function runPoll({ dataDir, options, log }) {
  const config = loadConfig(dataDir);
  const useCached = !options.rediscover;

  const client = new KubraClient({
    instanceId: options.instance ?? (useCached ? config.instanceId : null) ?? null,
    viewId: options.view ?? (useCached ? config.viewId : null) ?? null,
    maxZoom: Number(options['max-zoom'] ?? 11),
    maxRequests: Number(options['max-requests'] ?? 1500),
    http: new HttpClient({ concurrency: 8 }),
    log,
  });

  log('Polling ComEd outage map...');
  const snapshot = await client.poll();
  const path = saveSnapshot(dataDir, snapshot);

  // Cache the ids so the next poll skips discovery entirely.
  if (client.instanceId && client.viewId) {
    saveConfig(dataDir, {
      ...config,
      instanceId: client.instanceId,
      viewId: client.viewId,
      lastPollAt: snapshot.capturedAt,
    });
  }

  const keepHours = Number(options['keep-hours']);
  if (Number.isFinite(keepHours) && keepHours > 0) {
    const removed = pruneSnapshots(dataDir, { keepHours });
    if (removed.length > 0) log(`Pruned ${removed.length} snapshots older than ${keepHours}h`);
  }

  log(`Saved ${path}`);
  return snapshot;
}

function printReport({ dataDir, zones, options }) {
  const snapshots = loadSnapshots(dataDir);
  const analysis = analyzeHistory(snapshots, zones);
  const since = options.since ? sinceAnchor(analysis.snapshots, options.since) : null;

  if (options.since && !since) {
    process.stderr.write(`warning: --since ${options.since} did not match an earlier snapshot\n`);
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(toJson(analysis, since), null, 2)}\n`);
    return;
  }
  process.stdout.write(`${renderTerminalReport(analysis, { since })}\n`);
}

function buildHtml({ dataDir, zones, outPath, options, log }) {
  const snapshots = loadSnapshots(dataDir);
  const analysis = analyzeHistory(snapshots, zones);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, renderHtml(analysis));
  log(`Dashboard: ${outPath}`);
  if (options.open) openInBrowser(outPath);
}

async function runWatch({ dataDir, zones, outPath, options, log }) {
  const minutes = Number(options.interval ?? 10);
  if (!Number.isFinite(minutes) || minutes < 1) {
    throw new Error('--interval must be at least 1 minute');
  }

  log(`Watching every ${minutes} min. Ctrl-C to stop.`);
  let stopped = false;
  process.on('SIGINT', () => {
    stopped = true;
    log('\nStopped.');
    process.exit(0);
  });

  // Build the dashboard once up front so --open has something to show.
  let opened = false;

  while (!stopped) {
    try {
      await runPoll({ dataDir, options, log });
      printReport({ dataDir, zones, options });
      buildHtml({ dataDir, zones, outPath, options: { ...options, open: options.open && !opened }, log });
      opened = true;
    } catch (error) {
      // A single failed poll should never end the watch — ComEd's map goes
      // down exactly when a storm makes it interesting.
      process.stderr.write(`Poll failed: ${error.message}\nRetrying next interval.\n`);
    }
    await sleep(minutes * 60 * 1000);
  }
}

function printStatus({ dataDir }) {
  const snapshots = loadSnapshots(dataDir);
  if (snapshots.length === 0) {
    process.stdout.write(`No snapshots in ${dataDir}\n`);
    return;
  }
  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  const spanHours =
    (Date.parse(last.capturedAt) - Date.parse(first.capturedAt)) / 3600000;
  process.stdout.write(
    `${snapshots.length} snapshots in ${dataDir}\n` +
      `  first: ${first.capturedAt}\n` +
      `  last:  ${last.capturedAt}\n` +
      `  span:  ${spanHours.toFixed(1)} hours\n` +
      `  now:   ${last.summary?.customersOut?.toLocaleString('en-US') ?? '?'} customers out\n`,
  );
}

/** Synthetic data so the analysis and dashboard can be exercised offline. */
async function runDemo({ dataDir, log }) {
  const { buildDemoSnapshots } = await import('./src/demo.js');
  const snapshots = buildDemoSnapshots();
  for (const snapshot of snapshots) saveSnapshot(dataDir, snapshot);
  log(`Wrote ${snapshots.length} synthetic snapshots to ${dataDir}`);
}

// --- helpers ---------------------------------------------------------------

function parseArgs(argv) {
  const options = {};
  let command = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        options[key] = true;
      } else {
        options[key] = next;
        i++;
      }
    } else if (!command) {
      command = arg;
    }
  }
  return { command, options };
}

const fixedSummary = (stats) =>
  stats && {
    from: stats.from,
    to: stats.to,
    minutes: stats.hours * 60,
    customersFixed: stats.restored,
    outagesFixed: stats.resolvedOutages,
    customersNew: stats.added,
    outagesNew: stats.newOutages,
    netCustomers: stats.net,
    netOutages: stats.netOutages,
    customersFixedPerHour: stats.restoredPerHour,
    outagesFixedPerHour: stats.resolvedOutagesPerHour,
    netCustomersPerHour: stats.netPerHour,
    coarserThanRequested: stats.coarserThanRequested ?? false,
  };

function toJson(analysis, since) {
  if (analysis.empty) return { empty: true };
  return {
    capturedAt: analysis.latest.capturedAt,
    customersOut: analysis.latest.customersOut,
    outages: analysis.latest.outages,
    sinceLastCheck: fixedSummary(analysis.lastDiff),
    sinceTrackingBegan: fixedSummary(analysis.sinceStart),
    since: fixedSummary(since),
    windows: Object.fromEntries(
      Object.entries(analysis.windows).map(([key, stats]) => [key, fixedSummary(stats)]),
    ),
    projection: analysis.projection,
    byZone: analysis.latest.byZone,
    zoneRates: analysis.windows['3h']?.byZone ?? analysis.lastDiff?.byZone ?? [],
    etr: analysis.latest.etr,
    causes: analysis.latest.causes,
    coverage: analysis.latest.coverage,
    series: analysis.series,
  };
}

function openInBrowser(path) {
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(opener, [path], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

main().catch((error) => {
  process.stderr.write(`\n${error.message}\n`);
  process.exitCode = 1;
});
