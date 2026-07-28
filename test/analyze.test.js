import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  aggregateWindow,
  analyzeHistory,
  diffSnapshots,
  prepareSnapshot,
  rankZones,
  sinceAnchor,
  totalCustomers,
  totalOutages,
  windowStats,
} from '../src/analyze.js';
import { buildDemoSnapshots } from '../src/demo.js';
import { DEFAULT_ZONES } from '../src/zones.js';
import { outage, snapshot } from './helpers.js';

const prep = (s) => prepareSnapshot(s, DEFAULT_ZONES);

test('a diff separates gross restoration from new damage', () => {
  const before = prep(
    snapshot('2026-07-28T00:00:00.000Z', [
      outage('A', 100), // will be fully restored
      outage('B', 50), // will shrink to 20
      outage('C', 10), // will grow to 40
    ]),
  );
  const after = prep(
    snapshot('2026-07-28T01:00:00.000Z', [
      outage('B', 20),
      outage('C', 40),
      outage('D', 25), // brand new
    ]),
  );

  const diff = diffSnapshots(before, after);

  assert.equal(diff.hours, 1);
  assert.equal(diff.restored, 130, '100 from A plus 30 shrinkage from B');
  assert.equal(diff.added, 55, '30 growth on C plus 25 from new outage D');
  assert.equal(diff.net, -75);
  assert.equal(diff.customersBefore - diff.customersAfter, 75, 'net matches the headline delta');

  assert.equal(diff.resolvedOutages, 1);
  assert.equal(diff.newOutages, 1);
  assert.equal(diff.netOutages, 0);
  assert.equal(diff.outagesBefore, 3);
  assert.equal(diff.outagesAfter, 3);

  assert.equal(diff.restoredPerHour, 130);
  assert.equal(diff.resolvedOutagesPerHour, 1);
});

test('gross restoration stays visible when new damage masks the net change', () => {
  const before = prep(snapshot('2026-07-28T00:00:00.000Z', [outage('A', 5000)]));
  const after = prep(snapshot('2026-07-28T01:00:00.000Z', [outage('B', 4900)]));

  const diff = diffSnapshots(before, after);
  assert.equal(diff.net, -100, 'the headline barely moves');
  assert.equal(diff.restored, 5000, 'but crews actually restored 5,000');
  assert.equal(diff.added, 4900);
});

test('half-hour gaps produce correctly scaled hourly rates', () => {
  const before = prep(snapshot('2026-07-28T00:00:00.000Z', [outage('A', 300)]));
  const after = prep(snapshot('2026-07-28T00:30:00.000Z', []));

  const diff = diffSnapshots(before, after);
  assert.equal(diff.hours, 0.5);
  assert.equal(diff.restored, 300);
  assert.equal(diff.restoredPerHour, 600, '300 in half an hour is 600/hr');
  assert.equal(diff.resolvedOutagesPerHour, 2);
});

test('a rolled-up window keeps churn that the endpoints hide', () => {
  const window = [
    prep(snapshot('2026-07-28T00:00:00.000Z', [outage('X', 100)])),
    prep(snapshot('2026-07-28T01:00:00.000Z', [outage('X', 100), outage('Y', 50)])),
    prep(snapshot('2026-07-28T02:00:00.000Z', [outage('X', 100)])),
  ];

  const stats = aggregateWindow(window);
  assert.equal(stats.net, 0, 'the endpoints look identical');
  assert.equal(stats.restored, 50, 'but Y really was restored inside the window');
  assert.equal(stats.added, 50);
  assert.equal(stats.resolvedOutages, 1);
  assert.equal(stats.newOutages, 1);
});

test('per-zone stats attribute restoration to the right area', () => {
  const lake = { lat: 42.33, lon: -87.98 };
  const will = { lat: 41.45, lon: -88.0 };

  const before = prep(
    snapshot('2026-07-28T00:00:00.000Z', [
      outage('L1', 800, lake),
      outage('L2', 200, lake),
      outage('W1', 1000, will),
    ]),
  );
  const after = prep(
    snapshot('2026-07-28T01:00:00.000Z', [outage('W1', 900, will)]),
  );

  const diff = diffSnapshots(before, after);
  const byZone = Object.fromEntries(diff.byZone.map((z) => [z.zone, z]));

  assert.equal(byZone['Lake County'].restored, 1000);
  assert.equal(byZone['Lake County'].resolvedOutages, 2);
  assert.equal(byZone['Lake County'].restoredShare, 1, 'Lake County fully restored');
  assert.equal(byZone['Lake County'].customersAfter, 0);

  assert.equal(byZone['Will County'].restored, 100);
  assert.equal(byZone['Will County'].resolvedOutages, 0);
  assert.equal(byZone['Will County'].restoredShare, 0.1);
});

test('zone ranking ignores trivially small zones', () => {
  const before = prep(
    snapshot('2026-07-28T00:00:00.000Z', [
      outage('tiny', 3, { lat: 42.33, lon: -87.98 }), // Lake County
      outage('big', 5000, { lat: 41.45, lon: -88.0 }), // Will County
    ]),
  );
  const after = prep(
    snapshot('2026-07-28T01:00:00.000Z', [outage('big', 4000, { lat: 41.45, lon: -88.0 })]),
  );

  const { fastest } = rankZones(diffSnapshots(before, after), { minCustomers: 50 });
  const names = fastest.map((z) => z.zone);
  assert.ok(!names.includes('Lake County'), '3 -> 0 is 100% but meaningless');
  assert.ok(names.includes('Will County'));
});

