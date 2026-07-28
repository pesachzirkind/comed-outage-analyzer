#!/usr/bin/env node
// Capture the outage map's data endpoint by loading it once in a real browser.
//
//   npx playwright install chromium     # first time only
//   node scripts/capture-endpoint.mjs
//
// This is the approach the whole endpoint hunt should have started with. The
// map builds its request URLs at runtime, so no amount of reading static files
// reveals them; a browser executing the page reveals them immediately.
//
// It loads the page ONCE. No retries, no polling, no walking the site. That is
// deliberate: this project already caused ComEd to start returning 403 by
// treating a live service as a debugger, hammering it from CI for an hour. One
// page load is what a person visiting the map does. Anything more is a scrape.
//
// Do not run this to get around a block. If the site is refusing traffic, that
// is an answer — wait, or run it from an ordinary browser session instead.

import { writeFileSync } from 'node:fs';

const TARGET = process.argv[2] ?? 'https://www.comed.com/Outages/CheckOutageStatus/Pages/OutageMap.aspx';
const SETTLE_MS = 20_000;

// What a data request looks like, as opposed to an asset or a tracker.
const LOOKS_LIKE_DATA = /\.(json|xml|js)(\?|$)|\/api\/|\.svc\/|azure-api\.net|outage|metadata|interval|storm/i;
const NOISE = /googletagmanager|google-analytics|doubleclick|facebook|hotjar|adobedtm|newrelic|visualstudio|applicationinsights|\.(png|jpe?g|gif|svg|woff2?|css|ico)(\?|$)/i;

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  process.stderr.write(
    'playwright is not installed.\n' +
      '  npm i -D playwright && npx playwright install chromium\n',
  );
  process.exit(1);
}

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

const seen = [];
page.on('request', (request) => {
  const url = request.url();
  if (NOISE.test(url) || !LOOKS_LIKE_DATA.test(url)) return;
  seen.push({ method: request.method(), url, type: request.resourceType() });
});
page.on('response', async (response) => {
  const entry = seen.find((s) => s.url === response.url() && s.status === undefined);
  if (entry) entry.status = response.status();
});

process.stdout.write(`Loading ${TARGET} once…\n`);
await page.goto(TARGET, { waitUntil: 'networkidle', timeout: 60_000 }).catch((error) => {
  process.stderr.write(`  navigation: ${error.message}\n`);
});
// Give the map its own refresh cycle to fire; it polls on a timer.
await page.waitForTimeout(SETTLE_MS);
await browser.close();

if (seen.length === 0) {
  process.stdout.write('\nNo data-shaped requests observed. Either the page did not load, or\n');
  process.stdout.write('the filters need widening — rerun with the DevTools Network panel open.\n');
  process.exit(2);
}

process.stdout.write(`\nCandidate data endpoints (${seen.length}):\n\n`);
for (const { method, status, url, type } of seen) {
  process.stdout.write(`  ${method} ${status ?? '???'} [${type}] ${url}\n`);
}

writeFileSync('endpoint-capture.json', JSON.stringify(seen, null, 2));
process.stdout.write('\nWritten to endpoint-capture.json — paste the relevant URL into the issue\n');
process.stdout.write('or set it as a repository variable.\n');
