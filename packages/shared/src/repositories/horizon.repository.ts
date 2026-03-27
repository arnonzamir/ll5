import type { Horizon, CreateHorizonInput, UpdateHorizonInput, HorizonFilters } from '../types/horizon.js';
import type { SearchOptions, SearchResult } from '../types/search.js';

export interface HorizonRepository {
  find(userId: string, filters: HorizonFilters): Promise<Horizon[]>;
  findById(userId: string, id: string): Promise<Horizon | null>;
  create(userId: string, data: CreateHorizonInput): Promise<Horizon>;
  update(userId: string, id: string, data: UpdateHorizonInput): Promise<Horizon>;
  delete(userId: string, id: string): Promise<void>;
  countByProject(userId: string, projectId: string): Promise<number>;
  findProjectsWithActionCounts(userId: string): Promise<Array<{ project: Horizon; actionCount: number }>>;
  searchByTitle(userId: string, query: string, options?: SearchOptions): Promise<SearchResult<Horizon>>;
}
