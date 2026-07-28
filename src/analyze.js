// Turning snapshots into answers.
//
// The central distinction here is gross vs net. If 5,000 customers are restored
// while a new feeder drops 4,000, the headline total barely moves — but the
// crews restored 5,000, not 1,000. Netting them together makes a hard-working
// night look idle, so every rate is reported both ways:
//
//   restored  = customers on outages that vanished or shrank   (crew progress)
//   added     = customers on outages that appeared or grew     (new damage)
//   net       = added - restored                               (headline change)
//
// The same split applies to outage counts: outages closed vs outages opened.
//
// Gross numbers depend on outage ids staying stable between polls. Real
// incidents carry one; unresolved clusters get a synthetic id, so gross figures
// are approximate whenever cluster coverage is high. `clusterShare` reports it.

import { zoneForOutages } from './zones.js';

const HOUR_MS = 3600 * 1000;

// Rate windows, shortest first. The sub-hour ones only mean anything if you
// poll at least that often — each result carries the span actually measured so
// a "5 min" row built from a 20-minute gap says so rather than quietly lying.
export const WINDOW_DEFS = [
  { key: '5m', label: '5 min', minutes: 5 },
  { key: '15m', label: '15 min', minutes: 15 },
  { key: '30m', label: '30 min', minutes: 30 },
  { key: '1h', label: '1 hour', minutes: 60 },
  { key: '3h', label: '3 hours', minutes: 180 },
  { key: '6h', label: '6 hours', minutes: 360 },
  { key: '24h', label: '24 hours', minutes: 1440 },
];

/** Attach zones once, up front, so every downstream calculation agrees. */
export function prepareSnapshot(snapshot, zones, options) {
  return {
    ...snapshot,
    outages: zoneForOutages(snapshot.outages ?? [], zones, options),
  };
}

/**
 * Compare two snapshots. Both must already have zones attached.
 * Works for adjacent polls and for arbitrary "since X" comparisons alike.
 */
export function diffSnapshots(before, after) {
  const hours = (Date.parse(after.capturedAt) - Date.parse(before.capturedAt)) / HOUR_MS;
  const beforeById = indexById(before.outages);
  const afterById = indexById(after.outages);

  let restored = 0;
  let added = 0;
  const resolvedList = [];
  const newList = [];
  const zones = new Map();

  const bucket = (name) => {
    if (!zones.has(name)) {
      zones.set(name, {
        zone: name,
        customersBefore: 0,
        customersAfter: 0,
        outagesBefore: 0,
        outagesAfter: 0,
        restored: 0,
        added: 0,
        resolvedOutages: 0,
        newOutages: 0,
        restoreDurationsHours: [],
      });
    }
    return zones.get(name);
  };

  for (const outage of before.outages) {
    const zone = bucket(outage.zone);
    zone.customersBefore += outage.customersAffected;
    zone.outagesBefore += 1;
  }
  for (const outage of after.outages) {
    const zone = bucket(outage.zone);
    zone.customersAfter += outage.customersAffected;
    zone.outagesAfter += 1;
  }

  for (const [id, prior] of beforeById) {
    const current = afterById.get(id);
    const zone = bucket(prior.zone);

    if (!current) {
      restored += prior.customersAffected;
      zone.restored += prior.customersAffected;
      zone.resolvedOutages += 1;
      resolvedList.push(prior);
      const duration = restoreDurationHours(prior, after.capturedAt);
      if (duration !== null) zone.restoreDurationsHours.push(duration);
      continue;
    }

    const delta = current.customersAffected - prior.customersAffected;
    if (delta < 0) {
      restored += -delta;
      zone.restored += -delta;
    } else if (delta > 0) {
      added += delta;
      zone.added += delta;
    }
  }

  for (const [id, current] of afterById) {
    if (beforeById.has(id)) continue;
    added += current.customersAffected;
    const zone = bucket(current.zone);
    zone.added += current.customersAffected;
    zone.newOutages += 1;
    newList.push(current);
  }

  const byZone = [...zones.values()].map(finishZone(hours)).sort(byCustomersOut);

  return {
    from: before.capturedAt,
    to: after.capturedAt,
    hours,
    customersBefore: totalCustomers(before),
    customersAfter: totalCustomers(after),
    outagesBefore: totalOutages(before),
    outagesAfter: totalOutages(after),

    restored,
    added,
    net: added - restored,
    resolvedOutages: resolvedList.length,
    newOutages: newList.length,
    netOutages: newList.length - resolvedList.length,

    restoredPerHour: perHour(restored, hours),
    addedPerHour: perHour(added, hours),
    netPerHour: perHour(added - restored, hours),
    resolvedOutagesPerHour: perHour(resolvedList.length, hours),
    newOutagesPerHour: perHour(newList.length, hours),

    resolvedList,
    newList,
    byZone,
  };
}

