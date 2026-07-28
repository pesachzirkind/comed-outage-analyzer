// Terminal report — the "what changed since I last looked" view.

import { WINDOW_DEFS, rankZones } from './analyze.js';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `[${code}m${text}[0m` : text);
const bold = (t) => paint('1', t);
const dim = (t) => paint('2', t);
const green = (t) => paint('32', t);
const red = (t) => paint('31', t);
const yellow = (t) => paint('33', t);

const SPARK = '▁▂▃▄▅▆▇█';

export function renderTerminalReport(analysis, { zoneLimit = 8, since = null } = {}) {
  if (analysis.empty) {
    return 'No snapshots yet. Run `node comed.js poll` first.';
  }

  const out = [];
  const { latest, lastDiff, windows, overall, peak, projection, series, sinceStart } = analysis;

  out.push('');
  out.push(bold('  ComEd outage status'));
  out.push(dim(`  as of ${formatLocal(latest.capturedAt)}`));
  out.push('');

  // --- headline ---
  out.push(
    `  ${bold(fmt(latest.customersOut))} customers out   ${dim('·')}   ` +
      `${bold(fmt(latest.outages))} outages`,
  );
  if (lastDiff) {
    out.push(
      `  ${changeLabel(lastDiff.net)} customers ${dim('·')} ` +
        `${changeLabel(lastDiff.netOutages)} outages ` +
        dim(`(vs ${Math.round(lastDiff.hours * 60)} min ago)`),
    );
  }
  out.push('');

  // --- trend sparkline ---
  if (series.length >= 3) {
    const values = series.map((p) => p.customersOut);
    out.push(`  Trend   ${sparkline(values)}   ${dim(`${fmt(values[0])} → ${fmt(values.at(-1))}`)}`);
    out.push(dim(`          peak ${fmt(peak.customersOut)} at ${formatLocal(peak.t, true)}`));
    out.push('');
  }

  // --- fixed since last check ---
  if (lastDiff) {
    out.push(bold('  Since last check') + dim(`  (${Math.round(lastDiff.hours * 60)} min)`));
    out.push(fixedLines(lastDiff));
    out.push('');
  }

  // --- fixed since an explicit anchor / since collection began ---
  const anchored = since ?? sinceStart;
  if (anchored && (!lastDiff || anchored.hours > lastDiff.hours * 1.5)) {
    const label = since ? 'Since your chosen point' : 'Since tracking began';
    out.push(bold(`  ${label}`) + dim(`  (${formatDuration(anchored.hours)}, from ${formatLocal(anchored.from, true)})`));
    out.push(fixedLines(anchored));
    out.push('');
  }

  // --- rolling rates ---
  const windowRows = WINDOW_DEFS.map((def) => [def.label, windows[def.key]])
    .concat([['all data', overall]])
    .filter(([, stats]) => stats);

  if (windowRows.length > 0) {
    out.push(bold('  Rates by window'));
    out.push(
      dim('    window      measured    customers/hr   outages/hr    net cust/hr'),
    );
    for (const [label, stats] of windowRows) {
      const measured = formatDuration(stats.hours);
      const flag = stats.coarserThanRequested ? yellow('*') : ' ';
      out.push(
        `    ${pad(label, 10)}${flag} ${padStart(measured, 9)}` +
          `  ${padStart(rate(stats.restoredPerHour), 14)}` +
          `  ${padStart(rate(stats.resolvedOutagesPerHour), 11)}` +
          `  ${padStart(signedRate(stats.netPerHour), 13)}`,
      );
    }
    if (windowRows.some(([, stats]) => stats.coarserThanRequested)) {
      out.push(
        dim(`    ${yellow('*')} measured span is longer than the window label — poll more often for that resolution`),
      );
    }
    out.push('');
  }

  // --- projection ---
  out.push(bold('  Outlook'));
  if (projection.status === 'clear') {
    out.push(`    ${green('All clear')} — no customers out.`);
  } else if (projection.status === 'improving') {
    out.push(
      `    Clearing at ${green(`${rate(-projection.netPerHour)}/hr`)} net. ` +
        `At this pace: ${bold(formatDuration(projection.hoursToClear))} ` +
        dim(`(~${formatLocal(projection.clearsAt)})`),
    );
    out.push(dim(`    Based on the ${projection.basis}. Storms rarely clear linearly — treat as a floor.`));
  } else if (projection.status === 'not-improving') {
    out.push(
      `    ${red('Not improving')} — outages are growing at ` +
        `${rate(projection.netPerHour)}/hr net over the ${projection.basis}.`,
    );
  } else {
    out.push(dim('    Not enough history yet. Poll a few more times.'));
  }
  out.push('');

  // --- zones ---
  const rankingSource = windows['3h'] ?? windows['1h'] ?? windows['30m'] ?? lastDiff;
  if (rankingSource) {
    const { fastest, slowest, worsening } = rankZones(rankingSource, { limit: zoneLimit });
    const basis = formatDuration(rankingSource.hours);

    if (fastest.length > 0) {
      out.push(bold('  Recovering fastest') + dim(`  (share of customers restored, last ${basis})`));
      for (const zone of fastest) {
        out.push(
          `    ${pad(zone.zone, 24)} ${padStart(pct(zone.restoredShare), 7)}` +
            dim(
              `  ${padStart(fmt(zone.restored), 7)} customers, ` +
                `${padStart(fmt(zone.resolvedOutages), 3)} ${noun(zone.resolvedOutages, 'outage')} fixed` +
                `  ·  ${fmt(zone.customersAfter)} still out`,
            ),
        );
      }
      out.push('');
    }

    if (slowest.length > 0) {
      out.push(bold('  Slowest / still stuck') + dim(`  (last ${basis})`));
      for (const zone of slowest) {
        out.push(
          `    ${pad(zone.zone, 24)} ${padStart(pct(zone.restoredShare), 7)}` +
            dim(
              `  ${fmt(zone.customersAfter)} still out in ` +
                `${fmt(zone.outagesAfter)} ${noun(zone.outagesAfter, 'outage')}`,
            ) +
            (zone.medianRestoreHours !== null
              ? dim(`  ·  median fix ${formatDuration(zone.medianRestoreHours)}`)
              : ''),
        );
      }
      out.push('');
    }

    if (worsening.length > 0) {
      out.push(bold('  Getting worse'));
      for (const zone of worsening) {
        out.push(
          `    ${pad(zone.zone, 24)} ${padStart(signed(zone.net), 8)} customers` +
            dim(`  ·  ${signed(zone.netOutages)} outages  ·  now ${fmt(zone.customersAfter)} out`),
        );
      }
      out.push('');
    }
  }

  // --- current distribution ---
  if (latest.byZone.length > 0) {
    out.push(bold('  Where the outages are now'));
    const max = latest.byZone[0].customersOut || 1;
    for (const zone of latest.byZone.slice(0, zoneLimit)) {
      const barWidth = Math.max(1, Math.round((zone.customersOut / max) * 22));
      out.push(
        `    ${pad(zone.zone, 24)} ${padStart(fmt(zone.customersOut), 8)} ` +
          dim(`/ ${padStart(fmt(zone.outages), 3)} out  `) +
          dim('█'.repeat(barWidth)),
      );
    }
    out.push('');
  }

  // --- causes and ETR ---
  if (latest.causes.length > 0) {
    out.push(bold('  Top causes'));
    for (const cause of latest.causes.slice(0, 4)) {
      out.push(
        `    ${pad(cause.cause, 30)} ${padStart(fmt(cause.customersOut), 8)} customers` +
          dim(`  ${padStart(fmt(cause.outages), 4)} outages`),
      );
    }
    out.push('');
  }

  const etr = latest.etr;
  out.push(bold('  Estimated restoration times'));
  out.push(
    `    ${fmt(etr.withEtr)} ${noun(etr.withEtr, 'outage')} have an ETR, ${fmt(etr.withoutEtr)} do not` +
      (etr.medianLeadHours !== null
        ? dim(`  ·  median ETR is ${formatDuration(etr.medianLeadHours)} out`)
        : ''),
  );
  if (etr.overdue > 0) {
    out.push(
      `    ${yellow(
        `${fmt(etr.overdue)} ${noun(etr.overdue, 'outage')} ${noun(etr.overdue, 'is', 'are')} past ` +
          `${noun(etr.overdue, 'its', 'their')} promised ETR`,
      )}`,
    );
  }
  out.push('');

  // --- data quality ---
  const warnings = dataQualityWarnings(analysis);
  if (warnings.length > 0) {
    out.push(dim('  Data quality'));
    for (const warning of warnings) out.push(dim(`    · ${warning}`));
    out.push('');
  }

  return out.join('\n');
}

