export interface DataGap {
  id: string;
  userId: string;
  description: string;
  category?: string;
  priority?: string;
  resolved: boolean;
  resolvedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDataGapInput {
  description: string;
  category?: string;
  priority?: string;
}

export interface UpdateDataGapInput {
  description?: string;
  category?: string;
  priority?: string;
  resolved?: boolean;
}

export interface DataGapFilters {
  category?: string;
  priority?: string;
  resolved?: boolean;
  limit?: number;
  offset?: number;
}