test('window stats flag a span coarser than the label', () => {
  // Polling every 20 minutes cannot answer a 5-minute question.
  const snapshots = [
    prep(snapshot('2026-07-28T00:00:00.000Z', [outage('A', 500)])),
    prep(snapshot('2026-07-28T00:20:00.000Z', [outage('A', 400)])),
  ];

  const fiveMinutes = windowStats(snapshots, 5 / 60);
  assert.ok(fiveMinutes.coarserThanRequested, 'a 20-minute gap cannot resolve 5 minutes');
  assert.equal(Math.round(fiveMinutes.hours * 60), 20, 'reports the span actually measured');

  const oneHour = windowStats(snapshots, 1);
  assert.equal(oneHour.coarserThanRequested, false);
});

test('windowStats needs two snapshots', () => {
  assert.equal(windowStats([prep(snapshot('2026-07-28T00:00:00.000Z', []))], 1), null);
});

test('sinceAnchor understands durations, counts, "first", and timestamps', () => {
  const snapshots = [0, 30, 60, 90].map((minutes) =>
    prep(
      snapshot(
        new Date(Date.parse('2026-07-28T00:00:00.000Z') + minutes * 60000).toISOString(),
        [outage('A', 1000 - minutes * 10)],
      ),
    ),
  );

  assert.equal(sinceAnchor(snapshots, 'first').anchor, '2026-07-28T00:00:00.000Z');
  assert.equal(sinceAnchor(snapshots, '1h').anchor, '2026-07-28T00:30:00.000Z');
  assert.equal(sinceAnchor(snapshots, '30m').anchor, '2026-07-28T01:00:00.000Z');
  assert.equal(sinceAnchor(snapshots, '2').anchor, '2026-07-28T00:30:00.000Z');
  assert.equal(
    sinceAnchor(snapshots, '2026-07-28T00:45:00.000Z').anchor,
    '2026-07-28T00:30:00.000Z',
    'snaps back to the most recent snapshot at or before the timestamp',
  );

  const fromStart = sinceAnchor(snapshots, 'first');
  assert.equal(fromStart.restored, 900, '1000 down to 100');
  assert.equal(fromStart.net, -900);
});

test('totals prefer ComEd reported figures over the crawled ones', () => {
  const partial = snapshot('2026-07-28T00:00:00.000Z', [outage('A', 100)], {
    customersOut: 9999,
    totalOutages: 42,
  });
  assert.equal(totalCustomers(partial), 9999, 'the summary is authoritative');
  assert.equal(totalOutages(partial), 42);

  const noSummary = { capturedAt: '2026-07-28T00:00:00.000Z', outages: [outage('A', 100)] };
  assert.equal(totalCustomers(noSummary), 100, 'falls back to the crawl');
  assert.equal(totalOutages(noSummary), 1);
});

test('analyzeHistory over a full synthetic storm stays internally consistent', () => {
  const snapshots = buildDemoSnapshots({ startAt: '2026-07-27T18:00:00.000Z', count: 19 });
  const analysis = analyzeHistory(snapshots, DEFAULT_ZONES);

  assert.equal(analysis.empty, false);
  assert.equal(analysis.series.length, 19);

  // The storm should have shrunk substantially over six hours.
  assert.ok(analysis.latest.customersOut < analysis.peak.customersOut / 2);

  // Gross bookkeeping must reconcile with the headline change.
  const start = analysis.series[0].customersOut;
  const end = analysis.series.at(-1).customersOut;
  const { restored, added } = analysis.sinceStart;
  assert.equal(added - restored, end - start, 'added minus restored equals the net change');

  // Every window that exists must report both customer and outage progress.
  for (const [key, stats] of Object.entries(analysis.windows)) {
    assert.ok(Number.isFinite(stats.restored), `${key} restored`);
    assert.ok(Number.isFinite(stats.resolvedOutages), `${key} resolvedOutages`);
    assert.ok(stats.restored >= 0 && stats.added >= 0, `${key} gross figures are non-negative`);
  }

  assert.equal(analysis.projection.status, 'improving');
  assert.ok(analysis.projection.hoursToClear > 0);
});

test('a single snapshot yields no rates but does not crash', () => {
  const analysis = analyzeHistory(
    [snapshot('2026-07-28T00:00:00.000Z', [outage('A', 100)])],
    DEFAULT_ZONES,
  );
  assert.equal(analysis.lastDiff, null);
  assert.deepEqual(analysis.windows, {});
  assert.equal(analysis.latest.customersOut, 100);
});

test('an empty history is reported as empty', () => {
  assert.equal(analyzeHistory([], DEFAULT_ZONES).empty, true);
});

test('pruning drops old snapshots but never the two needed for a diff', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { listSnapshotPaths, pruneSnapshots, saveSnapshot } = await import('../src/storage.js');

  const dir = mkdtempSync(join(tmpdir(), 'comed-prune-'));
  const now = Date.now();
  // Five snapshots spanning 10 hours, oldest first.
  for (const hoursAgo of [10, 8, 6, 1, 0]) {
    saveSnapshot(
      dir,
      snapshot(new Date(now - hoursAgo * 3600 * 1000).toISOString(), [outage('A', 100)]),
    );
  }

  const removed = pruneSnapshots(dir, { keepHours: 5 });
  assert.equal(removed.length, 3, 'the 10h, 8h and 6h snapshots go');
  assert.equal(listSnapshotPaths(dir).length, 2);

  // A no-op retention leaves everything alone.
  assert.deepEqual(pruneSnapshots(dir, { keepHours: 0 }), []);
  assert.equal(listSnapshotPaths(dir).length, 2);
});