/**
 * Roll consecutive diffs up over a time window. Summing pairwise diffs (rather
 * than just comparing the endpoints) keeps the churn that happened in between:
 * an outage that opened and closed inside the window still counts as one fixed.
 */
export function windowStats(snapshots, hours) {
  if (snapshots.length < 2) return null;
  const latest = snapshots[snapshots.length - 1];
  const cutoff = Date.parse(latest.capturedAt) - hours * HOUR_MS;

  const included = snapshots.filter((s) => Date.parse(s.capturedAt) >= cutoff);
  // Reach one snapshot further back so the window has a left edge to diff from.
  const startIndex = Math.max(0, snapshots.length - included.length - 1);
  const window = snapshots.slice(startIndex);
  if (window.length < 2) return null;

  const stats = aggregateWindow(window);
  stats.requestedHours = Number.isFinite(hours) ? hours : null;
  // True when the polling interval is coarser than the window asked for, so
  // the numbers describe a longer span than the label suggests.
  stats.coarserThanRequested =
    Number.isFinite(hours) && stats.hours > hours * 1.25;
  return stats;
}

/** Aggregate a run of snapshots into one set of window statistics. */
export function aggregateWindow(window) {
  const diffs = [];
  for (let i = 1; i < window.length; i++) {
    diffs.push(diffSnapshots(window[i - 1], window[i]));
  }
  return aggregateDiffs(diffs, window);
}

export function aggregateDiffs(diffs, window) {
  const first = window[0];
  const last = window[window.length - 1];
  const hours = (Date.parse(last.capturedAt) - Date.parse(first.capturedAt)) / HOUR_MS;

  const restored = sum(diffs.map((d) => d.restored));
  const added = sum(diffs.map((d) => d.added));
  const resolvedOutages = sum(diffs.map((d) => d.resolvedOutages));
  const newOutages = sum(diffs.map((d) => d.newOutages));

  const zones = new Map();
  for (const diff of diffs) {
    for (const zone of diff.byZone) {
      const acc = zones.get(zone.zone) ?? {
        zone: zone.zone,
        restored: 0,
        added: 0,
        resolvedOutages: 0,
        newOutages: 0,
        restoreDurationsHours: [],
        customersBefore: 0,
        customersAfter: 0,
        outagesBefore: 0,
        outagesAfter: 0,
      };
      acc.restored += zone.restored;
      acc.added += zone.added;
      acc.resolvedOutages += zone.resolvedOutages;
      acc.newOutages += zone.newOutages;
      acc.restoreDurationsHours.push(...zone.restoreDurationsHours);
      zones.set(zone.zone, acc);
    }
  }

  // Anchor the before/after levels to the window edges.
  const finish = finishZone(hours);
  for (const [name, acc] of zones) {
    acc.customersBefore = sumZoneCustomers(first.outages, name);
    acc.customersAfter = sumZoneCustomers(last.outages, name);
    acc.outagesBefore = countZoneOutages(first.outages, name);
    acc.outagesAfter = countZoneOutages(last.outages, name);
    zones.set(name, finish(acc));
  }

  return {
    from: first.capturedAt,
    to: last.capturedAt,
    hours,
    snapshots: window.length,
    customersBefore: totalCustomers(first),
    customersAfter: totalCustomers(last),
    outagesBefore: totalOutages(first),
    outagesAfter: totalOutages(last),

    restored,
    added,
    net: added - restored,
    resolvedOutages,
    newOutages,
    netOutages: newOutages - resolvedOutages,

    restoredPerHour: perHour(restored, hours),
    addedPerHour: perHour(added, hours),
    netPerHour: perHour(added - restored, hours),
    resolvedOutagesPerHour: perHour(resolvedOutages, hours),
    newOutagesPerHour: perHour(newOutages, hours),

    byZone: [...zones.values()].sort(byCustomersOut),
  };
}

/**
 * Compare the newest snapshot against an earlier one.
 * `anchor` accepts "first", an ISO timestamp, a count of snapshots back ("5"),
 * or a duration ("90m", "2h"). Returns a full diff plus what it anchored to.
 */
export function sinceAnchor(snapshots, anchor) {
  if (snapshots.length < 2) return null;
  const latest = snapshots[snapshots.length - 1];
  const index = resolveAnchorIndex(snapshots, anchor);
  if (index === null || index >= snapshots.length - 1) return null;

  const diff = diffSnapshots(snapshots[index], latest);
  // Roll up the intermediate diffs too — gross totals need the churn.
  const rolled = aggregateWindow(snapshots.slice(index));
  return { ...rolled, anchor: snapshots[index].capturedAt, anchorIndex: index, endpointDiff: diff };
}

