export enum ReviewType {
  DAILY = 'daily',
  WEEKLY = 'weekly',
  HORIZONS = 'horizons',
}

export enum ReviewStatus {
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  ABANDONED = 'abandoned',
}

export type ReviewPhase =
  | 'collect'
  | 'process'
  | 'organize'
  | 'review'
  | 'reflect'
  | 'engage';

export interface ReviewSession {
  id: string;
  userId: string;
  type: ReviewType;
  status: ReviewStatus;
  currentPhase?: ReviewPhase;
  phaseData?: Record<string, unknown>;
  startedAt: string;
  completedAt?: string;
}

export interface CreateReviewInput {
  type: ReviewType;
  currentPhase?: ReviewPhase;
}
