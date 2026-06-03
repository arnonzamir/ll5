/** Mean Earth radius in meters. */
const EARTH_RADIUS_M = 6_371_000;

/**
 * Great-circle (haversine) distance between two lat/lon points, in METERS.
 * The one canonical implementation — previously duplicated in the gateway (km)
 * and awareness (m).
 */
export function haversineMeters(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** Convenience: kilometers. */
export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  return haversineMeters(a, b) / 1000;
}
