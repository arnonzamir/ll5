import type {
  Observation,
  CreateObservationInput,
  RecallFilters,
  SubjectRef,
} from '../../types/narrative.js';

export interface ObservationRepository {
  create(userId: string, input: CreateObservationInput): Promise<Observation>;

  /** Recall observations matching subjects and/or free-text query, chronological newest-first. */
  recall(userId: string, filters: RecallFilters): Promise<Observation[]>;

  /** Get observation count + first/last observed_at for a single subject. Used by narrative rollups. */
  statsForSubject(userId: string, subject: SubjectRef): Promise<{
    count: number;
    firstObservedAt?: string;
    lastObservedAt?: string;
    sensitive: boolean;
  }>;

  /**
   * List observations for one subject since a given timestamp (or all),
   * chronological oldest-first. Used by consolidation.
   */
  listForSubject(
    userId: string,
    subject: SubjectRef,
    opts?: { since?: string; limit?: number },
  ): Promise<Observation[]>;

  delete(userId: string, id: string): Promise<boolean>;
}
