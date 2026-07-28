// Geographic bucketing. Kubra gives every outage a lat/lon but no area name,
// so we assign each one to a named zone to answer "which areas are recovering
// fastest".
//
// Assignment rules, in order:
//   1. an explicit bbox zone containing the point wins outright
//   2. otherwise the nearest zone centroid wins (Voronoi-style), which leaves
//      no gaps or overlaps to tune
//   3. points further than maxDistanceKm from every zone fall back to a
//      coarse grid cell, so nothing is silently dropped

import { haversineKm, quadkeyForPoint, quadkeyToTile, tileCenter } from './quadkey.js';
import { readFileSync } from 'node:fs';

// Approximate centroids for ComEd's northern-Illinois territory. Cook County
// holds most of the customers, so it is split into sub-areas — a single "Cook"
// bucket would hide exactly the differences this tool exists to surface.
// These are rough centers for bucketing, not authoritative boundaries.
export const DEFAULT_ZONES = [
  { name: 'Chicago - North Side', lat: 41.97, lon: -87.68 },
  { name: 'Chicago - Central/Loop', lat: 41.88, lon: -87.63 },
  { name: 'Chicago - West Side', lat: 41.88, lon: -87.72 },
  { name: 'Chicago - South Side', lat: 41.74, lon: -87.62 },
  { name: 'North Suburban Cook', lat: 42.05, lon: -87.72 },
  { name: 'Northwest Cook', lat: 42.05, lon: -88.0 },
  { name: 'West Cook', lat: 41.88, lon: -87.85 },
  { name: 'Southwest Cook', lat: 41.68, lon: -87.83 },
  { name: 'South Cook', lat: 41.55, lon: -87.65 },
  { name: 'DuPage County', lat: 41.85, lon: -88.09 },
  { name: 'Lake County', lat: 42.33, lon: -87.98 },
  { name: 'Will County', lat: 41.45, lon: -88.0 },
  { name: 'Kane County', lat: 41.94, lon: -88.43 },
  { name: 'McHenry County', lat: 42.32, lon: -88.45 },
  { name: 'Kendall County', lat: 41.59, lon: -88.43 },
  { name: 'DeKalb County', lat: 41.89, lon: -88.77 },
  { name: 'Winnebago County', lat: 42.34, lon: -89.16 },
  { name: 'Boone County', lat: 42.32, lon: -88.82 },
  { name: 'Ogle County', lat: 42.04, lon: -89.32 },
  { name: 'Lee County', lat: 41.74, lon: -89.3 },
  { name: 'LaSalle County', lat: 41.34, lon: -88.88 },
  { name: 'Grundy County', lat: 41.28, lon: -88.42 },
  { name: 'Kankakee County', lat: 41.13, lon: -87.86 },
  { name: 'Iroquois County', lat: 40.75, lon: -87.83 },
  { name: 'Livingston County', lat: 40.89, lon: -88.56 },
  { name: 'Ford County', lat: 40.6, lon: -88.22 },
  { name: 'Bureau County', lat: 41.4, lon: -89.53 },
  { name: 'Stephenson County', lat: 42.35, lon: -89.66 },
  { name: 'Carroll County', lat: 42.06, lon: -89.93 },
];

const GRID_ZOOM = 9;

export function loadZones(path) {
  if (!path) return DEFAULT_ZONES;
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const zones = Array.isArray(parsed) ? parsed : parsed.zones;
  if (!Array.isArray(zones) || zones.length === 0) {
    throw new Error(`${path} must contain a non-empty array of zones`);
  }
  for (const zone of zones) {
    const hasCentroid = Number.isFinite(zone.lat) && Number.isFinite(zone.lon);
    const hasBbox = Array.isArray(zone.bbox) && zone.bbox.length === 4;
    if (!zone.name || (!hasCentroid && !hasBbox)) {
      throw new Error(
        `Zone ${JSON.stringify(zone)} needs a "name" plus either lat/lon or ` +
          'bbox: [west, south, east, north]',
      );
    }
  }
  return zones;
}

/** Name the zone containing (lat, lon). */
export function assignZone(zones, lat, lon, { maxDistanceKm = 60 } = {}) {
  for (const zone of zones) {
    if (!Array.isArray(zone.bbox)) continue;
    const [west, south, east, north] = zone.bbox;
    if (lon >= west && lon <= east && lat >= south && lat <= north) return zone.name;
  }

  let best = null;
  let bestDistance = Infinity;
  for (const zone of zones) {
    if (!Number.isFinite(zone.lat) || !Number.isFinite(zone.lon)) continue;
    const distance = haversineKm([lat, lon], [zone.lat, zone.lon]);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = zone.name;
    }
  }

  if (best && bestDistance <= maxDistanceKm) return best;

  // Outside every zone: bucket into a stable grid cell so the customers still
  // show up somewhere and the label says where.
  const tile = quadkeyToTile(quadkeyForPoint(lat, lon, GRID_ZOOM));
  const [cellLat, cellLon] = tileCenter(tile);
  return `Grid ${cellLat.toFixed(2)}, ${cellLon.toFixed(2)}`;
}

/** Attach a `zone` to every outage. */
export function zoneForOutages(outages, zones, options) {
  return outages.map((outage) => ({
    ...outage,
    zone: assignZone(zones, outage.lat, outage.lon, options),
  }));
}
