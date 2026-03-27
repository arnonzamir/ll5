import type { GeoPoint } from './place.js';

export interface Location {
  id: string;
  userId: string;
  location: GeoPoint;
  accuracy?: number;
  speed?: number;
  address?: string;
  matchedPlaceId?: string;
  matchedPlace?: string;
  deviceTimezone?: string;
  timestamp: string;
}

export interface LocationQuery {
  startTime?: string;
  endTime?: string;
  placeId?: string;
  limit?: number;
  offset?: number;
}
