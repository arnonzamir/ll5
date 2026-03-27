export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface Place {
  id: string;
  userId: string;
  name: string;
  type?: string;
  address?: string;
  location?: GeoPoint;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreatePlaceInput {
  name: string;
  type?: string;
  address?: string;
  location?: GeoPoint;
  tags?: string[];
}

export interface UpdatePlaceInput {
  name?: string;
  type?: string;
  address?: string;
  location?: GeoPoint;
  tags?: string[];
}

export interface PlaceFilters {
  type?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
}
