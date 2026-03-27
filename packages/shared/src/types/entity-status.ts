export interface EntityStatus {
  id: string;
  userId: string;
  entityName: string;
  summary: string;
  location?: string;
  activity?: string;
  source?: string;
  timestamp: string;
}

export interface EntityStatusQuery {
  entityName?: string;
  source?: string;
  startTime?: string;
  endTime?: string;
  limit?: number;
  offset?: number;
}
