import type { Fact, CreateFactInput, UpdateFactInput, FactFilters } from '../types/fact.js';
import type { SearchOptions, SearchResult } from '../types/search.js';

export interface FactRepository {
  find(userId: string, filters: FactFilters): Promise<Fact[]>;
  search(userId: string, query: string, options?: SearchOptions): Promise<SearchResult<Fact>>;
  findById(userId: string, id: string): Promise<Fact | null>;
  create(userId: string, data: CreateFactInput): Promise<Fact>;
  update(userId: string, id: string, data: UpdateFactInput): Promise<Fact>;
  delete(userId: string, id: string): Promise<void>;
}
