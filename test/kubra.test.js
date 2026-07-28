import assert from 'node:assert/strict';
import { test } from 'node:test';

import { KubraClient } from '../src/kubra.js';
import { quadkeyForPoint } from '../src/quadkey.js';
import { FakeHttp, encodePolyline } from './helpers.js';

const POINT = [42.05, -88.0]; // Northwest Cook
const SESSION = {
  dataPath: 'data/2026/path',
  clusterDataPath: 'cluster/{qkh}/path',
  layerName: 'layer-1',
  regions: 'regions/path',
  regionsKey: 'rk1',
  deploymentId: 'deploy-1',
};

const tileUrl = (quadkey, session = SESSION) => {
  const shard = quadkey.slice(-3).split('').reverse().join('');
  return `https://kubra.io/${session.clusterDataPath.replace('{qkh}', shard)}/public/${session.layerName}/${quadkey}.json`;
};

const feature = (point, desc) => ({ geom: { p: [encodePolyline([point])] }, desc });

test('tile URLs shard on the reversed last three quadkey digits', () => {
  const client = new KubraClient({ http: new FakeHttp() });
  const url = client._tileUrl(SESSION, '0302103');
  assert.equal(url, 'https://kubra.io/cluster/301/path/public/layer-1/0302103.json');
});

test('the crawl descends into clusters and collects the incidents underneath', async () => {
  const q7 = quadkeyForPoint(POINT[0], POINT[1], 7);
  const q8 = quadkeyForPoint(POINT[0], POINT[1], 8);

  const http = new FakeHttp({
    [tileUrl(q7)]: {
      file_data: [feature(POINT, { cluster: true, n_out: 2, cust_a: { val: 900 }, start_time: null })],
    },
    [tileUrl(q8)]: {
      file_data: [
        feature(POINT, {
          cluster: false,
          inc_id: 'INC-1',
          n_out: 1,
          cust_a: { val: 600 },
          start_time: '2026-07-28T00:00:00.000Z',
          etr: '2026-07-28T06:00:00.000Z',
          cause: { 'EN-US': 'Wind Damage' },
          crew_status: 'Crew assigned',
          etr_confidence: 'HIGH',
        }),
        feature([POINT[0] + 0.01, POINT[1] + 0.01], {
          cluster: false,
          inc_id: 'INC-2',
          n_out: 1,
          cust_a: { val: 300 },
          start_time: '2026-07-28T00:10:00.000Z',
        }),
      ],
    },
  });

  const client = new KubraClient({ http, maxZoom: 8 });
  const bbox = { west: POINT[1], east: POINT[1], south: POINT[0], north: POINT[0] };
  const { outages, truncated } = await client.fetchOutages(SESSION, bbox);

  assert.equal(truncated, false);
  assert.equal(outages.length, 2);

  const first = outages.find((o) => o.id === 'INC-1');
  assert.equal(first.customersAffected, 600);
  assert.equal(first.cause, 'Wind Damage');
  assert.equal(first.crewStatus, 'Crew assigned');
  assert.equal(first.startTime, '2026-07-28T00:00:00.000Z');
  assert.equal(first.etr, '2026-07-28T06:00:00.000Z');
  assert.equal(first.isCluster, false);
  assert.equal(Number(first.lat.toFixed(2)), POINT[0]);

  assert.equal(outages.find((o) => o.id === 'INC-2').customersAffected, 300);
});

test('a cluster that will not resolve is still counted, with a stable synthetic id', async () => {
  const q7 = quadkeyForPoint(POINT[0], POINT[1], 7);
  const http = new FakeHttp({
    [tileUrl(q7)]: {
      file_data: [
        feature(POINT, { cluster: true, n_out: 4, cust_a: { val: 1200 }, start_time: '2026-07-28T00:00:00.000Z' }),
      ],
    },
  });

  // maxZoom equals the starting zoom, so there is nowhere to descend to.
  const client = new KubraClient({ http, maxZoom: 7 });
  const bbox = { west: POINT[1], east: POINT[1], south: POINT[0], north: POINT[0] };
  const { outages } = await client.fetchOutages(SESSION, bbox);

  assert.equal(outages.length, 1);
  assert.equal(outages[0].isCluster, true);
  assert.equal(outages[0].customersAffected, 1200);
  assert.match(outages[0].id, /^cluster:/);

  // Re-crawling the same data must produce the same id, or diffs would show
  // phantom restorations every poll.
  const again = await new KubraClient({ http: new FakeHttp(http.routes), maxZoom: 7 }).fetchOutages(SESSION, bbox);
  assert.equal(again.outages[0].id, outages[0].id);
});

test('the crawl stops at the request cap and says so', async () => {
  const q7 = quadkeyForPoint(POINT[0], POINT[1], 7);
  const http = new FakeHttp({
    [tileUrl(q7)]: {
      file_data: [feature(POINT, { cluster: true, n_out: 1, cust_a: { val: 10 } })],
    },
  });
  http.requestCount = 99;

  const client = new KubraClient({ http, maxZoom: 12, maxRequests: 100 });
  const bbox = { west: POINT[1], east: POINT[1], south: POINT[0], north: POINT[0] };
  const { truncated } = await client.fetchOutages(SESSION, bbox);
  assert.equal(truncated, true);
});

