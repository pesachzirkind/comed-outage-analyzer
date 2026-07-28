// Client for the KUBRA Storm Center API that powers ComEd's outage map.
//
// The map at comed.com is an iframe around kubra.io. Nothing about the data
// layer is documented, and the paths rotate every refresh cycle, so the flow is:
//
//   1. scrape the map page for the instance + view GUIDs (cached once found)
//   2. GET /currentState        -> current data paths + deployment id
//   3. GET /configuration/{id}  -> the name of the cluster layer
//   4. GET summary-1/data.json  -> authoritative system-wide totals
//   5. crawl quadkey tiles      -> individual outages with lat/lon + customers
//
// Steps 2-5 must be repeated on every poll: `interval_generation_data` is a
// content-addressed path that changes each time ComEd regenerates the map.

import { HttpClient, mapWithConcurrency } from './http.js';
import { decodePoint, decodePolyline } from './polyline.js';
import {
  neighboringQuadkeys,
  quadkeyForPoint,
  quadkeysForBbox,
} from './quadkey.js';

const KUBRA_BASE = 'https://kubra.io';

// Pages that embed the Storm Center view, most specific first.
const DISCOVERY_PAGES = [
  'https://outagemap.comed.com/',
  'https://outagemap.comed.com/m.html',
  'https://www.comed.com/Outages/CheckOutageStatus/Pages/OutageMap.aspx',
  'https://secure.comed.com/FaceBook/Pages/outagemap.aspx',
];

const GUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const PAIR_RE = new RegExp(`stormcenters/(${GUID})/views/(${GUID})`);
const VIEW_RE = new RegExp(`views/(${GUID})`, 'g');
const ANY_GUID_RE = new RegExp(GUID, 'g');
const SCRIPT_SRC_RE = /<script[^>]+src=["']([^"']+)["']/gi;

// The map page is a shell — the GUIDs usually live in a bundled script rather
// than in the served HTML, so discovery follows script tags too. Bounded,
// because a Storm Center page references a lot of them.
const MAX_SCRIPTS_PER_PAGE = 12;

// Deliberately empty. A pair published in third-party write-ups as "ComEd's"
// (4fbb3ad3-…/8ed2824a-…) turned out to serve a Michigan utility: it answered
// currentState perfectly and returned outages around Detroit. Probing proves an
// instance is alive, not that it is the right one, so guessing IDs is off the
// table — territory is verified below instead.
const KNOWN_CANDIDATES = [];

// ComEd serves northern Illinois. Any Storm Center instance whose own service
// area falls outside this is not ComEd, however well it responds.
export const COMED_TERRITORY = { west: -90.5, south: 40.2, east: -87.0, north: 42.8 };

// ComEd is northern Illinois. Zoom 7 tiles are ~200km, so the whole territory
// is a handful of tiles — a cheap starting point for the crawl.
export const MIN_ZOOM = 7;
export const MAX_ZOOM = 14;

export class KubraClient {
  constructor({
    instanceId = null,
    viewId = null,
    http = new HttpClient(),
    maxZoom = 11,
    maxRequests = 1500,
    allowAnyTerritory = false,
    log = () => {},
  } = {}) {
    this.instanceId = instanceId;
    this.viewId = viewId;
    this.http = http;
    this.maxZoom = Math.min(maxZoom, MAX_ZOOM);
    this.maxRequests = maxRequests;
    this.allowAnyTerritory = allowAnyTerritory;
    this.discoveryTrace = [];
    this.log = log;
  }

  // --- discovery -----------------------------------------------------------

