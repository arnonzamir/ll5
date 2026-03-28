import type { Location, LocationQuery, GeoPoint } from '../../types/location.js';

export interface LocationRepository {
  /** Get the most recent GPS fix. */
  getLatest(userId: string): Promise<Location | null>;

  /** Query location history within a time range. */
  query(userId: string, query: LocationQuery): Promise<Location[]>;

  /** Store a new GPS fix. */
  create(userId: string, data: {
    location: GeoPoint;
    accuracy?: number;
    speed?: number;
    address?: string;
    matchedPlaceId?: string;
    matchedPlace?: string;
    deviceTimezone?: string;
    timestamp: string;
  }): Promise<Location>;
}
