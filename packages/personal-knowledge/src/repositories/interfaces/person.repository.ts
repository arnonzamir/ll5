import type { Person, PersonFilters, UpsertPersonInput } from '../../types/person.js';
import type { PaginationParams, PaginatedResult, SearchResult } from '../../types/search.js';

export interface PersonRepository {
  list(userId: string, filters: PersonFilters & PaginationParams): Promise<PaginatedResult<Person>>;
  get(userId: string, id: string): Promise<Person | null>;
  upsert(userId: string, data: UpsertPersonInput): Promise<{ person: Person; created: boolean }>;
  delete(userId: string, id: string): Promise<boolean>;
  search(userId: string, query: string, limit?: number): Promise<SearchResult<Person>[]>;
}
