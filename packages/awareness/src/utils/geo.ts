/**
 * Geographic helpers used by geo-search tools (and anywhere else that needs
 * straight-line distance between two GPS points).
 *
 * Kept as a small pure module so it can be unit-tested without spinning up
 * the MCP server or mocking fetch.
 */

const EARTH_RADIUS_M = 6_371_000;

/**
 * Haversine great-circle distance in **meters** between two lat/lon pairs.
 *
 * Standard formula; accuracy is well within ~0.5% for distances on Earth.
 * Returns 0 for identical points.
 *
 * Reference points:
 *   NYC (40.7128, -74.0060) → LA (34.0522, -118.2437) ≈ 3,935 km
 *   London (51.5074, -0.1278) → Paris (48.8566, 2.3522) ≈ 344 km
 */
export function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
