export enum InboxStatus {
  CAPTURED = 'captured',
  REVIEWED = 'reviewed',
  PROCESSED = 'processed',
}

export interface InboxItem {
  id: string;
  userId: string;
  content: string;
  source: string;
  sourceLink?: string;
  status: InboxStatus;
  suggestedOutcome?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateInboxInput {
  content: string;
  source?: string;
  sourceLink?: string;
}

export interface ProcessInboxInput {
  status: InboxStatus;
  suggestedOutcome?: Record<string, unknown>;
}

export interface InboxFilters {
  status?: InboxStatus;
  source?: string;
  limit?: number;
  offset?: number;
}
