import type { DataGap, DataGapFilters, UpsertDataGapInput } from '../../types/data-gap.js';
import type { PaginationParams, PaginatedResult } from '../../types/search.js';

export interface DataGapRepository {
  list(userId: string, filters: DataGapFilters & PaginationParams): Promise<PaginatedResult<DataGap>>;
  get(userId: string, id: string): Promise<DataGap | null>;
  upsert(userId: string, data: UpsertDataGapInput): Promise<{ dataGap: DataGap; created: boolean }>;
}
