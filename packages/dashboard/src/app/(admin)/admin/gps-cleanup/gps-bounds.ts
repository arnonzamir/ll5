/**
 * Pure geo-bounds helpers for the GPS cleanup tool.
 *
 * Kept in a plain (non-"use server") module so the bounding-box predicate is
 * directly unit-testable and so the server-action file can import a single
 * shared constant/predicate. Server-action files may only export async
 * functions, so these synchronous helpers must live here.
 */

export interface GeoBounds {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

/**
 * Default geo bounds: Israel bounding box (generous — includes Golan, Eilat,
 * Dead Sea). Used only when the caller opts into the geo-boundary criterion
 * without supplying its own bounds. The criterion is OFF by default so the
 * scan is safe to run while/after traveling abroad (gap G7).
 */
export const DEFAULT_GEO_BOUNDS: GeoBounds = {
  minLat: 29.4,
  maxLat: 33.4,
  minLon: 34.2,
  maxLon: 35.9,
};

/**
 * True when the point lies strictly outside the (inclusive) bounding box.
 * Points exactly on an edge are considered in-bounds (not flagged).
 */
export function isOutOfBounds(
  point: { lat: number; lon: number },
  bounds: GeoBounds,
): boolean {
  return (
    point.lat < bounds.minLat ||
    point.lat > bounds.maxLat ||
    point.lon < bounds.minLon ||
    point.lon > bounds.maxLon
  );
}
