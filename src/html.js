// Self-contained HTML dashboard. No build step, no CDN — open the file and it
// works, including offline. Charts are inline SVG generated here; only hover
// behaviour needs client-side JS.
//
// Palette roles come from the data-viz reference palette and were run through
// its validator. Light-mode aqua sits below 3:1 on the light surface, so the
// relief rule applies: every bar carries a visible direct label and the full
// zone table is always present.

import { WINDOW_DEFS, rankZones } from './analyze.js';
import { dataQualityWarnings, formatDuration } from './report.js';

export function renderHtml(analysis) {
  if (analysis.empty) {
    return page('ComEd Outage Analyzer', '<p class="empty">No snapshots yet — run <code>node comed.js poll</code>.</p>');
  }

  const { latest, lastDiff, windows, overall, projection, series, peak } = analysis;
  const rankingSource = windows['3h'] ?? windows['1h'] ?? lastDiff;
  const ranked = rankZones(rankingSource, { limit: 8 });

  const body = [
    header(latest, lastDiff),
    statTiles(latest, windows, overall, projection),
    section(
      'How much has been fixed',
      'Gross restoration — outages that closed or shrank. Each row is a different look-back window.',
      ratesTable(analysis),
    ),
    section(
      'Customers out over time',
      peak ? `Peaked at ${fmt(peak.customersOut)} on ${formatLocal(peak.t)}.` : '',
      lineChart(series),
    ),
    section(
      'Restoration vs. new outages',
      'Gross customer movement per interval. Net change alone hides how much crews actually restored.',
      restoredVsAddedChart(analysis),
    ),
    section(
      'Where the outages are now',
      'Customers currently without power, by area.',
      zoneBarChart(latest.byZone.slice(0, 12)),
    ),
    rankingSource ? section(
      'Which areas are recovering fastest',
      `Share of each area's customers restored over the last ${rankingSource.hours.toFixed(1)} hours.`,
      zoneRankTable(ranked, rankingSource),
    ) : '',
    section('All areas', 'The complete picture, including the small ones.', zoneTable(latest, rankingSource)),
    causesAndEtr(latest),
    qualityNotes(analysis),
  ].join('\n');

  return page(`ComEd — ${fmt(latest.customersOut)} out`, body);
}

// --- layout ----------------------------------------------------------------

function header(latest, lastDiff) {
  const chip = (value, unit) =>
    `<span class="delta ${value <= 0 ? 'good' : 'bad'}">${
      value === 0 ? 'no change' : `${value < 0 ? '▼' : '▲'} ${fmt(Math.abs(value))}`
    }</span> <span class="muted">${esc(unit)}</span>`;

  const delta = lastDiff
    ? `<p class="head-deltas">${chip(lastDiff.net, 'customers')} &nbsp; ${chip(
        lastDiff.netOutages,
        'outages',
      )} <span class="muted">since last check (${Math.round(lastDiff.hours * 60)} min)</span></p>`
    : '';

  return `
    <header class="page-head">
      <h1>ComEd outage analyzer</h1>
      <p class="muted">Snapshot taken ${formatLocal(latest.capturedAt)} · <span id="age"></span></p>
      <div class="hero">
        <span class="hero-number">${fmt(latest.customersOut)}</span>
        <span class="hero-unit">customers out</span>
        <span class="hero-sep">·</span>
        <span class="hero-number small">${fmt(latest.outages)}</span>
        <span class="hero-unit">outages</span>
      </div>
      ${delta}
    </header>`;
}

/**
 * Fixed-since table across every window. This is the answer to "how many
 * customers and outages got fixed in the last 5/15/30 minutes and hour".
 */
