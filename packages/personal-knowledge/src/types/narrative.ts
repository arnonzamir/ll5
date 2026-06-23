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

/**
 * How to order a narrative list.
 * - `recency` (default): newest activity first (`last_observed_at desc`).
 * - `relevance`: composite "currently relevant" score — recency-dominant, boosted
 *   by active status, open threads, and observation volume. Computed at read time
 *   (see `narrativeRelevance`), so it reflects the LIVE observation count, not the
 *   stale stored one.
 */
export type NarrativeSort = 'relevance' | 'recency';

export interface NarrativeFilters {
  status?: NarrativeStatus;
  subjectKind?: SubjectKind;
  participantId?: string;
  placeId?: string;
  staleForDays?: number;
  query?: string;
  sort?: NarrativeSort;
  limit?: number;
  offset?: number;
}

/** Why two narratives (or a narrative and an entity) are linked. */
export type ConnectionVia = 'shared-participant' | 'shared-place' | 'co-subject';

/** A narrative connected to the focus narrative, with the reason(s) and strength. */
export interface RelatedNarrative {
  subject: SubjectRef;
  title: string;
  status: NarrativeStatus;
  via: ConnectionVia[];
  /** Composite link strength — higher = more shared participants/places/co-occurrences. */
  weight: number;
  /** The participant ids / place ids / co-subjects that drive the link. */
  sharedKeys: string[];
}

/** A direct entity spoke off the focus narrative (a participant person or a place). */
export interface EntityNode {
  kind: 'person' | 'place';
  ref: string;
  name?: string;
}

/**
 * The connection map for one narrative: its direct entity spokes (participants +
 * places) and the other narratives it links to. Derived on read from shared
 * participants/places and co-occurring observation subjects — no stored edges.
 */
export interface NarrativeConnections {
  subject: SubjectRef;
  entities: EntityNode[];
  related: RelatedNarrative[];
}

/**
 * Deterministic doc id for a narrative — one per (user, subject).
 * Application-layer uniqueness; ES has no unique constraints.
 */
export function narrativeDocId(userId: string, subject: SubjectRef): string {
  return `${userId}::${subject.kind}::${subject.ref}`;
}

/**
 * "Currently relevant" score in [0,1] for ranking narratives. Recency-dominant —
 * the strongest signal that a thread matters NOW is that it was just touched —
 * with secondary boosts for being active, carrying open loops, and having
 * accumulated substance. Pure + deterministic so the list ordering is stable
 * within a request; pass a single `nowMs` for the whole batch.
 *
 * Weights: recency 0.6, status 0.2, open-threads 0.1, volume 0.1.
 * Recency uses a ~3-day soft half-life (exp(-ageHours/72)).
 */
export function narrativeRelevance(n: Narrative, nowMs: number): number {
  const lastIso = n.lastObservedAt ?? n.firstObservedAt;
  const last = lastIso ? Date.parse(lastIso) : NaN;
  const ageHours = Number.isFinite(last)
    ? Math.max(0, (nowMs - last) / 3_600_000)
    : 24 * 365; // unknown activity → treat as very old
  const recency = Math.exp(-ageHours / 72);
  const statusWeight = n.status === 'active' ? 1 : n.status === 'dormant' ? 0.4 : 0.05;
  const openThreads = Math.min(n.openThreads?.length ?? 0, 5) / 5;
  const volume = Math.min(Math.log1p(n.observationCount ?? 0) / Math.log1p(50), 1);
  return recency * 0.6 + statusWeight * 0.2 + openThreads * 0.1 + volume * 0.1;
}
