import type { DataGap, CreateDataGapInput, UpdateDataGapInput, DataGapFilters } from '../types/data-gap.js';

export interface DataGapRepository {
  find(userId: string, filters: DataGapFilters): Promise<DataGap[]>;
  findById(userId: string, id: string): Promise<DataGap | null>;
  create(userId: string, data: CreateDataGapInput): Promise<DataGap>;
  update(userId: string, id: string, data: UpdateDataGapInput): Promise<DataGap>;
  delete(userId: string, id: string): Promise<void>;
}
