export enum InboxStatus {
  CAPTURED = 'captured',
  REVIEWED = 'reviewed',
  PROCESSED = 'processed',
}

export type OutcomeType = 'action' | 'project' | 'someday' | 'reference' | 'trash';

export interface InboxItem {
  id: string;
  userId: string;
  content: string;
  source: string | null;
  sourceLink: string | null;
  status: InboxStatus;
  outcomeType: OutcomeType | null;
  outcomeId: string | null;
  notes: string | null;
  processedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CaptureInboxInput {
  content: string;
  source?: string;
  sourceLink?: string;
}

export interface ProcessInboxInput {
  outcomeType: OutcomeType;
  outcomeId?: string;
  notes?: string;
}

export interface InboxFilters {
  status?: InboxStatus;
}
