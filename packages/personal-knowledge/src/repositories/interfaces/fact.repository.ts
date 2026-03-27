import type { Fact, FactFilters, UpsertFactInput } from '../../types/fact.js';
import type { PaginationParams, PaginatedResult, SearchResult } from '../../types/search.js';

export interface FactRepository {
  list(userId: string, filters: FactFilters & PaginationParams): Promise<PaginatedResult<Fact>>;
  get(userId: string, id: string): Promise<Fact | null>;
  upsert(userId: string, data: UpsertFactInput): Promise<{ fact: Fact; created: boolean }>;
  delete(userId: string, id: string): Promise<boolean>;
  search(userId: string, query: string, limit?: number): Promise<SearchResult<Fact>[]>;
}