function resolveAnchorIndex(snapshots, anchor) {
  if (anchor === undefined || anchor === null || anchor === 'last') {
    return snapshots.length - 2;
  }
  if (anchor === 'first') return 0;

  const text = String(anchor).trim();
  const duration = text.match(/^(\d+(?:\.\d+)?)\s*(m|min|h|hr|hours?|d)$/i);
  if (duration) {
    const value = Number(duration[1]);
    const unit = duration[2].toLowerCase();
    const hours = unit.startsWith('m') ? value / 60 : unit.startsWith('d') ? value * 24 : value;
    const cutoff = Date.parse(snapshots[snapshots.length - 1].capturedAt) - hours * HOUR_MS;
    for (let i = snapshots.length - 1; i >= 0; i--) {
      if (Date.parse(snapshots[i].capturedAt) <= cutoff) return i;
    }
    return 0;
  }

  if (/^\d+$/.test(text)) {
    return Math.max(0, snapshots.length - 1 - Number(text));
  }

  const timestamp = Date.parse(text);
  if (!Number.isNaN(timestamp)) {
    for (let i = snapshots.length - 1; i >= 0; i--) {
      if (Date.parse(snapshots[i].capturedAt) <= timestamp) return i;
    }
    return 0;
  }
  return null;
}

/** Everything the reports need, computed once. */
export function analyzeHistory(rawSnapshots, zones, options = {}) {
  const snapshots = rawSnapshots.map((s) => prepareSnapshot(s, zones, options));
  if (snapshots.length === 0) {
    return { empty: true, snapshots: [], series: [] };
  }

  const latest = snapshots[snapshots.length - 1];
  const series = snapshots.map((s) => ({
    t: s.capturedAt,
    customersOut: totalCustomers(s),
    outages: totalOutages(s),
    mappedCustomers: s.coverage?.mappedCustomers ?? null,
    coverage: s.coverage?.customerCoverage ?? null,
  }));

  const lastDiff = snapshots.length >= 2
    ? diffSnapshots(snapshots[snapshots.length - 2], latest)
    : null;

  const windows = {};
  for (const def of WINDOW_DEFS) {
    const stats = windowStats(snapshots, def.minutes / 60);
    if (stats) windows[def.key] = { ...stats, label: def.label };
  }
  const overall = windowStats(snapshots, Infinity);

  const peak = series.reduce(
    (best, point) => (point.customersOut > best.customersOut ? point : best),
    series[0],
  );

  return {
    empty: false,
    snapshots,
    series,
    latest: {
      capturedAt: latest.capturedAt,
      customersOut: totalCustomers(latest),
      outages: totalOutages(latest),
      // Synthetic data must never be mistaken for a real outage picture.
      demo: latest.demo === true,
      coverage: latest.coverage ?? null,
      clusterShare: clusterShare(latest.outages),
      byZone: currentByZone(latest.outages),
      causes: topCauses(latest.outages),
      crewStatus: countBy(latest.outages, (o) => o.crewStatus ?? 'unknown'),
      etr: etrStats(latest.outages, latest.capturedAt),
    },
    lastDiff,
    windows,
    overall,
    peak,
    sinceStart: sinceAnchor(snapshots, 'first'),
    projection: projectClearance(latest, windows, overall),
  };
}

/**
 * When does this end? Uses the net rate, because outages clear only when
 * restoration outpaces new damage. Prefers the 3h window (stable) and falls
 * back to shorter ones early in an event.
 */
export function projectClearance(latest, windows, overall) {
  const source = windows['3h'] ?? windows['1h'] ?? windows['30m'] ?? overall;
  if (!source) return { status: 'insufficient-data' };

  const customersOut = totalCustomers(latest);
  if (customersOut === 0) return { status: 'clear' };

  const netPerHour = source.netPerHour;
  if (netPerHour === null) return { status: 'insufficient-data' };
  if (netPerHour >= 0) {
    return {
      status: 'not-improving',
      basis: `${source.hours.toFixed(1)}h window`,
      netPerHour,
    };
  }

  const hoursToClear = customersOut / -netPerHour;
  return {
    status: 'improving',
    basis: `${source.hours.toFixed(1)}h window`,
    netPerHour,
    hoursToClear,
    clearsAt: new Date(Date.parse(latest.capturedAt) + hoursToClear * HOUR_MS).toISOString(),
  };
}

/**
 * Rank zones by how fast they are clearing. Zones below `minCustomers` are
 * excluded: a zone that went 3 -> 0 is 100% restored and would otherwise top
 * every list without meaning anything.
 */