test('timestamps arrive as epoch seconds, epoch millis, or ISO and all normalize', async () => {
  const ms = Date.parse('2026-07-28T00:00:00.000Z');
  const q7 = quadkeyForPoint(POINT[0], POINT[1], 7);

  const http = new FakeHttp({
    [tileUrl(q7)]: {
      file_data: [
        feature(POINT, { cluster: false, inc_id: 'S', cust_a: { val: 1 }, start_time: ms / 1000 }),
        feature([POINT[0] + 0.01, POINT[1]], { cluster: false, inc_id: 'M', cust_a: { val: 1 }, start_time: ms }),
        feature([POINT[0] + 0.02, POINT[1]], {
          cluster: false,
          inc_id: 'I',
          cust_a: { val: 1 },
          start_time: '2026-07-28T00:00:00.000Z',
        }),
        feature([POINT[0] + 0.03, POINT[1]], { cluster: false, inc_id: 'N', cust_a: { val: 1 }, start_time: null }),
      ],
    },
  });

  const client = new KubraClient({ http, maxZoom: 7 });
  const bbox = { west: POINT[1], east: POINT[1], south: POINT[0], north: POINT[0] };
  const { outages } = await client.fetchOutages(SESSION, bbox);
  const byId = Object.fromEntries(outages.map((o) => [o.id, o]));

  assert.equal(byId.S.startTime, '2026-07-28T00:00:00.000Z', 'epoch seconds');
  assert.equal(byId.M.startTime, '2026-07-28T00:00:00.000Z', 'epoch milliseconds');
  assert.equal(byId.I.startTime, '2026-07-28T00:00:00.000Z', 'ISO string');
  assert.equal(byId.N.startTime, null, 'missing stays null');
});

test('the summary is read from ComEd and reported as authoritative totals', async () => {
  const http = new FakeHttp({
    [`https://kubra.io/${SESSION.dataPath}/public/summary-1/data.json`]: {
      summaryFileData: {
        totals: [{ total_outages: 137, total_custs_out: 48231, total_cust_s: 4100000 }],
      },
    },
  });

  const summary = await new KubraClient({ http }).fetchSummary(SESSION);
  assert.equal(summary.totalOutages, 137);
  assert.equal(summary.customersOut, 48231);
  assert.equal(summary.customersServed, 4100000);
});

test('a missing summary file degrades to nulls rather than throwing', async () => {
  const summary = await new KubraClient({ http: new FakeHttp() }).fetchSummary(SESSION);
  assert.equal(summary.totalOutages, null);
  assert.equal(summary.customersOut, null);
  assert.deepEqual(summary.areas, []);
});

test('the service-area bounding box is derived from the map polygons', async () => {
  const http = new FakeHttp({
    [`https://kubra.io/${SESSION.regions}/${SESSION.regionsKey}/serviceareas.json`]: {
      file_data: [
        {
          geom: {
            a: [encodePolyline([[41.0, -89.0], [42.5, -87.5], [41.5, -88.2]])],
          },
        },
      ],
    },
  });

  const bbox = await new KubraClient({ http }).fetchServiceAreaBbox(SESSION);
  assert.equal(Number(bbox.south.toFixed(2)), 41.0);
  assert.equal(Number(bbox.north.toFixed(2)), 42.5);
  assert.equal(Number(bbox.west.toFixed(2)), -89.0);
  assert.equal(Number(bbox.east.toFixed(2)), -87.5);
});

test('a full poll wires discovery, summary, and the crawl together', async () => {
  const instanceId = '4fbb3ad3-e01d-4d71-9575-d453769c1171';
  const viewId = '8ed2824a-bd92-474e-a7c4-848b812b7f9b';
  const q7 = quadkeyForPoint(POINT[0], POINT[1], 7);

  const http = new FakeHttp({
    [`https://kubra.io/stormcenter/api/v1/stormcenters/${instanceId}/views/${viewId}/currentState?preview=false`]: {
      data: {
        interval_generation_data: SESSION.dataPath,
        cluster_interval_generation_data: SESSION.clusterDataPath,
      },
      datastatic: { rk1: 'regions/path' },
      stormcenterDeploymentId: 'deploy-1',
    },
    [`https://kubra.io/stormcenter/api/v1/stormcenters/${instanceId}/views/${viewId}/configuration/deploy-1?preview=false`]: {
      config: {
        layers: {
          data: {
            interval_generation_data: [
              { id: 'other', type: 'SERVICE_AREA' },
              { id: 'layer-1', type: 'CLUSTER_LAYER_1' },
            ],
          },
        },
      },
    },
    [`https://kubra.io/${SESSION.dataPath}/public/summary-1/data.json`]: {
      summaryFileData: { totals: [{ total_outages: 1, total_custs_out: 600 }] },
    },
    'https://kubra.io/regions/path/rk1/serviceareas.json': {
      file_data: [{ geom: { a: [encodePolyline([POINT, POINT])] } }],
    },
    [tileUrl(q7)]: {
      file_data: [
        feature(POINT, {
          cluster: false,
          inc_id: 'INC-9',
          n_out: 1,
          cust_a: { val: 600 },
          start_time: '2026-07-28T00:00:00.000Z',
        }),
      ],
    },
  });

  const client = new KubraClient({ instanceId, viewId, http, maxZoom: 7 });
  const snapshot = await client.poll();

  assert.equal(snapshot.summary.customersOut, 600);
  assert.equal(snapshot.outages.length, 1);
  assert.equal(snapshot.outages[0].id, 'INC-9');
  assert.equal(snapshot.coverage.mappedCustomers, 600);
  assert.equal(snapshot.coverage.customerCoverage, 1, 'the crawl found everything ComEd reported');
  assert.ok(Date.parse(snapshot.capturedAt) > 0);
});

test('a stale session raises an actionable error instead of a type error', async () => {
  const client = new KubraClient({ instanceId: 'a', viewId: 'b', http: new FakeHttp() });
  await assert.rejects(() => client.openSession(), /rediscover/);
});

test('discovery fails with instructions for the manual fallback', async () => {
  const client = new KubraClient({ http: new FakeHttp() });
  await assert.rejects(() => client.discoverIds(), /--instance/);
});
