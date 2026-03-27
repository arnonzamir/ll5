import type {
  ReviewSession,
  CreateReviewInput,
  UpdateReviewInput,
  ReviewFilters,
  PaginationParams,
  PaginatedResult,
} from '../../types/index.js';

export interface ReviewSessionRepository {
  create(userId: string, data: CreateReviewInput): Promise<ReviewSession>;
  findById(userId: string, id: string): Promise<ReviewSession | null>;
  find(userId: string, filters: ReviewFilters & PaginationParams): Promise<PaginatedResult<ReviewSession>>;
  update(userId: string, id: string, data: UpdateReviewInput): Promise<ReviewSession>;
  findLatest(userId: string, type?: string): Promise<ReviewSession | null>;
}
