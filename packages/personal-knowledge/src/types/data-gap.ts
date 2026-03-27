export const DATA_GAP_STATUSES = [
  'open',
  'answered',
  'dismissed',
] as const;

export type DataGapStatus = (typeof DATA_GAP_STATUSES)[number];

export interface DataGap {
  id: string;
  userId: string;
  question: string;
  priority: number;
  status: DataGapStatus;
  context?: string;
  answer?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DataGapFilters {
  status?: DataGapStatus;
  minPriority?: number;
}

export interface UpsertDataGapInput {
  id?: string;
  question: string;
  priority?: number;
  status?: DataGapStatus;
  context?: string;
  answer?: string;
}
