// Test-only helpers: a polyline encoder (the tool only ever needs to decode)
// and small builders for synthetic snapshots.

export function encodePolyline(coordinates, precision = 5) {
  const factor = 10 ** precision;
  let lastLat = 0;
  let lastLon = 0;
  let output = '';
  for (const [lat, lon] of coordinates) {
    const latE = Math.round(lat * factor);
    const lonE = Math.round(lon * factor);
    output += encodeValue(latE - lastLat) + encodeValue(lonE - lastLon);
    lastLat = latE;
    lastLon = lonE;
  }
  return output;
}

function encodeValue(value) {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let output = '';
  while (v >= 0x20) {
    output += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  return output + String.fromCharCode(v + 63);
}

/** A snapshot in the shape KubraClient.poll() produces. */
export function snapshot(capturedAt, outages, summary = {}) {
  const customersOut = outages.reduce((total, o) => total + o.customersAffected, 0);
  return {
    capturedAt,
    summary: {
      totalOutages: outages.length,
      customersOut,
      customersServed: 4_000_000,
      areas: [],
      ...summary,
    },
    outages,
    coverage: {
      mappedCustomers: customersOut,
      mappedOutages: outages.length,
      customerCoverage: 1,
      truncated: false,
      requests: 0,
    },
  };
}

export function outage(id, customersAffected, { lat = 41.85, lon = -88.09, ...rest } = {}) {
  return {
    id,
    isCluster: false,
    customersAffected,
    outageCount: 1,
    startTime: '2026-07-27T22:00:00.000Z',
    etr: '2026-07-28T04:00:00.000Z',
    etrConfidence: 'MEDIUM',
    cause: 'Wind Damage',
    crewStatus: 'Crew assigned',
    comments: null,
    lat,
    lon,
    zoom: 11,
    ...rest,
  };
}

/** Stand-in for HttpClient that serves a fixed URL -> JSON map. */
export class FakeHttp {
  constructor(routes = {}) {
    this.routes = routes;
    this.requestCount = 0;
    this.concurrency = 4;
    this.requested = [];
  }

  async getJson(url) {
    this.requestCount++;
    this.requested.push(url);
    return this.routes[url] ?? null;
  }

  async getText(url) {
    this.requestCount++;
    this.requested.push(url);
    return this.routes[url] ?? null;
  }

  /** Mirrors HttpClient.get: a miss is a 404, not a thrown error. */
  async get(url) {
    this.requestCount++;
    this.requested.push(url);
    const body = this.routes[url];
    if (body === undefined) return { ok: false, status: 404, body: '', url };
    return { ok: true, status: 200, body: typeof body === 'string' ? body : JSON.stringify(body), url };
  }
}