export function rankZones(stats, { minCustomers = 50, limit = 10 } = {}) {
  if (!stats) return { fastest: [], slowest: [], worsening: [] };

  const eligible = stats.byZone.filter(
    (zone) => zone.customersBefore >= minCustomers || zone.customersAfter >= minCustomers,
  );

  const withRate = eligible.filter((zone) => zone.restoredShare !== null);
  const fastest = [...withRate].sort((a, b) => b.restoredShare - a.restoredShare).slice(0, limit);
  const slowest = [...withRate]
    .filter((zone) => zone.customersAfter > 0)
    .sort((a, b) => a.restoredShare - b.restoredShare)
    .slice(0, limit);
  const worsening = eligible.filter((zone) => zone.net > 0).sort((a, b) => b.net - a.net).slice(0, limit);

  return { fastest, slowest, worsening };
}

// --- helpers ---------------------------------------------------------------

/**
 * Prefer ComEd's own total over our crawl. The crawl can miss outages when the
 * request cap trips; the summary is always complete.
 */
export function totalCustomers(snapshot) {
  const reported = snapshot.summary?.customersOut;
  if (Number.isFinite(reported)) return reported;
  return (snapshot.outages ?? []).reduce((total, o) => total + (o.customersAffected ?? 0), 0);
}

export function totalOutages(snapshot) {
  const reported = snapshot.summary?.totalOutages;
  if (Number.isFinite(reported)) return reported;
  return (snapshot.outages ?? []).length;
}

const finishZone = (hours) => (zone) => ({
  ...zone,
  net: zone.customersAfter - zone.customersBefore,
  netOutages: zone.outagesAfter - zone.outagesBefore,
  restoredPerHour: perHour(zone.restored, hours),
  addedPerHour: perHour(zone.added, hours),
  resolvedOutagesPerHour: perHour(zone.resolvedOutages, hours),
  // The fair "who is faster" measure: a zone clearing 500 of 1,000 is doing
  // better than one clearing 900 of 50,000.
  restoredShare: zone.customersBefore > 0 ? zone.restored / zone.customersBefore : null,
  medianRestoreHours: median(zone.restoreDurationsHours),
});

const byCustomersOut = (a, b) => b.customersAfter - a.customersAfter;

function currentByZone(outages) {
  const zones = new Map();
  for (const outage of outages) {
    const acc = zones.get(outage.zone) ?? { zone: outage.zone, customersOut: 0, outages: 0 };
    acc.customersOut += outage.customersAffected;
    acc.outages += 1;
    zones.set(outage.zone, acc);
  }
  return [...zones.values()].sort((a, b) => b.customersOut - a.customersOut);
}

function etrStats(outages, now) {
  const nowMs = Date.parse(now);
  let withEtr = 0;
  let overdue = 0;
  const leadHours = [];
  for (const outage of outages) {
    if (!outage.etr) continue;
    withEtr += 1;
    const etrMs = Date.parse(outage.etr);
    if (Number.isNaN(etrMs)) continue;
    if (etrMs < nowMs) overdue += 1;
    else leadHours.push((etrMs - nowMs) / HOUR_MS);
  }
  return {
    withEtr,
    withoutEtr: outages.length - withEtr,
    overdue,
    medianLeadHours: median(leadHours),
  };
}

function topCauses(outages, limit = 6) {
  const counts = new Map();
  for (const outage of outages) {
    const cause = outage.cause ?? 'Unknown';
    const acc = counts.get(cause) ?? { cause, customersOut: 0, outages: 0 };
    acc.customersOut += outage.customersAffected;
    acc.outages += 1;
    counts.set(cause, acc);
  }
  return [...counts.values()].sort((a, b) => b.customersOut - a.customersOut).slice(0, limit);
}

function clusterShare(outages) {
  if (outages.length === 0) return 0;
  return outages.filter((o) => o.isCluster).length / outages.length;
}

function restoreDurationHours(outage, resolvedAt) {
  if (!outage.startTime) return null;
  const start = Date.parse(outage.startTime);
  const end = Date.parse(resolvedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return (end - start) / HOUR_MS;
}

const indexById = (outages) => new Map(outages.map((o) => [o.id, o]));

const sumZoneCustomers = (outages, zone) =>
  outages.filter((o) => o.zone === zone).reduce((total, o) => total + o.customersAffected, 0);

const countZoneOutages = (outages, zone) => outages.filter((o) => o.zone === zone).length;

const sum = (values) => values.reduce((total, v) => total + v, 0);

const perHour = (value, hours) => (hours > 0 ? value / hours : null);

export function median(values) {
  if (!values || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function countBy(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
}