  /**
   * Find the instance + view GUIDs by scraping the public map pages. Returns
   * { instanceId, viewId }. Throws with instructions for the manual fallback,
   * because these IDs change only when ComEd redeploys — pasting them once
   * from DevTools is a perfectly good escape hatch.
   */
  async discoverIds() {
    if (this.instanceId && this.viewId) {
      return { instanceId: this.instanceId, viewId: this.viewId };
    }

    const candidateViews = (this.discoveryViews = new Set());
    const candidateGuids = (this.discoveryGuids = new Set());
    // Every fetch is recorded so a failure explains itself in CI logs rather
    // than just saying "not found".
    const trace = [];
    this.discoveryTrace = trace;

    const scan = (text, source) => {
      const direct = text.match(PAIR_RE);
      if (direct) {
        this.instanceId = direct[1];
        this.viewId = direct[2];
        this.log(`  discovery: found instance/view pair in ${source}`);
        return true;
      }
      for (const m of text.matchAll(VIEW_RE)) candidateViews.add(m[1]);
      for (const m of text.matchAll(ANY_GUID_RE)) candidateGuids.add(m[0]);
      return false;
    };

    for (const page of DISCOVERY_PAGES) {
      const html = await this._fetchForDiscovery(page, trace);
      if (!html) continue;
      if (scan(html, page)) return { instanceId: this.instanceId, viewId: this.viewId };

      for (const scriptUrl of extractScriptUrls(html, page).slice(0, MAX_SCRIPTS_PER_PAGE)) {
        const script = await this._fetchForDiscovery(scriptUrl, trace, '  ');
        if (!script) continue;
        if (scan(script, scriptUrl)) return { instanceId: this.instanceId, viewId: this.viewId };
      }
    }

    // No literal pair anywhere. Try the collected GUIDs against currentState —
    // the right combination is the only one that returns a usable data path.
    for (const viewId of candidateViews) {
      for (const instanceId of candidateGuids) {
        if (instanceId === viewId) continue;
        if (await this._probe(instanceId, viewId)) {
          this.instanceId = instanceId;
          this.viewId = viewId;
          this.log(`  discovery: probed pair ${instanceId} / ${viewId}`);
          return { instanceId, viewId };
        }
      }
    }

    // Still nothing scraped. Fall back to known-published pairs, each validated
    // the same way, so a stale entry can only fail — never mislead.
    for (const candidate of KNOWN_CANDIDATES) {
      if (await this._probe(candidate.instanceId, candidate.viewId)) {
        this.instanceId = candidate.instanceId;
        this.viewId = candidate.viewId;
        this.log(`  discovery: scraping found nothing; validated a known published pair`);
        return candidate;
      }
      trace.push(`known candidate ${candidate.instanceId}/${candidate.viewId} -> rejected by currentState`);
    }

    throw new Error(
      'Could not auto-discover the ComEd Storm Center IDs.\n\n' +
        `What was tried:\n` +
        trace.map((line) => `  ${line}`).join('\n') +
        `\n\nGUIDs seen (${candidateGuids.size}); none paired with a view that answered currentState:\n` +
        [...candidateGuids].slice(0, 40).map((g) => `  ${g}${candidateViews.has(g) ? '  (also seen as a view)' : ''}`).join('\n') +
        '\n\nFix it in one minute:\n' +
        '  1. Open https://outagemap.comed.com/ in a browser\n' +
        '  2. Open DevTools -> Network, filter for "currentState"\n' +
        '  3. The URL looks like:\n' +
        '     kubra.io/stormcenter/api/v1/stormcenters/<INSTANCE>/views/<VIEW>/currentState\n' +
        '  4. Re-run with:  --instance <INSTANCE> --view <VIEW>\n' +
        '     (the IDs are cached afterwards, so you only do this once)\n' +
        '     In the workflow, set the COMED_INSTANCE_ID / COMED_VIEW_ID repository variables.',
    );
  }

  /** Fetch a discovery URL, recording the outcome in `trace` either way. */
  async _fetchForDiscovery(url, trace, indent = '') {
    try {
      const res = await this.http.get(url, { accept: 'text/html,application/xhtml+xml,*/*' });
      trace.push(`${indent}${url} -> HTTP ${res.status}${res.ok ? ` (${res.body.length} bytes)` : ''}`);
      return res.ok ? res.body : null;
    } catch (error) {
      trace.push(`${indent}${url} -> ${error.message}`);
      return null;
    }
  }

  async _probe(instanceId, viewId) {
    try {
      const state = await this.http.getJson(this._stateUrl(instanceId, viewId));
      return Boolean(state?.data?.interval_generation_data);
    } catch {
      return false;
    }
  }