function ratesTable(analysis) {
  const rows = WINDOW_DEFS.map((def) => ({ label: def.label, stats: analysis.windows[def.key] }))
    .concat([{ label: 'All tracked', stats: analysis.overall }])
    .filter((row) => row.stats);

  if (rows.length === 0) return '<p class="muted">Need at least two snapshots.</p>';

  const body = rows.map(({ label, stats }) => `
    <tr>
      <td>${esc(label)}${stats.coarserThanRequested ? ' <span class="flag" title="Measured span is longer than this label — poll more often for that resolution">*</span>' : ''}</td>
      <td class="num muted">${esc(formatDuration(stats.hours))}</td>
      <td class="num good">${fmt(stats.restored)}</td>
      <td class="num good">${fmt(stats.resolvedOutages)}</td>
      <td class="num bad">${fmt(stats.added)}</td>
      <td class="num bad">${fmt(stats.newOutages)}</td>
      <td class="num">${fmt(stats.restoredPerHour)}</td>
      <td class="num">${fmt(stats.resolvedOutagesPerHour)}</td>
      <td class="num ${stats.netPerHour < 0 ? 'good' : 'bad'}">${signed(stats.netPerHour)}</td>
    </tr>`).join('');

  const footnote = rows.some(({ stats }) => stats.coarserThanRequested)
    ? '<p class="muted">* The measured span is longer than the label — your polling interval is coarser than that window. Poll more often to get that resolution.</p>'
    : '';

  return `
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th rowspan="2">Window</th><th class="num" rowspan="2">Measured</th>
            <th class="num" colspan="2">Fixed</th>
            <th class="num" colspan="2">New</th>
            <th class="num" colspan="2">Per hour</th>
            <th class="num" rowspan="2">Net cust/hr</th>
          </tr>
          <tr>
            <th class="num sub">customers</th><th class="num sub">outages</th>
            <th class="num sub">customers</th><th class="num sub">outages</th>
            <th class="num sub">customers</th><th class="num sub">outages</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    ${footnote}`;
}

function statTiles(latest, windows, overall, projection) {
  const three = windows['3h'] ?? windows['1h'] ?? windows['30m'] ?? overall;
  const tiles = [
    {
      label: 'Customers fixed / hr',
      value: three ? fmt(three.restoredPerHour) : '—',
      note: three ? `over the last ${formatDuration(three.hours)}` : 'needs more history',
    },
    {
      label: 'Outages fixed / hr',
      value: three ? fmt(three.resolvedOutagesPerHour) : '—',
      note: three ? `${fmt(three.resolvedOutages)} closed in that window` : 'needs more history',
    },
    {
      label: 'New customers / hr',
      value: three ? fmt(three.addedPerHour) : '—',
      note: three ? `${fmt(three.newOutages)} new outages opened` : 'customers newly affected',
    },
    {
      label: 'Net change per hour',
      value: three ? signed(three.netPerHour) : '—',
      note: three && three.netPerHour < 0 ? 'shrinking' : 'growing',
      tone: three && three.netPerHour < 0 ? 'good' : 'bad',
    },
    {
      label: 'Projected all-clear',
      value:
        projection.status === 'improving'
          ? formatDuration(projection.hoursToClear)
          : projection.status === 'clear'
            ? 'clear'
            : '—',
      note:
        projection.status === 'improving'
          ? `at the current net rate`
          : projection.status === 'not-improving'
            ? 'not improving yet'
            : 'insufficient data',
    },
  ];

  return `<div class="tiles">${tiles
    .map(
      (tile) => `
      <div class="tile">
        <div class="tile-label">${esc(tile.label)}</div>
        <div class="tile-value ${tile.tone ?? ''}">${esc(tile.value)}</div>
        <div class="tile-note muted">${esc(tile.note)}</div>
      </div>`,
    )
    .join('')}</div>`;
}

const section = (title, note, content) => `
  <section>
    <h2>${esc(title)}</h2>
    ${note ? `<p class="muted section-note">${esc(note)}</p>` : ''}
    ${content}
  </section>`;

// --- charts ----------------------------------------------------------------

const CHART = { width: 900, height: 300, padLeft: 64, padRight: 20, padTop: 16, padBottom: 34 };

