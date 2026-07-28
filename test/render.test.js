import assert from 'node:assert/strict';
import { test } from 'node:test';

import { analyzeHistory } from '../src/analyze.js';
import { buildDemoSnapshots } from '../src/demo.js';
import { renderHtml } from '../src/html.js';
import { renderTerminalReport } from '../src/report.js';
import { DEFAULT_ZONES } from '../src/zones.js';
import { outage, snapshot } from './helpers.js';

const demoAnalysis = () =>
  analyzeHistory(
    buildDemoSnapshots({ startAt: '2026-07-27T18:00:00.000Z', count: 19 }),
    DEFAULT_ZONES,
  );

test('the terminal report covers customers and outages fixed at every window', () => {
  const text = renderTerminalReport(demoAnalysis());

  assert.match(text, /ComEd outage status/);
  assert.match(text, /Since last check/);
  assert.match(text, /Since tracking began/);
  assert.match(text, /Rates by window/);
  for (const label of ['5 min', '15 min', '30 min', '1 hour', '3 hours']) {
    assert.ok(text.includes(label), `missing the ${label} window`);
  }
  assert.match(text, /Recovering fastest/);
  assert.match(text, /Where the outages are now/);
  assert.match(text, /outages\/hr/);
});

test('the report tells you when there is nothing to report', () => {
  assert.match(renderTerminalReport({ empty: true }), /No snapshots yet/);
  assert.match(renderHtml({ empty: true }), /No snapshots yet/);
});

test('the report survives a history of exactly one snapshot', () => {
  const analysis = analyzeHistory(
    [snapshot('2026-07-28T00:00:00.000Z', [outage('A', 100)])],
    DEFAULT_ZONES,
  );
  const text = renderTerminalReport(analysis);
  assert.match(text, /100 customers out/);
  assert.match(text, /Not enough history/);
});

test('the dashboard is self-contained and renders the key sections', () => {
  const html = renderHtml(demoAnalysis());

  assert.match(html, /^<!doctype html>/);
  assert.match(html, /How much has been fixed/);
  assert.match(html, /Customers out over time/);
  assert.match(html, /Fixed vs\. newly out/);
  assert.match(html, /Which areas are recovering fastest/);
  assert.match(html, /Outages fixed/);

  // No external requests: the page must work offline, from a file:// URL.
  assert.ok(!/<script[^>]+src=/i.test(html), 'no external scripts');
  assert.ok(!/<link[^>]+stylesheet/i.test(html), 'no external stylesheets');
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/i.test(html.replace(/comed\.com/gi, '')), 'no remote URLs');

  // Both themes are declared, not just an automatic flip.
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /\[data-theme="dark"\]/);

  // A legend exists for the two-series chart, so identity is never colour-alone.
  assert.match(html, /class="legend"/);
  assert.match(html, /Fixed<\/span>/);
  assert.match(html, /Newly out<\/span>/);
});

test('zone names are HTML-escaped', () => {
  const zones = [{ name: '<script>alert(1)</script>', lat: 41.85, lon: -88.09 }];
  const analysis = analyzeHistory(
    [
      snapshot('2026-07-28T00:00:00.000Z', [outage('A', 500)]),
      snapshot('2026-07-28T00:30:00.000Z', [outage('A', 200)]),
    ],
    zones,
  );
  const html = renderHtml(analysis);
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw markup must not reach the page');
  assert.match(html, /&lt;script&gt;/);
});