  _stateUrl(instanceId = this.instanceId, viewId = this.viewId) {
    return `${KUBRA_BASE}/stormcenter/api/v1/stormcenters/${instanceId}/views/${viewId}/currentState?preview=false`;
  }

  // --- session -------------------------------------------------------------

  /** Resolve the per-poll data paths and cluster layer name. */
  async openSession() {
    await this.discoverIds();

    const state = await this.http.getJson(this._stateUrl());
    if (!state?.data?.interval_generation_data) {
      throw new Error(
        'currentState did not contain a data path. The cached instance/view IDs ' +
          'may be stale — re-run with --rediscover.',
      );
    }

    const regionsKey = Object.keys(state.datastatic ?? {})[0] ?? null;
    const session = {
      dataPath: state.data.interval_generation_data,
      clusterDataPath: state.data.cluster_interval_generation_data,
      deploymentId: state.stormcenterDeploymentId,
      regionsKey,
      regions: regionsKey ? state.datastatic[regionsKey] : null,
      generatedAt: state.data?.generated ?? null,
    };

    const config = await this.http.getJson(
      `${KUBRA_BASE}/stormcenter/api/v1/stormcenters/${this.instanceId}/views/${this.viewId}` +
        `/configuration/${session.deploymentId}?preview=false`,
    );
    const layers = config?.config?.layers?.data?.interval_generation_data ?? [];
    const clusterLayer = layers.find((layer) => String(layer?.type ?? '').startsWith('CLUSTER_LAYER'));
    if (!clusterLayer) {
      throw new Error('No CLUSTER_LAYER found in the Storm Center configuration.');
    }
    session.layerName = clusterLayer.id;

    return session;
  }

  // --- data ----------------------------------------------------------------

  /** System-wide totals straight from ComEd. This is the authoritative count. */
  async fetchSummary(session) {
    const summary = await this.http.getJson(
      `${KUBRA_BASE}/${session.dataPath}/public/summary-1/data.json`,
    );
    const totals = summary?.summaryFileData?.totals?.[0] ?? {};

    return {
      totalOutages: numberOrNull(totals.total_outages),
      // Kubra wraps some totals in { val }: total_cust_a is an object, while
      // total_cust_s is a bare number. Unwrap before coercing, or Number()
      // quietly yields NaN and the headline count vanishes.
      customersOut: numberOrNull(unwrap(totals.total_custs_out ?? totals.total_cust_a)),
      customersServed: numberOrNull(unwrap(totals.total_cust_s ?? totals.total_customers)),
      generatedAt: summary?.summaryFileData?.date_generated ?? totals.date_generated ?? null,
      // Some deployments carry a per-area breakdown here. Keep it when present:
      // it is cheaper and more authoritative than our own geographic bucketing.
      areas: extractSummaryAreas(summary),
      raw: totals,
    };
  }

  /** Bounding box of ComEd's service territory, from the map's own polygons. */
  async fetchServiceAreaBbox(session) {
    if (!session.regions || !session.regionsKey) return null;
    const areas = await this.http.getJson(
      `${KUBRA_BASE}/${session.regions}/${session.regionsKey}/serviceareas.json`,
    );
    const encoded = areas?.file_data?.[0]?.geom?.a ?? [];
    const points = encoded.flatMap((geom) => decodePolyline(geom));
    if (points.length === 0) return null;

    const lats = points.map((p) => p[0]);
    const lons = points.map((p) => p[1]);
    return {
      west: Math.min(...lons),
      south: Math.min(...lats),
      east: Math.max(...lons),
      north: Math.max(...lats),
    };
  }

  _tileUrl(session, quadkey) {
    // Kubra sharded the tile paths by the reversed last three quadkey digits.
    const shard = quadkey.slice(-3).split('').reverse().join('');
    const path = session.clusterDataPath.replace('{qkh}', shard);
    return `${KUBRA_BASE}/${path}/public/${session.layerName}/${quadkey}.json`;
  }

