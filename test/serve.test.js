import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { buildDemoSnapshots } from '../src/demo.js';
import { startServer } from '../src/serve.js';
import { saveSnapshot } from '../src/storage.js';
import { DEFAULT_ZONES } from '../src/zones.js';

const servers = [];
after(() => servers.forEach((server) => server.close()));

/** Boot a server on an ephemeral port against a throwaway data directory. */
async function boot({ poll } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'comed-serve-'));
  for (const snapshot of buildDemoSnapshots({ startAt: '2026-07-27T18:00:00.000Z', count: 4 })) {
    saveSnapshot(dataDir, snapshot);
  }

  const server = await startServer({
    dataDir,
    zones: DEFAULT_ZONES,
    port: 0, // let the OS pick
    host: '127.0.0.1',
    intervalMinutes: 60,
    poll: poll ?? (async () => ({ capturedAt: new Date().toISOString() })),
  });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

test('the server renders the live dashboard at the root', async () => {
  const base = await boot();
  const res = await fetch(`${base}/`);

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);

  const html = await res.text();
  assert.match(html, /ComEd Outage Analyzer/);
  assert.match(html, /Synthetic data/, 'demo snapshots must be labelled');
  assert.match(html, /\/api\.json/, 'served pages carry the auto-refresh poller');
});

test('/api.json exposes the state a polling tab needs', async () => {
  const base = await boot();
  const body = await (await fetch(`${base}/api.json`)).json();

  assert.ok(body.capturedAt, 'a timestamp the client can compare against');
  assert.equal(typeof body.customersOut, 'number');
  assert.equal(typeof body.outages, 'number');
  assert.equal(body.polling, false);
});

test('a failing poll keeps the last good dashboard online', async () => {
  const base = await boot({
    poll: async () => {
      throw new Error('ComEd unreachable');
    },
  });

  // The startup poll already failed by the time listen() resolved.
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200, 'the dashboard still serves');

  const body = await (await fetch(`${base}/api.json`)).json();
  assert.match(body.lastError, /ComEd unreachable/, 'and the failure is visible');
  assert.ok(body.capturedAt, 'still serving the last good snapshot');
});

test('unknown paths 404', async () => {
  const base = await boot();
  assert.equal((await fetch(`${base}/nope`)).status, 404);
});