function lineChart(series) {
  if (series.length < 2) return '<p class="muted">Need at least two snapshots to draw a trend.</p>';

  const { width, height, padLeft, padRight, padTop, padBottom } = CHART;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const times = series.map((p) => Date.parse(p.t));
  const values = series.map((p) => p.customersOut);
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const vMax = niceCeil(Math.max(...values, 1));

  const x = (t) => padLeft + (tMax === tMin ? plotW / 2 : ((t - tMin) / (tMax - tMin)) * plotW);
  const y = (v) => padTop + plotH - (v / vMax) * plotH;

  const points = series.map((p, i) => ({ ...p, cx: x(times[i]), cy: y(p.customersOut) }));
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.cx.toFixed(1)},${p.cy.toFixed(1)}`).join(' ');
  const area =
    `M${points[0].cx.toFixed(1)},${(padTop + plotH).toFixed(1)} ` +
    points.map((p) => `L${p.cx.toFixed(1)},${p.cy.toFixed(1)}`).join(' ') +
    ` L${points.at(-1).cx.toFixed(1)},${(padTop + plotH).toFixed(1)} Z`;

  const gridlines = yTicks(vMax).map((v) => `
    <line class="grid" x1="${padLeft}" x2="${width - padRight}" y1="${y(v)}" y2="${y(v)}"/>
    <text class="axis" x="${padLeft - 10}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`).join('');

  const xLabels = pickTimeTicks(points).map((p) => `
    <text class="axis" x="${p.cx}" y="${height - 12}" text-anchor="middle">${esc(formatLocal(p.t, true))}</text>`).join('');

  const hoverTargets = points.map((p) => `
    <rect class="hit" x="${(p.cx - plotW / points.length / 2).toFixed(1)}" y="${padTop}"
          width="${Math.max(8, plotW / points.length).toFixed(1)}" height="${plotH}"
          data-x="${p.cx.toFixed(1)}" data-y="${p.cy.toFixed(1)}"
          data-label="${esc(formatLocal(p.t))}"
          data-value="${fmt(p.customersOut)} customers out"/>`).join('');

  return `
  <figure class="chart" data-chart="line">
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Customers without power over time">
      ${gridlines}
      <path class="area-fill" d="${area}"/>
      <path class="line-1" d="${path}"/>
      ${points.length <= 40 ? points.map((p) => `<circle class="dot-1" cx="${p.cx.toFixed(1)}" cy="${p.cy.toFixed(1)}" r="4"/>`).join('') : ''}
      <line class="crosshair" x1="0" y1="${padTop}" x2="0" y2="${padTop + plotH}" style="opacity:0"/>
      <circle class="focus-dot" r="6" style="opacity:0"/>
      ${xLabels}
      ${hoverTargets}
    </svg>
    <div class="tooltip" hidden></div>
  </figure>`;
}

function restoredVsAddedChart(analysis) {
  const { snapshots } = analysis;
  if (snapshots.length < 2) return '<p class="muted">Need at least two snapshots.</p>';

  // Recompute per-interval diffs so each bar is one polling interval.
  const intervals = [];
  for (let i = 1; i < snapshots.length; i++) {
    const before = snapshots[i - 1];
    const after = snapshots[i];
    const diff = analysis.lastDiff && i === snapshots.length - 1
      ? analysis.lastDiff
      : diffFor(before, after);
    intervals.push({ t: after.capturedAt, restored: diff.restored, added: diff.added });
  }

  const recent = intervals.slice(-24);
  const { width, height, padLeft, padRight, padTop, padBottom } = CHART;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const vMax = niceCeil(Math.max(1, ...recent.flatMap((d) => [d.restored, d.added])));
  const y = (v) => padTop + plotH - (v / vMax) * plotH;

  const groupW = plotW / recent.length;
  const barW = Math.max(3, groupW / 2 - 2); // 2px surface gap between adjacent bars

  const gridlines = yTicks(vMax).map((v) => `
    <line class="grid" x1="${padLeft}" x2="${width - padRight}" y1="${y(v)}" y2="${y(v)}"/>
    <text class="axis" x="${padLeft - 10}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`).join('');

  const bars = recent.map((d, i) => {
    const gx = padLeft + i * groupW;
    const baseline = padTop + plotH;
    return `
      ${roundedBar(gx + groupW / 2 - barW - 1, y(d.restored), barW, baseline - y(d.restored), 'bar-restored',
        `${formatLocal(d.t)}: ${fmt(d.restored)} customers restored`)}
      ${roundedBar(gx + groupW / 2 + 1, y(d.added), barW, baseline - y(d.added), 'bar-added',
        `${formatLocal(d.t)}: ${fmt(d.added)} customers newly out`)}`;
  }).join('');

  const xLabels = pickIndexTicks(recent).map(({ item, index }) => `
    <text class="axis" x="${padLeft + index * groupW + groupW / 2}" y="${height - 12}" text-anchor="middle">${esc(
      formatLocal(item.t, true),
    )}</text>`).join('');

  return `
  <div class="legend">
    <span class="legend-item"><span class="swatch swatch-restored"></span>Restored</span>
    <span class="legend-item"><span class="swatch swatch-added"></span>Newly out</span>
  </div>
  <figure class="chart" data-chart="bars">
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Customers restored versus newly out per interval">
      ${gridlines}
      ${bars}
      ${xLabels}
    </svg>
    <div class="tooltip" hidden></div>
  </figure>`;
}

