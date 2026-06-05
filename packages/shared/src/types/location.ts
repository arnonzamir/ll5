import type { GeoPoint } from './place.js';

export interface Location {
  id: string;
  userId: string;
  location: GeoPoint;
  accuracy?: number;
  speed?: number;
  /** Heading in degrees (0=N, clockwise) — drives the "heading south" phrasing. */
  bearing?: number;
  address?: string;
  /** Reverse-geocoded street/road name. */
  road?: string;
  /** Reverse-geocoded city/town. */
  city?: string;
  /** Reverse-geocoded neighbourhood/suburb. */
  neighborhood?: string;
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
