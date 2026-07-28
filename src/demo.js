// Synthetic storm data. Two purposes: let someone see the whole tool work
// before a real storm, and give the tests a realistic multi-hour fixture.
//
// The scenario is a wind event that hits the northwest suburbs hardest, with
// deliberately uneven recovery — Lake County crews move fast, Will County
// stalls, and a second squall opens new outages two hours in. That unevenness
// is the thing the analyzer is supposed to surface.

const HOUR_MS = 3600 * 1000;

// Seeded PRNG so demo output (and the tests built on it) is reproducible.
function mulberry32(seed) {
  return function random() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AREAS = [
  { name: 'Northwest Cook', lat: 42.05, lon: -88.0, outages: 26, scale: 900, recovery: 0.22 },
  { name: 'Lake County', lat: 42.33, lon: -87.98, outages: 18, scale: 700, recovery: 0.34 },
  { name: 'McHenry County', lat: 42.32, lon: -88.45, outages: 14, scale: 500, recovery: 0.28 },
  { name: 'DuPage County', lat: 41.85, lon: -88.09, outages: 16, scale: 620, recovery: 0.19 },
  { name: 'Will County', lat: 41.45, lon: -88.0, outages: 12, scale: 540, recovery: 0.07 },
  { name: 'Kane County', lat: 41.94, lon: -88.43, outages: 10, scale: 430, recovery: 0.16 },
  { name: 'Chicago - North Side', lat: 41.97, lon: -87.68, outages: 9, scale: 380, recovery: 0.26 },
  { name: 'Chicago - South Side', lat: 41.74, lon: -87.62, outages: 7, scale: 300, recovery: 0.12 },
];

const CAUSES = [
  'Wind Damage',
  'Tree/Vegetation Contact',
  'Equipment Failure',
  'Lightning',
  'Under Investigation',
];

const CREW_STATUS = ['Crew assigned', 'Crew en route', 'Crew on site', 'Assessing damage'];

/**
 * @param {object} options
 * @param {number} options.intervalMinutes  spacing between snapshots
 * @param {number} options.count            how many snapshots
 * @param {number} options.seed             PRNG seed
 * @param {string} options.startAt          ISO time of the first snapshot
 */
export function buildDemoSnapshots({
  intervalMinutes = 20,
  count = 19,
  seed = 20260728,
  startAt = null,
} = {}) {
  const random = mulberry32(seed);
  const start = startAt
    ? Date.parse(startAt)
    : Date.now() - (count - 1) * intervalMinutes * 60 * 1000;

  // Build the initial population of outages.
  let nextId = 1000;
  const population = [];
  for (const area of AREAS) {
    for (let i = 0; i < area.outages; i++) {
      const customers = Math.max(1, Math.round(area.scale * (0.15 + random() * 1.6)));
      population.push({
        id: `INC-${nextId++}`,
        area,
        customers,
        initialCustomers: customers,
        lat: area.lat + (random() - 0.5) * 0.22,
        lon: area.lon + (random() - 0.5) * 0.28,
        startTime: new Date(start - (0.5 + random() * 3) * HOUR_MS).toISOString(),
        cause: CAUSES[Math.floor(random() * CAUSES.length)],
        crewStatus: CREW_STATUS[Math.floor(random() * CREW_STATUS.length)],
        etrHours: 2 + random() * 10,
        alive: true,
      });
    }
  }

  const snapshots = [];

  for (let step = 0; step < count; step++) {
    const now = start + step * intervalMinutes * 60 * 1000;
    const elapsedHours = (step * intervalMinutes) / 60;

    if (step > 0) {
      // Restoration: each area clears at its own pace.
      for (const outage of population) {
        if (!outage.alive) continue;
        const chance = outage.area.recovery * (intervalMinutes / 60);
        if (random() < chance) {
          outage.alive = false;
        } else if (random() < 0.25) {
          // Partial restoration — crews often bring back part of a feeder.
          outage.customers = Math.max(1, Math.round(outage.customers * (0.55 + random() * 0.3)));
        }
      }

      // A second squall line at the two-hour mark.
      if (elapsedHours >= 2 && elapsedHours < 2.75) {
        const area = AREAS[Math.floor(random() * 3)]; // northwest quadrant
        const newOutages = 1 + Math.floor(random() * 3);
        for (let i = 0; i < newOutages; i++) {
          const customers = Math.max(1, Math.round(area.scale * (0.3 + random() * 1.2)));
          population.push({
            id: `INC-${nextId++}`,
            area,
            customers,
            initialCustomers: customers,
            lat: area.lat + (random() - 0.5) * 0.22,
            lon: area.lon + (random() - 0.5) * 0.28,
            startTime: new Date(now).toISOString(),
            cause: 'Wind Damage',
            crewStatus: 'Assessing damage',
            etrHours: 4 + random() * 8,
            alive: true,
          });
        }
      }
    }

    const live = population.filter((outage) => outage.alive);
    const outages = live.map((outage) => ({
      id: outage.id,
      isCluster: false,
      customersAffected: outage.customers,
      outageCount: 1,
      startTime: outage.startTime,
      etr: new Date(Date.parse(outage.startTime) + outage.etrHours * HOUR_MS).toISOString(),
      etrConfidence: 'MEDIUM',
      cause: outage.cause,
      crewStatus: outage.crewStatus,
      comments: null,
      lat: outage.lat,
      lon: outage.lon,
      zoom: 11,
    }));

    const customersOut = outages.reduce((total, o) => total + o.customersAffected, 0);

    snapshots.push({
      capturedAt: new Date(now).toISOString(),
      instanceId: 'demo-instance',
      viewId: 'demo-view',
      demo: true,
      summary: {
        totalOutages: outages.length,
        customersOut,
        customersServed: 4_100_000,
        generatedAt: new Date(now).toISOString(),
        areas: [],
        raw: {},
      },
      outages,
      coverage: {
        mappedCustomers: customersOut,
        mappedOutages: outages.length,
        customerCoverage: 1,
        truncated: false,
        requests: 0,
      },
    });
  }

  return snapshots;
}