function zoneBarChart(zones) {
  if (zones.length === 0) return '<p class="muted">No outages mapped.</p>';

  const rowH = 30;
  const width = 900;
  const labelW = 220;
  const valueW = 90;
  const barMax = width - labelW - valueW - 20;
  const height = zones.length * rowH + 10;
  const max = Math.max(...zones.map((z) => z.customersOut), 1);

  const rows = zones.map((zone, i) => {
    const y = i * rowH + 6;
    const barW = Math.max(2, (zone.customersOut / max) * barMax);
    return `
      <text class="row-label" x="0" y="${y + 14}">${esc(zone.zone)}</text>
      ${roundedBar(labelW, y, barW, 18, 'bar-primary',
        `${zone.zone}: ${fmt(zone.customersOut)} customers out across ${fmt(zone.outages)} outages`, true)}
      <text class="row-value" x="${labelW + barW + 8}" y="${y + 14}">${fmt(zone.customersOut)}</text>`;
  }).join('');

  return `
  <figure class="chart" data-chart="hbars">
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Customers out by area">${rows}</svg>
    <div class="tooltip" hidden></div>
  </figure>`;
}

function zoneRankTable(ranked, source) {
  const rows = (zones, kind) =>
    zones.map((zone) => `
      <tr>
        <td>${esc(zone.zone)}</td>
        <td class="num ${kind}">${pct(zone.restoredShare)}</td>
        <td class="num">${fmt(zone.restored)}</td>
        <td class="num">${fmt(zone.resolvedOutages)}</td>
        <td class="num">${fmt(zone.customersAfter)}</td>
        <td class="num">${fmt(zone.outagesAfter)}</td>
        <td class="num">${zone.medianRestoreHours !== null ? esc(formatDuration(zone.medianRestoreHours)) : '—'}</td>
      </tr>`).join('');

  const table = (title, zones, kind) =>
    zones.length === 0 ? '' : `
      <h3>${esc(title)}</h3>
      <div class="table-scroll">
      <table>
        <thead><tr><th>Area</th><th class="num">% fixed</th><th class="num">Customers fixed</th><th class="num">Outages fixed</th><th class="num">Customers still out</th><th class="num">Outages still out</th><th class="num">Median fix time</th></tr></thead>
        <tbody>${rows(zones, kind)}</tbody>
      </table>
      </div>`;

  const worsening = ranked.worsening.length === 0 ? '' : `
    <h3>Getting worse</h3>
    <table>
      <thead><tr><th>Area</th><th class="num">Net change</th><th class="num">Now out</th></tr></thead>
      <tbody>${ranked.worsening.map((zone) => `
        <tr><td>${esc(zone.zone)}</td><td class="num bad">${signed(zone.net)}</td><td class="num">${fmt(zone.customersAfter)}</td></tr>`).join('')}
      </tbody>
    </table>`;

  return `${table('Recovering fastest', ranked.fastest, 'good')}${table('Slowest to recover', ranked.slowest, 'bad')}${worsening}`;
}

