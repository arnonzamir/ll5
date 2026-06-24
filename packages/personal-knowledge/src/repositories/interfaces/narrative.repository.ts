import type {
  Narrative,
  NarrativeConnections,
  NarrativeFilters,
  NarrativeWork,
  NarrativeWorkOptions,
  SubjectRef,
  UpsertNarrativeInput,
} from '../../types/narrative.js';

export interface NarrativeRepository {
  /** Get the narrative for a single subject, or null if none has been written yet. */
  getBySubject(userId: string, subject: SubjectRef): Promise<Narrative | null>;

  /** List narratives by filter (status, subject_kind, participant, staleness, free-text). */
  list(userId: string, filters: NarrativeFilters): Promise<{ items: Narrative[]; total: number }>;

  /** Get narratives that include a given subject as a participant or place. */
  listForParticipant(userId: string, personId: string): Promise<Narrative[]>;

  /**
   * The connection map for one narrative — its participant/place entity spokes and
   * the other narratives it links to (via shared participants, shared places, or
   * co-occurring observation subjects). Derived on read; no stored edges.
   */
  getConnections(userId: string, subject: SubjectRef): Promise<NarrativeConnections>;

  /**
   * Select the narratives to REFRESH and the subjects to CREATE for one maintenance
   * pass — the driver query for the async narrative loop. `stale` = active narratives
   * with new activity since their last summary (debounced); `orphans` = subjects with
   * >= promoteThreshold recent observations and no narrative yet. Both computed against
   * the LIVE max(observed_at), never the denormalized last_observed_at.
   */
  selectConsolidationWork(userId: string, options?: NarrativeWorkOptions): Promise<NarrativeWork>;

  /**
   * Create or update a narrative keyed on subject. Sensitivity is bumped (logical OR),
   * never lowered. Returns the resulting narrative + whether it was newly created.
   */
  upsert(userId: string, input: UpsertNarrativeInput): Promise<{ narrative: Narrative; created: boolean }>;

  delete(userId: string, subject: SubjectRef): Promise<boolean>;
}
