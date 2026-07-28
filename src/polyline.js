// Decoder for Google's Encoded Polyline Algorithm.
// Kubra ships every outage geometry as an encoded polyline string, so we need
// this to turn `desc.geom.p[0]` into a [lat, lon] pair.
// https://developers.google.com/maps/documentation/utilities/polylinealgorithm

export function decodePolyline(encoded, precision = 5) {
  if (typeof encoded !== 'string' || encoded.length === 0) return [];

  const factor = 10 ** precision;
  const coordinates = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  while (index < encoded.length) {
    let byte;
    let shift = 0;
    let result = 1;

    do {
      byte = encoded.charCodeAt(index++) - 63 - 1;
      result += byte << shift;
      shift += 5;
    } while (byte >= 0x1f && index < encoded.length);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 1;
    do {
      byte = encoded.charCodeAt(index++) - 63 - 1;
      result += byte << shift;
      shift += 5;
    } while (byte >= 0x1f && index < encoded.length);
    lon += result & 1 ? ~(result >> 1) : result >> 1;

    coordinates.push([lat / factor, lon / factor]);
  }

  return coordinates;
}

/** First [lat, lon] of an encoded polyline, or null if it does not decode. */
export function decodePoint(encoded) {
  const points = decodePolyline(encoded);
  return points.length > 0 ? points[0] : null;
}