function zoneTable(latest, source) {
  const byZone = new Map((source?.byZone ?? []).map((z) => [z.zone, z]));
  const rows = latest.byZone.map((zone) => {
    const stats = byZone.get(zone.zone);
    return `
      <tr>
        <td>${esc(zone.zone)}</td>
        <td class="num">${fmt(zone.customersOut)}</td>
        <td class="num">${fmt(zone.outages)}</td>
        <td class="num">${stats ? fmt(stats.restored) : '—'}</td>
        <td class="num">${stats ? fmt(stats.resolvedOutages) : '—'}</td>
        <td class="num">${stats && stats.restoredShare !== null ? pct(stats.restoredShare) : '—'}</td>
      </tr>`;
  }).join('');

  const windowLabel = source ? formatDuration(source.hours) : 'window';
  return `
    <div class="table-scroll">
      <table>
        <thead><tr><th>Area</th><th class="num">Customers out</th><th class="num">Outages</th><th class="num">Customers fixed (${esc(windowLabel)})</th><th class="num">Outages fixed</th><th class="num">% fixed</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function causesAndEtr(latest) {
  const causes = latest.causes.map((cause) => `
    <tr><td>${esc(cause.cause)}</td><td class="num">${fmt(cause.customersOut)}</td><td class="num">${fmt(cause.outages)}</td></tr>`).join('');

  const etr = latest.etr;
  return `
  <section>
    <h2>Causes and restoration estimates</h2>
    <div class="two-col">
      <div>
        <h3>Top causes</h3>
        <table><thead><tr><th>Cause</th><th class="num">Customers</th><th class="num">Outages</th></tr></thead><tbody>${causes}</tbody></table>
      </div>
      <div>
        <h3>ETR health</h3>
        <ul class="facts">
          <li><strong>${fmt(etr.withEtr)}</strong> outages have an estimated restoration time</li>
          <li><strong>${fmt(etr.withoutEtr)}</strong> have none yet</li>
          <li><strong class="${etr.overdue > 0 ? 'bad' : ''}">${fmt(etr.overdue)}</strong> are past their promised ETR</li>
          <li>Median ETR is <strong>${etr.medianLeadHours !== null ? esc(formatDuration(etr.medianLeadHours)) : '—'}</strong> away</li>
        </ul>
      </div>
    </div>
  </section>`;
}

function qualityNotes(analysis) {
  const warnings = dataQualityWarnings(analysis);
  if (warnings.length === 0) return '';
  return `
  <section class="notes">
    <h2>Data quality</h2>
    <ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
  </section>`;
}

// --- svg helpers -----------------------------------------------------------

/** Bar with 4px rounded data-end, square against the baseline. */
function roundedBar(x, y, width, height, className, tooltip, horizontal = false) {
  const h = Math.max(0, height);
  const w = Math.max(0, width);
  const r = Math.min(4, horizontal ? h / 2 : w / 2, horizontal ? w : h);
  if (w <= 0 || h <= 0) return '';

  const d = horizontal
    ? `M${x},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x} Z`
    : `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;

  return `<path class="${className}" d="${d}" data-tip="${esc(tooltip)}"/>`;
}

const yTicks = (max) => [0, max / 4, max / 2, (max * 3) / 4, max].map((v) => Math.round(v));

function niceCeil(value) {
  if (value <= 10) return 10;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / (magnitude / 2)) * (magnitude / 2);
}

function pickTimeTicks(points, target = 6) {
  const step = Math.max(1, Math.ceil(points.length / target));
  return points.filter((_, i) => i % step === 0 || i === points.length - 1);
}

function pickIndexTicks(items, target = 6) {
  const step = Math.max(1, Math.ceil(items.length / target));
  return items
    .map((item, index) => ({ item, index }))
    .filter(({ index }) => index % step === 0 || index === items.length - 1);
}

function diffFor(before, after) {
  // Local, dependency-free recompute for chart bars. Mirrors analyze.diffSnapshots
  // but only needs the two gross totals.
  const beforeById = new Map(before.outages.map((o) => [o.id, o]));
  const afterById = new Map(after.outages.map((o) => [o.id, o]));
  let restored = 0;
  let added = 0;
  for (const [id, prior] of beforeById) {
    const current = afterById.get(id);
    if (!current) {
      restored += prior.customersAffected;
      continue;
    }
    const delta = current.customersAffected - prior.customersAffected;
    if (delta < 0) restored += -delta;
    else added += delta;
  }
  for (const [id, current] of afterById) {
    if (!beforeById.has(id)) added += current.customersAffected;
  }
  return { restored, added };
}

