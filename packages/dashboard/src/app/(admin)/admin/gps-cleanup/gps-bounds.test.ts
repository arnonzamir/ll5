import { describe, it, expect } from "vitest";
import { DEFAULT_GEO_BOUNDS, isOutOfBounds, type GeoBounds } from "./gps-bounds";

const IL = DEFAULT_GEO_BOUNDS;

describe("isOutOfBounds", () => {
  it("does not flag a point well inside the bounds (Tel Aviv)", () => {
    expect(isOutOfBounds({ lat: 32.08, lon: 34.78 }, IL)).toBe(false);
  });

  it("flags a point clearly outside the bounds (London)", () => {
    expect(isOutOfBounds({ lat: 51.5, lon: -0.12 }, IL)).toBe(true);
  });

  it("flags a point that is out on latitude but in on longitude", () => {
    expect(isOutOfBounds({ lat: 10, lon: 35.0 }, IL)).toBe(true);
  });

  it("flags a point that is out on longitude but in on latitude", () => {
    expect(isOutOfBounds({ lat: 32.0, lon: 100 }, IL)).toBe(true);
  });

  it("treats points exactly on each edge as in-bounds (inclusive)", () => {
    expect(isOutOfBounds({ lat: IL.minLat, lon: 35.0 }, IL)).toBe(false);
    expect(isOutOfBounds({ lat: IL.maxLat, lon: 35.0 }, IL)).toBe(false);
    expect(isOutOfBounds({ lat: 31.0, lon: IL.minLon }, IL)).toBe(false);
    expect(isOutOfBounds({ lat: 31.0, lon: IL.maxLon }, IL)).toBe(false);
  });

  it("flags points just past each edge", () => {
    expect(isOutOfBounds({ lat: IL.minLat - 0.001, lon: 35.0 }, IL)).toBe(true);
    expect(isOutOfBounds({ lat: IL.maxLat + 0.001, lon: 35.0 }, IL)).toBe(true);
    expect(isOutOfBounds({ lat: 31.0, lon: IL.minLon - 0.001 }, IL)).toBe(true);
    expect(isOutOfBounds({ lat: 31.0, lon: IL.maxLon + 0.001 }, IL)).toBe(true);
  });

  it("respects custom bounds (a point out for IL can be in for a wider box)", () => {
    const wide: GeoBounds = { minLat: -90, maxLat: 90, minLon: -180, maxLon: 180 };
    expect(isOutOfBounds({ lat: 51.5, lon: -0.12 }, wide)).toBe(false);
  });
});

describe("geo-boundary criterion opt-in semantics", () => {
  // Mirrors how the scan decides whether to run the check at all: when no
  // bounds are active (geo filter disabled), out-of-bounds is never evaluated,
  // so no legitimately-foreign point gets flagged (gap G7).
  function flaggedOutOfBounds(
    point: { lat: number; lon: number },
    bounds: GeoBounds | null,
  ): boolean {
    return bounds ? isOutOfBounds(point, bounds) : false;
  }

  it("never flags an abroad point when the geo filter is disabled (bounds=null)", () => {
    expect(flaggedOutOfBounds({ lat: 51.5, lon: -0.12 }, null)).toBe(false);
  });

  it("flags the same abroad point when the geo filter is active", () => {
    expect(flaggedOutOfBounds({ lat: 51.5, lon: -0.12 }, IL)).toBe(true);
  });
});
