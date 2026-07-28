import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodePoint, decodePolyline } from '../src/polyline.js';
import {
  haversineKm,
  neighboringQuadkeys,
  quadkeyForPoint,
  quadkeyToTile,
  quadkeysForBbox,
  tileCenter,
  tileForPoint,
  tileToQuadkey,
} from '../src/quadkey.js';
import { DEFAULT_ZONES, assignZone } from '../src/zones.js';
import { encodePolyline } from './helpers.js';

test('decodes the reference polyline from the Google spec', () => {
  const decoded = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.equal(decoded.length, 3);
  assert.deepEqual(decoded[0].map((n) => Number(n.toFixed(5))), [38.5, -120.2]);
  assert.deepEqual(decoded[1].map((n) => Number(n.toFixed(5))), [40.7, -120.95]);
  assert.deepEqual(decoded[2].map((n) => Number(n.toFixed(5))), [43.252, -126.453]);
});

test('polyline decoding round-trips an encoded ComEd-area point', () => {
  const point = [41.8781, -87.6298];
  const decoded = decodePoint(encodePolyline([point]));
  assert.equal(Number(decoded[0].toFixed(5)), point[0]);
  assert.equal(Number(decoded[1].toFixed(5)), point[1]);
});

test('polyline decoding tolerates empty and malformed input', () => {
  assert.deepEqual(decodePolyline(''), []);
  assert.equal(decodePoint(''), null);
  assert.equal(decodePoint(null), null);
});

test('quadkey matches the Bing reference example', () => {
  assert.equal(tileToQuadkey({ x: 3, y: 5, z: 3 }), '213');
  assert.deepEqual(quadkeyToTile('213'), { x: 3, y: 5, z: 3 });
});

test('tile and quadkey conversions round-trip across zooms', () => {
  for (const zoom of [7, 9, 11, 14]) {
    const tile = tileForPoint(41.8781, -87.6298, zoom);
    const quadkey = tileToQuadkey(tile);
    assert.equal(quadkey.length, zoom);
    assert.deepEqual(quadkeyToTile(quadkey), tile);
  }
});

test('a tile center lands back inside its own tile', () => {
  const quadkey = quadkeyForPoint(42.05, -88.0, 10);
  const [lat, lon] = tileCenter(quadkeyToTile(quadkey));
  assert.equal(quadkeyForPoint(lat, lon, 10), quadkey);
});

test('a bbox covers every tile between its corners', () => {
  const bbox = { west: -88.5, south: 41.5, east: -87.5, north: 42.5 };
  const quadkeys = quadkeysForBbox(bbox, 9);
  assert.ok(quadkeys.length >= 4, 'expected several tiles at zoom 9');
  // Both corners must be represented.
  assert.ok(quadkeys.includes(quadkeyForPoint(42.5, -88.5, 9)));
  assert.ok(quadkeys.includes(quadkeyForPoint(41.5, -87.5, 9)));
  assert.equal(new Set(quadkeys).size, quadkeys.length, 'no duplicates');
});

test('interior tiles have eight neighbours and edge tiles fewer', () => {
  assert.equal(neighboringQuadkeys(quadkeyForPoint(41.88, -87.63, 9)).length, 8);
  assert.equal(neighboringQuadkeys('000').length, 3); // north-west corner of the map
});

test('haversine distance is right for a known Chicago-area pair', () => {
  // The Loop to Evanston is roughly 20 km.
  const km = haversineKm([41.8781, -87.6298], [42.0451, -87.6877]);
  assert.ok(km > 18 && km < 22, `expected ~20km, got ${km}`);
});

test('zones assign points to the nearest centroid', () => {
  assert.equal(assignZone(DEFAULT_ZONES, 41.8781, -87.6298), 'Chicago - Central/Loop');
  assert.equal(assignZone(DEFAULT_ZONES, 42.33, -87.98), 'Lake County');
  assert.equal(assignZone(DEFAULT_ZONES, 41.45, -88.0), 'Will County');
});

test('an explicit bbox zone beats a closer centroid', () => {
  const zones = [
    { name: 'Loop', lat: 41.88, lon: -87.63 },
    { name: 'My block', bbox: [-87.72, 41.94, -87.68, 41.98] },
  ];
  assert.equal(assignZone(zones, 41.96, -87.7), 'My block');
  assert.equal(assignZone(zones, 41.88, -87.63), 'Loop');
});

test('points far outside every zone fall back to a labelled grid cell', () => {
  // Middle of the Atlantic — nowhere near ComEd territory.
  const zone = assignZone(DEFAULT_ZONES, 30.0, -40.0);
  assert.match(zone, /^Grid /);
});
