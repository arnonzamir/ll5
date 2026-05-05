import type {
  Narrative,
  NarrativeFilters,
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
   * Create or update a narrative keyed on subject. Sensitivity is bumped (logical OR),
   * never lowered. Returns the resulting narrative + whether it was newly created.
   */
  upsert(userId: string, input: UpsertNarrativeInput): Promise<{ narrative: Narrative; created: boolean }>;

  delete(userId: string, subject: SubjectRef): Promise<boolean>;
}
