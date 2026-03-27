import type { Person, CreatePersonInput, UpdatePersonInput, PersonFilters } from '../types/person.js';
import type { SearchOptions, SearchResult } from '../types/search.js';

export interface PersonRepository {
  find(userId: string, filters: PersonFilters): Promise<Person[]>;
  search(userId: string, query: string, options?: SearchOptions): Promise<SearchResult<Person>>;
  findById(userId: string, id: string): Promise<Person | null>;
  create(userId: string, data: CreatePersonInput): Promise<Person>;
  update(userId: string, id: string, data: UpdatePersonInput): Promise<Person>;
  delete(userId: string, id: string): Promise<void>;
}
