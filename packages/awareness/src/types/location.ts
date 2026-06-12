// Re-export shared types
export type { Location, LocationQuery } from '@ll5/shared';
export type { GeoPoint } from '@ll5/shared';

// One freshness vocabulary for the whole system. The location snapshot computes
// it from GPS-fix age (shared `freshnessLabel`); device heartbeats use their own
// thresholds below — same four words, different age cutoffs per domain.
import type { Freshness } from '@ll5/shared';
export type LocationFreshness = Freshness;

export interface LocationWithFreshness {
  lat: number;
  lon: number;
  accuracy?: number;
  timestamp: string;
  freshness: LocationFreshness;
  place_name: string | null;
  place_type: string | null;
  address: string | null;
}

/** Device-heartbeat freshness (tracked devices): live < 5m, recent < 30m,
 *  stale < 2h, else unknown. Distinct from GPS-fix freshness on purpose. */
export function computeFreshness(timestamp: string): LocationFreshness {
  const ageMs = Date.now() - new Date(timestamp).getTime();
  const minutes = ageMs / 60_000;
  if (minutes < 5) return 'live';
  if (minutes < 30) return 'recent';
  if (minutes < 120) return 'stale';
  return 'unknown';
}
