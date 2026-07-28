// Slippy-tile / quadkey math. Kubra addresses its outage tiles by Bing quadkey,
// so we need tile<->quadkey<->lat/lon conversion. This replaces the `mercantile`
// dependency the Python scrapers use so the tool stays dependency-free.

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

export function tileForPoint(lat, lon, zoom) {
  const n = 2 ** zoom;
  const latRad = (lat * Math.PI) / 180;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  return { x: clamp(x, 0, n - 1), y: clamp(y, 0, n - 1), z: zoom };
}

export function tileToQuadkey({ x, y, z }) {
  let quadkey = '';
  for (let i = z; i > 0; i--) {
    let digit = 0;
    const mask = 1 << (i - 1);
    if ((x & mask) !== 0) digit += 1;
    if ((y & mask) !== 0) digit += 2;
    quadkey += String(digit);
  }
  return quadkey;
}

export function quadkeyToTile(quadkey) {
  let x = 0;
  let y = 0;
  const z = quadkey.length;
  for (let i = z; i > 0; i--) {
    const mask = 1 << (i - 1);
    switch (quadkey[z - i]) {
      case '0':
        break;
      case '1':
        x |= mask;
        break;
      case '2':
        y |= mask;
        break;
      case '3':
        x |= mask;
        y |= mask;
        break;
      default:
        throw new Error(`Invalid quadkey digit in "${quadkey}"`);
    }
  }
  return { x, y, z };
}

export function quadkeyForPoint(lat, lon, zoom) {
  return tileToQuadkey(tileForPoint(lat, lon, zoom));
}

/** North-west corner of a tile, as [lat, lon]. */
export function tileNorthWest({ x, y, z }) {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  return [(latRad * 180) / Math.PI, lon];
}

/** Approximate center of a tile, as [lat, lon]. */
export function tileCenter(tile) {
  const [north, west] = tileNorthWest(tile);
  const [south, east] = tileNorthWest({ x: tile.x + 1, y: tile.y + 1, z: tile.z });
  return [(north + south) / 2, (west + east) / 2];
}

/** Every quadkey at `zoom` covering the bounding box. */
export function quadkeysForBbox({ west, south, east, north }, zoom) {
  const topLeft = tileForPoint(north, west, zoom);
  const bottomRight = tileForPoint(south, east, zoom);
  const quadkeys = [];
  for (let x = topLeft.x; x <= bottomRight.x; x++) {
    for (let y = topLeft.y; y <= bottomRight.y; y++) {
      quadkeys.push(tileToQuadkey({ x, y, z: zoom }));
    }
  }
  return quadkeys;
}

/** The eight quadkeys touching `quadkey`, skipping any that fall off the map. */
export function neighboringQuadkeys(quadkey) {
  const { x, y, z } = quadkeyToTile(quadkey);
  const max = 2 ** z - 1;
  const offsets = [
    [0, -1], [1, 0], [0, 1], [-1, 0],
    [1, -1], [1, 1], [-1, -1], [-1, 1],
  ];
  return offsets
    .map(([dx, dy]) => ({ x: x + dx, y: y + dy, z }))
    .filter((t) => t.x >= 0 && t.y >= 0 && t.x <= max && t.y <= max)
    .map(tileToQuadkey);
}

/** Great-circle distance in kilometers. */
export function haversineKm([lat1, lon1], [lat2, lon2]) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