/** The core "x customers / x outages fixed" block, shared by every window. */
function fixedLines(stats) {
  const lines = [
    `    ${green('fixed')}    ${padStart(fmt(stats.restored), 9)} customers` +
      `  ${padStart(fmt(stats.resolvedOutages), 5)} outages` +
      dim(`   (${rate(stats.restoredPerHour)} cust/hr, ${rate(stats.resolvedOutagesPerHour)} outages/hr)`),
    `    ${red('new')}      ${padStart(fmt(stats.added), 9)} customers` +
      `  ${padStart(fmt(stats.newOutages), 5)} outages` +
      dim(`   (${rate(stats.addedPerHour)} cust/hr, ${rate(stats.newOutagesPerHour)} outages/hr)`),
    `    net      ${padStart(signed(stats.net), 9)} customers` +
      `  ${padStart(signed(stats.netOutages), 5)} outages`,
  ];
  return lines.join('\n');
}

export function dataQualityWarnings(analysis) {
  const warnings = [];
  const { latest } = analysis;
  const coverage = latest.coverage;

  if (coverage?.truncated) {
    warnings.push(
      'The tile crawl hit its request cap, so the map is partial. ' +
        'Zone numbers understate reality; raise --max-requests.',
    );
  }
  if (
    coverage?.customerCoverage !== null &&
    coverage?.customerCoverage !== undefined &&
    coverage.customerCoverage < 0.9
  ) {
    warnings.push(
      `Located ${pct(coverage.customerCoverage)} of ComEd's reported customers on the map. ` +
        'Headline totals come from ComEd and are exact; the "fixed" counts and zone split ' +
        'cover only what was mapped.',
    );
  }
  if (latest.clusterShare > 0.3) {
    warnings.push(
      `${pct(latest.clusterShare)} of map features are still clusters, not individual ` +
        'incidents. Fixed/new counts are approximate; try --max-zoom 13.',
    );
  }
  if (analysis.series.length < 3) {
    warnings.push('Fewer than 3 snapshots — rates are noisy until you have ~30 minutes of history.');
  }
  return warnings;
}

