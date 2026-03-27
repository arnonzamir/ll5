import type { Location, LocationQuery } from '../types/location.js';
import type { GeoPoint } from '../types/place.js';

export interface LocationRepository {
  getLatest(userId: string): Promise<Location | null>;
  query(userId: string, query: LocationQuery): Promise<Location[]>;
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
