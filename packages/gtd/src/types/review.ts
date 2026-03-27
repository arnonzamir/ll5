export type ReviewType = 'daily' | 'weekly' | 'horizons';
export type ReviewStatus = 'in_progress' | 'completed';

export interface ReviewSession {
  id: string;
  userId: string;
  type: ReviewType;
  status: ReviewStatus;
  currentPhase: string | null;
  phaseData: Record<string, unknown> | null;
  startedAt: Date;
  completedAt: Date | null;
}

export interface CreateReviewInput {
  type: ReviewType;
  currentPhase?: string;
  phaseData?: Record<string, unknown>;
}

export interface UpdateReviewInput {
  status?: ReviewStatus;
  currentPhase?: string | null;
  phaseData?: Record<string, unknown> | null;
  completedAt?: Date;
}

export interface ReviewFilters {
  type?: ReviewType;
  status?: ReviewStatus;
}