// --- page shell ------------------------------------------------------------

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root {
  color-scheme: light dark;
  --surface-1: #fcfcfb;
  --surface-2: #f4f3ef;
  --text-primary: #0b0b0b;
  --text-secondary: #52514e;
  --grid: #e1e0d9;
  --border: rgba(11,11,11,0.10);
  --series-1: #2a78d6;
  --restored: #1baf7a;
  --added: #eb6834;
  --good: #0a7a52;
  --bad: #c23c25;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --surface-1: #1a1a19;
    --surface-2: #232322;
    --text-primary: #ffffff;
    --text-secondary: #c3c2b7;
    --grid: #2c2c2a;
    --border: rgba(255,255,255,0.10);
    --series-1: #3987e5;
    --restored: #199e70;
    --added: #d95926;
    --good: #4fc79b;
    --bad: #f08a72;
  }
}
:root[data-theme="dark"] {
  --surface-1: #1a1a19;
  --surface-2: #232322;
  --text-primary: #ffffff;
  --text-secondary: #c3c2b7;
  --grid: #2c2c2a;
  --border: rgba(255,255,255,0.10);
  --series-1: #3987e5;
  --restored: #199e70;
  --added: #d95926;
  --good: #4fc79b;
  --bad: #f08a72;
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 32px 24px 64px;
  background: var(--surface-1); color: var(--text-primary);
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  max-width: 1000px; margin-inline: auto;
}
h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: -0.01em; }
h2 { font-size: 17px; margin: 0 0 4px; letter-spacing: -0.01em; }
h3 { font-size: 14px; margin: 20px 0 8px; color: var(--text-secondary); font-weight: 600; }
section { margin-top: 40px; }
.section-note { margin: 0 0 14px; }
.muted { color: var(--text-secondary); font-size: 13px; }
.good { color: var(--good); }
.bad { color: var(--bad); }
.page-head { border-bottom: 1px solid var(--border); padding-bottom: 20px; }
.hero { display: flex; align-items: baseline; gap: 10px; margin: 14px 0 4px; }
.hero { flex-wrap: wrap; }
.hero-number { font-size: 46px; font-weight: 650; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
.hero-number.small { font-size: 30px; }
.hero-unit { font-size: 15px; color: var(--text-secondary); }
.hero-sep { color: var(--text-secondary); font-size: 24px; margin: 0 4px; }
.head-deltas { margin: 6px 0 0; }
.delta { font-weight: 600; }
.flag { color: var(--added); font-weight: 700; cursor: help; }
th.sub { font-weight: 500; font-size: 11px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-top: 24px; }
.tile { background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
.tile-label { font-size: 12px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.04em; }
.tile-value { font-size: 26px; font-weight: 620; margin: 6px 0 2px; font-variant-numeric: tabular-nums; }
.tile-note { font-size: 12px; }
.chart { margin: 0; position: relative; }
.chart svg { width: 100%; height: auto; display: block; overflow: visible; }
.grid { stroke: var(--grid); stroke-width: 1; }
.axis { fill: var(--text-secondary); font-size: 11px; font-variant-numeric: tabular-nums; }
.row-label { fill: var(--text-primary); font-size: 13px; }
.row-value { fill: var(--text-secondary); font-size: 12px; font-variant-numeric: tabular-nums; }
.line-1 { fill: none; stroke: var(--series-1); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.area-fill { fill: var(--series-1); opacity: 0.10; }
.dot-1 { fill: var(--series-1); stroke: var(--surface-1); stroke-width: 2; }
.bar-primary { fill: var(--series-1); }
.bar-restored { fill: var(--restored); }
.bar-added { fill: var(--added); }
.hit { fill: transparent; cursor: crosshair; }
.crosshair { stroke: var(--text-secondary); stroke-width: 1; stroke-dasharray: 3 3; }
.focus-dot { fill: var(--series-1); stroke: var(--surface-1); stroke-width: 2; }
.legend { display: flex; gap: 18px; margin-bottom: 10px; font-size: 13px; color: var(--text-secondary); }
.legend-item { display: inline-flex; align-items: center; gap: 6px; }
.swatch { width: 11px; height: 11px; border-radius: 3px; display: inline-block; }
.swatch-restored { background: var(--restored); }
.swatch-added { background: var(--added); }
.tooltip {
  position: absolute; pointer-events: none; z-index: 5;
  background: var(--surface-1); color: var(--text-primary);
  border: 1px solid var(--border); border-radius: 8px;
  padding: 7px 10px; font-size: 12px; line-height: 1.4;
  box-shadow: 0 4px 14px rgba(0,0,0,0.14); white-space: nowrap;
}
table { border-collapse: collapse; width: 100%; font-size: 13px; margin-bottom: 8px; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border); }
th { color: var(--text-secondary); font-weight: 600; font-size: 12px; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.table-scroll { overflow-x: auto; }
.two-col { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 28px; }
.facts { margin: 0; padding-left: 18px; }
.facts li { margin-bottom: 6px; }
.notes { border-top: 1px solid var(--border); padding-top: 20px; color: var(--text-secondary); font-size: 13px; }
.empty { color: var(--text-secondary); }
code { background: var(--surface-2); padding: 2px 5px; border-radius: 4px; font-size: 13px; }
</style>
</head>
<body>
${body}
<script>
(function () {
  // Line-chart crosshair + tooltip
  document.querySelectorAll('[data-chart="line"]').forEach(function (figure) {
    var tooltip = figure.querySelector('.tooltip');
    var crosshair = figure.querySelector('.crosshair');
    var focusDot = figure.querySelector('.focus-dot');
    figure.querySelectorAll('.hit').forEach(function (hit) {
      hit.addEventListener('mouseenter', function () {
        var x = hit.getAttribute('data-x');
        var y = hit.getAttribute('data-y');
        crosshair.setAttribute('x1', x); crosshair.setAttribute('x2', x);
        crosshair.style.opacity = 1;
        focusDot.setAttribute('cx', x); focusDot.setAttribute('cy', y);
        focusDot.style.opacity = 1;
        tooltip.innerHTML = '<strong>' + hit.getAttribute('data-value') + '</strong><br>' + hit.getAttribute('data-label');
        tooltip.hidden = false;
      });
      hit.addEventListener('mousemove', function (event) {
        place(figure, tooltip, event);
      });
    });
    figure.addEventListener('mouseleave', function () {
      tooltip.hidden = true;
      crosshair.style.opacity = 0;
      focusDot.style.opacity = 0;
    });
  });

  // Per-mark tooltips for bar charts
  document.querySelectorAll('[data-chart="bars"], [data-chart="hbars"]').forEach(function (figure) {
    var tooltip = figure.querySelector('.tooltip');
    figure.querySelectorAll('[data-tip]').forEach(function (mark) {
      mark.addEventListener('mouseenter', function () {
        tooltip.textContent = mark.getAttribute('data-tip');
        tooltip.hidden = false;
      });
      mark.addEventListener('mousemove', function (event) { place(figure, tooltip, event); });
    });
    figure.addEventListener('mouseleave', function () { tooltip.hidden = true; });
  });

  function place(figure, tooltip, event) {
    var box = figure.getBoundingClientRect();
    var x = event.clientX - box.left + 14;
    var y = event.clientY - box.top - 10;
    if (x + tooltip.offsetWidth > box.width) x = event.clientX - box.left - tooltip.offsetWidth - 14;
    tooltip.style.left = Math.max(0, x) + 'px';
    tooltip.style.top = Math.max(0, y) + 'px';
  }

  // "x minutes ago", so a stale tab is obvious at a glance
  var captured = document.querySelector('.page-head .muted');
  var ageEl = document.getElementById('age');
  if (ageEl) {
    var start = Date.now();
    setInterval(function () {
      var mins = Math.round((Date.now() - start) / 60000);
      ageEl.textContent = mins < 1 ? 'just refreshed' : 'page loaded ' + mins + ' min ago';
    }, 15000);
    ageEl.textContent = 'just refreshed';
  }
})();
</script>
</body>
</html>`;
}

// --- formatting ------------------------------------------------------------

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const fmt = (n) =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : Math.round(n).toLocaleString('en-US');

const signed = (n) => (n === null || !Number.isFinite(n) ? '—' : n > 0 ? `+${fmt(n)}` : fmt(n));
const pct = (n) => (n === null || !Number.isFinite(n) ? '—' : `${(n * 100).toFixed(0)}%`);

function formatLocal(iso, timeOnly = false) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return timeOnly
    ? date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
