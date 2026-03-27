export const PLACE_TYPES = [
  'home',
  'work',
  'restaurant',
  'store',
  'medical',
  'school',
  'gym',
  'other',
] as const;

export type PlaceType = (typeof PLACE_TYPES)[number];

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface Place {
  id: string;
  userId: string;
  name: string;
  type: PlaceType;
  address?: string;
  geo?: GeoPoint;
  tags: string[];
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlaceFilters {
  type?: PlaceType;
  tags?: string[];
  query?: string;
  near?: { lat: number; lon: number; radiusKm: number };
}

export interface UpsertPlaceInput {
  id?: string;
  name: string;
  type: PlaceType;
  address?: string;
  geo?: GeoPoint;
  tags?: string[];
  notes?: string;
}
