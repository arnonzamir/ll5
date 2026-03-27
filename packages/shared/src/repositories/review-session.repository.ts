import type { ReviewSession, CreateReviewInput, ReviewType, ReviewStatus, ReviewPhase } from '../types/review.js';

export interface ReviewSessionRepository {
  find(userId: string, filters?: { type?: ReviewType; status?: ReviewStatus; limit?: number }): Promise<ReviewSession[]>;
  findById(userId: string, id: string): Promise<ReviewSession | null>;
  create(userId: string, data: CreateReviewInput): Promise<ReviewSession>;
  update(userId: string, id: string, data: { status?: ReviewStatus; currentPhase?: ReviewPhase; phaseData?: Record<string, unknown>; completedAt?: string }): Promise<ReviewSession>;
  findLatest(userId: string, type?: ReviewType): Promise<ReviewSession | null>;
}