// --- formatting ------------------------------------------------------------

export function sparkline(values) {
  if (values.length === 0) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  return values
    .map((value) => {
      if (span === 0) return SPARK[Math.floor(SPARK.length / 2)];
      return SPARK[Math.round(((value - min) / span) * (SPARK.length - 1))];
    })
    .join('');
}

export function formatDuration(hours) {
  if (hours === null || !Number.isFinite(hours)) return 'unknown';
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) {
    const whole = Math.floor(hours);
    const minutes = Math.round((hours - whole) * 60);
    return minutes > 0 ? `${whole}h ${minutes}m` : `${whole}h`;
  }
  return `${(hours / 24).toFixed(1)} days`;
}

const fmt = (n) =>
  n === null || n === undefined || !Number.isFinite(n) ? '?' : Math.round(n).toLocaleString('en-US');

const signed = (n) => (n === null || !Number.isFinite(n) ? '?' : n > 0 ? `+${fmt(n)}` : fmt(n));
const rate = (n) => (n === null || !Number.isFinite(n) ? '?' : fmt(Math.abs(n)));
const signedRate = (n) => (n === null || !Number.isFinite(n) ? '?' : signed(Math.round(n)));
const pct = (n) => (n === null || !Number.isFinite(n) ? '?' : `${(n * 100).toFixed(0)}%`);

function changeLabel(net) {
  if (net === 0) return dim('no change');
  if (net < 0) return green(`▼ ${fmt(-net)}`);
  return red(`▲ ${fmt(net)}`);
}

const noun = (count, singular, plural = `${singular}s`) => (count === 1 ? singular : plural);

const pad = (text, width) => String(text).padEnd(width);
const padStart = (text, width) => String(text).padStart(width);

function formatLocal(iso, timeOnly = false) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return timeOnly
    ? date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
}
