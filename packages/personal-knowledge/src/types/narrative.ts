export type SubjectKind = 'person' | 'place' | 'group' | 'topic';

export interface SubjectRef {
  kind: SubjectKind;
  ref: string;
}

export type ObservationSource =
  | 'whatsapp'
  | 'telegram'
  | 'chat'
  | 'system'
  | 'journal'
  | 'inference'
  | 'user_statement';

export type Confidence = 'high' | 'medium' | 'low';

export interface Observation {
  id: string;
  userId: string;
  subjects: SubjectRef[];
  text: string;
  source: ObservationSource;
  sourceId?: string;
  sourceExcerpt?: string;
  confidence: Confidence;
  mood?: string;
  sensitive: boolean;
  observedAt: string;
  createdAt: string;
}

export interface CreateObservationInput {
  subjects: SubjectRef[];
  text: string;
  source: ObservationSource;
  sourceId?: string;
  sourceExcerpt?: string;
  confidence?: Confidence;
  mood?: string;
  sensitive?: boolean;
  observedAt?: string;
}

export interface RecallFilters {
  subjects?: SubjectRef[];
  query?: string;
  since?: string;
  limit?: number;
}

export type NarrativeStatus = 'active' | 'dormant' | 'closed';

export interface NarrativeDecision {
  observedAt: string;
  text: string;
}

export interface Narrative {
  id: string;
  userId: string;
  subject: SubjectRef;
  title: string;
  summary: string;
  currentMood?: string;
  openThreads: string[];
  recentDecisions: NarrativeDecision[];
  participants: string[];
  places: string[];
  observationCount: number;
  firstObservedAt?: string;
  lastObservedAt?: string;
  lastConsolidatedAt?: string;
  sensitive: boolean;
  status: NarrativeStatus;
  closedReason?: string;
}

export interface UpsertNarrativeInput {
  subject: SubjectRef;
  title?: string;
  summary?: string;
  currentMood?: string;
  openThreads?: string[];
  recentDecisions?: NarrativeDecision[];
  participants?: string[];
  places?: string[];
  observationCount?: number;
  firstObservedAt?: string;
  lastObservedAt?: string;
  lastConsolidatedAt?: string;
  sensitive?: boolean;
  status?: NarrativeStatus;
  closedReason?: string;
}

export interface NarrativeFilters {
  status?: NarrativeStatus;
  subjectKind?: SubjectKind;
  participantId?: string;
  staleForDays?: number;
  query?: string;
  limit?: number;
  offset?: number;
}

/**
 * Deterministic doc id for a narrative — one per (user, subject).
 * Application-layer uniqueness; ES has no unique constraints.
 */
export function narrativeDocId(userId: string, subject: SubjectRef): string {
  return `${userId}::${subject.kind}::${subject.ref}`;
}