  /**
   * Crawl the tile pyramid and return individual outages.
   *
   * Tiles hold clusters at low zoom; we descend into a cluster until it
   * resolves into real incidents or we hit `maxZoom`. Unresolved clusters are
   * still returned (with a synthetic id) so their customer counts are never
   * silently dropped from the totals.
   */
  async fetchOutages(session, bbox) {
    const outages = new Map();
    const seen = new Set();
    let truncated = false;

    let frontier = quadkeysForBbox(bbox, MIN_ZOOM).map((quadkey) => ({
      quadkey,
      zoom: MIN_ZOOM,
    }));

    while (frontier.length > 0) {
      if (this.http.requestCount >= this.maxRequests) {
        truncated = true;
        this.log(`  crawl: hit the ${this.maxRequests}-request cap, stopping early`);
        break;
      }

      const batch = frontier.filter(({ quadkey, zoom }) => {
        const key = `${zoom}:${quadkey}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      frontier = [];
      if (batch.length === 0) break;

      const responses = await mapWithConcurrency(batch, this.http.concurrency, async (tile) => {
        try {
          return { tile, data: await this.http.getJson(this._tileUrl(session, tile.quadkey)) };
        } catch (error) {
          this.log(`  crawl: ${tile.quadkey}@${tile.zoom} failed (${error.message})`);
          return { tile, data: null };
        }
      });

      for (const { tile, data } of responses) {
        for (const feature of data?.file_data ?? []) {
          const desc = feature?.desc;
          if (!desc) continue;

          const point = decodePoint(feature?.geom?.p?.[0] ?? '');
          if (!point) continue;

          if (desc.cluster && tile.zoom < this.maxZoom) {
            // Descend on the cluster's own location, not the tile's.
            frontier.push({
              quadkey: quadkeyForPoint(point[0], point[1], tile.zoom + 1),
              zoom: tile.zoom + 1,
            });
            continue;
          }

          const outage = toOutage(feature, desc, point, tile);
          outages.set(outage.id, outage);

          // A resolved incident means this neighbourhood is worth sweeping:
          // siblings routinely sit just across a tile boundary.
          if (!desc.cluster) {
            for (const neighbor of neighboringQuadkeys(tile.quadkey)) {
              frontier.push({ quadkey: neighbor, zoom: tile.zoom });
            }
          }
        }
      }
    }

    return { outages: [...outages.values()], truncated };
  }

  /**
   * Refuse to report another utility's outages as ComEd's.
   *
   * A Storm Center instance answering every request correctly is not evidence
   * it is the right instance — a published "ComEd" pair turned out to serve
   * Michigan, and without this check the dashboard showed Detroit outages under
   * a ComEd headline. Wrong data that looks right is worse than no data.
   */
  assertComEdTerritory(serviceArea) {
    if (this.allowAnyTerritory || !serviceArea) return;
    if (bboxesOverlap(serviceArea, COMED_TERRITORY)) return;

    throw new Error(
      'This Storm Center instance is not ComEd.\n' +
        `  Its service area spans lat ${serviceArea.south.toFixed(2)}..${serviceArea.north.toFixed(2)}, ` +
        `lon ${serviceArea.west.toFixed(2)}..${serviceArea.east.toFixed(2)},\n` +
        `  which does not overlap northern Illinois ` +
        `(lat ${COMED_TERRITORY.south}..${COMED_TERRITORY.north}, lon ${COMED_TERRITORY.west}..${COMED_TERRITORY.east}).\n` +
        `  Instance ${this.instanceId} / view ${this.viewId} belongs to a different utility.\n` +
        '  Re-check the IDs, or pass --allow-any-territory if you are deliberately\n' +
        '  pointing this at another Kubra utility.',
    );
  }

  /** One complete poll: session, summary, and the outage list. */
  async poll() {
    const session = await this.openSession();
    this.log(`  session: layer=${session.layerName}`);

    const summary = await this.fetchSummary(session);
    this.log(
      `  summary: ${fmt(summary.customersOut)} customers out across ${fmt(summary.totalOutages)} outages`,
    );

    const serviceArea = await this.fetchServiceAreaBbox(session);
    this.assertComEdTerritory(serviceArea);

    const bbox = serviceArea ?? COMED_FALLBACK_BBOX;
    const { outages, truncated } = await this.fetchOutages(session, bbox);

    const mappedCustomers = outages.reduce((sum, o) => sum + (o.customersAffected ?? 0), 0);
    this.log(
      `  crawl: ${outages.length} outages / ${fmt(mappedCustomers)} customers ` +
        `in ${this.http.requestCount} requests`,
    );

    return {
      capturedAt: new Date().toISOString(),
      instanceId: this.instanceId,
      viewId: this.viewId,
      summary,
      outages,
      coverage: {
        mappedCustomers,
        mappedOutages: outages.length,
        // How much of ComEd's own total we actually located on the map. Low
        // coverage means the crawl was capped or clusters stayed unresolved.
        customerCoverage:
          summary.customersOut > 0 ? mappedCustomers / summary.customersOut : null,
        truncated,
        requests: this.http.requestCount,
      },
    };
  }
}

// ComEd's northern-Illinois territory, used only if serviceareas.json is
// unavailable. Deliberately generous — an oversized box costs a few extra
// empty tiles, an undersized one loses outages.
export const COMED_FALLBACK_BBOX = {
  west: -90.0,
  south: 40.5,
  east: -87.4,
  north: 42.6,
};

/** Absolute URLs of every `<script src>` on a page, resolved against it. */
export function extractScriptUrls(html, pageUrl) {
  const urls = [];
  for (const match of html.matchAll(SCRIPT_SRC_RE)) {
    try {
      const resolved = new URL(match[1], pageUrl).toString();
      // Only same-origin-ish bundles are worth reading; skip analytics and tag
      // managers, which are large, numerous, and never carry the GUIDs.
      if (/googletagmanager|google-analytics|doubleclick|facebook|hotjar|adobedtm|newrelic/i.test(resolved)) {
        continue;
      }
      if (!urls.includes(resolved)) urls.push(resolved);
    } catch {
      // Malformed src attribute — nothing to resolve against.
    }
  }
  return urls;
}

function toOutage(feature, desc, point, tile) {
  const encoded = feature?.geom?.p?.[0] ?? '';
  return {
    // Real incidents have a stable id. Unresolved clusters do not, so we key
    // them on location + start time, which is stable enough to diff across
    // consecutive polls.
    id: desc.inc_id || `cluster:${encoded}-${desc.start_time ?? 'unknown'}`,
    isCluster: Boolean(desc.cluster),
    customersAffected: numberOrNull(desc.cust_a?.val) ?? 0,
    outageCount: numberOrNull(desc.n_out) ?? 1,
    startTime: normalizeTime(desc.start_time),
    etr: normalizeTime(desc.etr),
    etrConfidence: desc.etr_confidence ?? null,
    cause: desc.cause?.['EN-US'] ?? desc.cause?.EN ?? null,
    crewStatus: desc.crew_status ?? null,
    comments: desc.comments ?? null,
    lat: point[0],
    lon: point[1],
    zoom: tile.zoom,
  };
}

function extractSummaryAreas(summary) {
  const data = summary?.summaryFileData;
  if (!data) return [];
  // Deployments differ; accept the shapes seen in the wild and ignore the rest.
  const candidates = data.areas ?? data.area_summary ?? data.county ?? [];
  if (!Array.isArray(candidates)) return [];
  return candidates
    .map((area) => ({
      name: area?.name ?? area?.area_name ?? area?.id ?? null,
      customersOut: numberOrNull(area?.cust_a?.val ?? area?.cust_a ?? area?.total_custs_out),
      outages: numberOrNull(area?.n_out ?? area?.total_outages),
      customersServed: numberOrNull(area?.cust_s ?? area?.total_cust_s),
    }))
    .filter((area) => area.name && area.customersOut !== null);
}

function normalizeTime(value) {
  if (value === null || value === undefined || value === '') return null;
  // Kubra sends epoch milliseconds, epoch seconds, or ISO strings by field.
  if (typeof value === 'number') {
    const ms = value > 1e11 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Kubra reports some totals as { val: n } and others as bare numbers. */
function unwrap(value) {
  return value !== null && typeof value === 'object' && 'val' in value ? value.val : value;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Do two bounding boxes share any area? */
export function bboxesOverlap(a, b) {
  return a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south;
}

const fmt = (n) => (n === null || n === undefined ? '?' : n.toLocaleString('en-US'));
