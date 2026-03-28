// Re-export shared types
export type { Location, LocationQuery } from '@ll5/shared';
export type { GeoPoint } from '@ll5/shared';

export type LocationFreshness = 'live' | 'recent' | 'stale' | 'unknown';

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

export function computeFreshness(timestamp: string): LocationFreshness {
  const ageMs = Date.now() - new Date(timestamp).getTime();
  const minutes = ageMs / 60_000;
  if (minutes < 5) return 'live';
  if (minutes < 30) return 'recent';
  if (minutes < 120) return 'stale';
  return 'unknown';
}
