import type { Place, CreatePlaceInput, UpdatePlaceInput, PlaceFilters, GeoPoint } from '../types/place.js';
import type { SearchOptions, SearchResult } from '../types/search.js';

export interface PlaceRepository {
  find(userId: string, filters: PlaceFilters): Promise<Place[]>;
  search(userId: string, query: string, options?: SearchOptions): Promise<SearchResult<Place>>;
  findNearby(userId: string, point: GeoPoint, radiusKm: number, limit?: number): Promise<Place[]>;
  findById(userId: string, id: string): Promise<Place | null>;
  create(userId: string, data: CreatePlaceInput): Promise<Place>;
  update(userId: string, id: string, data: UpdatePlaceInput): Promise<Place>;
  delete(userId: string, id: string): Promise<void>;
}
