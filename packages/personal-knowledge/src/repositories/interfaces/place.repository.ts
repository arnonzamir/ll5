import type { Place, PlaceFilters, UpsertPlaceInput } from '../../types/place.js';
import type { PaginationParams, PaginatedResult, SearchResult } from '../../types/search.js';

export interface PlaceRepository {
  list(userId: string, filters: PlaceFilters & PaginationParams): Promise<PaginatedResult<Place>>;
  get(userId: string, id: string): Promise<Place | null>;
  upsert(userId: string, data: UpsertPlaceInput): Promise<{ place: Place; created: boolean }>;
  delete(userId: string, id: string): Promise<boolean>;
  search(userId: string, query: string, limit?: number): Promise<SearchResult<Place>[]>;
}
