import type { Client } from '@elastic/elasticsearch';
import { BaseElasticsearchRepository, type EsQueryContainer } from './base.repository.js';
import type { NarrativeRepository } from '../interfaces/narrative.repository.js';
import {
  type ConnectionVia,
  type EntityNode,
  type Narrative,
  type NarrativeConnections,
  type NarrativeFilters,
  type RelatedNarrative,
  type SubjectRef,
  type UpsertNarrativeInput,
  narrativeDocId,
  narrativeRelevance,
} from '../../types/narrative.js';
import { logger } from '../../utils/logger.js';

const INDEX = 'll5_knowledge_narratives';
const OBSERVATIONS_INDEX = 'll5_knowledge_observations';

function subjectKey(s: { kind: string; ref: string }): string {
  return `${s.kind}::${s.ref}`;
}

interface NarrativeDoc {
  user_id: string;
  subject: { kind: string; ref: string };
  title: string;
  summary: string;
  current_mood?: string;
  open_threads: string[];
  recent_decisions: Array<{ observed_at: string; text: string }>;
  participants: string[];
  places: string[];
  observation_count: number;
  first_observed_at?: string;
  last_observed_at?: string;
  last_consolidated_at?: string;
  sensitive: boolean;
  status: string;
  closed_reason?: string;
}

function docToNarrative(doc: NarrativeDoc, id: string): Narrative {
  return {
    id,
    userId: doc.user_id,
    subject: {
      kind: doc.subject.kind as SubjectRef['kind'],
      ref: doc.subject.ref,
    },
    title: doc.title,
    summary: doc.summary ?? '',
    currentMood: doc.current_mood,
    openThreads: doc.open_threads ?? [],
    recentDecisions: (doc.recent_decisions ?? []).map((d) => ({
      observedAt: d.observed_at,
      text: d.text,
    })),
    participants: doc.participants ?? [],
    places: doc.places ?? [],
    observationCount: doc.observation_count ?? 0,
    firstObservedAt: doc.first_observed_at,
    lastObservedAt: doc.last_observed_at,
    lastConsolidatedAt: doc.last_consolidated_at,
    sensitive: doc.sensitive ?? false,
    status: (doc.status ?? 'active') as Narrative['status'],
    closedReason: doc.closed_reason,
  };
}

export class ElasticsearchNarrativeRepository
  extends BaseElasticsearchRepository
  implements NarrativeRepository
{
  constructor(client: Client) {
    super(client, INDEX);
  }

  /**
   * Compute the real observation count per subject, live from the observations
   * index. The `observation_count` stored on a narrative doc is only written
   * during consolidation, so it goes stale the moment new observations are
   * tagged to the subject (it sat at 0 for every narrative after the May
   * cutover). Reads must reflect reality, so we always recompute here — one
   * filters-aggregation covers every subject in the batch. On any failure we
   * return an empty map and callers keep the stored value, so reads never break.
   */
  private async liveObservationCounts(
    userId: string,
    subjects: Array<{ kind: string; ref: string }>,
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (subjects.length === 0) return counts;

    const uniq = new Map<string, { kind: string; ref: string }>();
    for (const s of subjects) uniq.set(subjectKey(s), s);

    const filters: Record<string, EsQueryContainer> = {};
    for (const [key, s] of uniq) {
      filters[key] = {
        nested: {
          path: 'subjects',
          query: {
            bool: {
              must: [
                { term: { 'subjects.kind': s.kind } },
                { term: { 'subjects.ref': s.ref } },
              ],
            },
          },
        },
      };
    }

    try {
      const resp = await this.client.search({
        index: OBSERVATIONS_INDEX,
        size: 0,
        query: { bool: { filter: [{ term: { user_id: userId } }] } },
        aggs: { per_subject: { filters: { filters } } },
      });
      const buckets =
        (resp.aggregations as {
          per_subject?: { buckets?: Record<string, { doc_count?: number }> };
        })?.per_subject?.buckets ?? {};
      for (const [key, bucket] of Object.entries(buckets)) {
        counts.set(key, bucket.doc_count ?? 0);
      }
    } catch (err) {
      logger.warn(
        '[NarrativeRepository] live observation count failed — falling back to stored count',
        { error: err instanceof Error ? err.message : String(err) },
      );
    }
    return counts;
  }

  /** Overwrite each narrative's observationCount with the live value. */
  private async withLiveCounts(userId: string, narratives: Narrative[]): Promise<Narrative[]> {
    if (narratives.length === 0) return narratives;
    const counts = await this.liveObservationCounts(
      userId,
      narratives.map((n) => n.subject),
    );
    for (const n of narratives) {
      const live = counts.get(subjectKey(n.subject));
      if (live != null) n.observationCount = live;
    }
    return narratives;
  }

  async getBySubject(userId: string, subject: SubjectRef): Promise<Narrative | null> {
    const id = narrativeDocId(userId, subject);
    try {
      const got = await this.client.get<NarrativeDoc>({ index: INDEX, id });
      const src = got._source;
      if (!src || src.user_id !== userId) return null;
      const narrative = docToNarrative(src, id);
      await this.withLiveCounts(userId, [narrative]);
      return narrative;
    } catch (err: unknown) {
      const e = err as { meta?: { statusCode?: number } };
      if (e.meta?.statusCode === 404) return null;
      throw err;
    }
  }

  async list(
    userId: string,
    filters: NarrativeFilters,
  ): Promise<{ items: Narrative[]; total: number }> {
    const filterClauses: EsQueryContainer[] = [];
    const mustClauses: EsQueryContainer[] = [];

    if (filters.status) {
      filterClauses.push({ term: { status: filters.status } });
    }
    if (filters.subjectKind) {
      filterClauses.push({ term: { 'subject.kind': filters.subjectKind } });
    }
    if (filters.participantId) {
      filterClauses.push({ term: { participants: filters.participantId } });
    }
    if (filters.staleForDays != null && filters.staleForDays > 0) {
      const cutoff = new Date(Date.now() - filters.staleForDays * 86_400_000).toISOString();
      filterClauses.push({ range: { last_observed_at: { lte: cutoff } } });
    }
    if (filters.placeId) {
      filterClauses.push({ term: { places: filters.placeId } });
    }
    if (filters.query) {
      mustClauses.push({
        multi_match: {
          query: filters.query,
          fields: ['title^2', 'summary', 'open_threads'],
          fuzziness: 'AUTO',
        },
      });
    }

    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    // Relevance is a composite of recency + live observation volume + status, so
    // it can't be expressed as a single ES sort key (the live count isn't on the
    // doc). Pull a bounded candidate window by recency, attach live counts, then
    // score + sort + page in-app. Working sets are dozens, so this is cheap and
    // exact. Recency sort stays a pure ES sort (the default, unchanged path).
    if ((filters.sort ?? 'recency') === 'relevance') {
      const CANDIDATE_CAP = 200;
      const { hits, total } = await this.searchDocs<NarrativeDoc>(userId, {
        filters: filterClauses,
        musts: mustClauses,
        size: CANDIDATE_CAP,
        from: 0,
        sort: [{ last_observed_at: { order: 'desc', missing: '_last' } }],
      });
      const candidates = hits
        .filter((h) => h._source != null && h._id != null)
        .map((h) => docToNarrative(h._source!, h._id!));
      await this.withLiveCounts(userId, candidates);
      const now = Date.now();
      candidates.sort((a, b) => narrativeRelevance(b, now) - narrativeRelevance(a, now));
      return { items: candidates.slice(offset, offset + limit), total };
    }

    const { hits, total } = await this.searchDocs<NarrativeDoc>(userId, {
      filters: filterClauses,
      musts: mustClauses,
      size: limit,
      from: offset,
      sort: [{ last_observed_at: { order: 'desc', missing: '_last' } }],
    });

    const items = hits
      .filter((h) => h._source != null && h._id != null)
      .map((h) => docToNarrative(h._source!, h._id!));

    await this.withLiveCounts(userId, items);
    return { items, total };
  }

  async listForParticipant(userId: string, personId: string): Promise<Narrative[]> {
    const { hits } = await this.searchDocs<NarrativeDoc>(userId, {
      filters: [{ term: { participants: personId } }],
      size: 50,
      sort: [{ last_observed_at: { order: 'desc', missing: '_last' } }],
    });

    const items = hits
      .filter((h) => h._source != null && h._id != null)
      .map((h) => docToNarrative(h._source!, h._id!));

    await this.withLiveCounts(userId, items);
    return items;
  }

  /**
   * Subjects that co-occur with `subject` in the same observation, with how many
   * observations they share. This is the strongest "these threads are about the
   * same thing" signal — two subjects tagged on one observation are genuinely
   * linked, not just incidentally near each other. Bounded to the most recent
   * 200 observations; failures degrade to an empty map (connections never break a
   * read). Queries the observations index directly (sibling of liveObservationCounts).
   */
  private async coOccurringSubjects(
    userId: string,
    subject: SubjectRef,
  ): Promise<Map<string, { subject: SubjectRef; count: number }>> {
    const out = new Map<string, { subject: SubjectRef; count: number }>();
    try {
      const resp = await this.client.search<{ subjects?: Array<{ kind: string; ref: string }> }>({
        index: OBSERVATIONS_INDEX,
        size: 200,
        _source: ['subjects'],
        query: {
          bool: {
            filter: [
              { term: { user_id: userId } },
              {
                nested: {
                  path: 'subjects',
                  query: {
                    bool: {
                      must: [
                        { term: { 'subjects.kind': subject.kind } },
                        { term: { 'subjects.ref': subject.ref } },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
        sort: [{ observed_at: { order: 'desc' } }],
      });
      for (const h of resp.hits.hits) {
        for (const s of h._source?.subjects ?? []) {
          if (s.kind === subject.kind && s.ref === subject.ref) continue;
          const key = subjectKey(s);
          const cur = out.get(key);
          if (cur) cur.count += 1;
          else out.set(key, { subject: { kind: s.kind as SubjectRef['kind'], ref: s.ref }, count: 1 });
        }
      }
    } catch (err) {
      logger.warn('[NarrativeRepository] co-occurring subjects query failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return out;
  }

  async getConnections(userId: string, subject: SubjectRef): Promise<NarrativeConnections> {
    const self = await this.getBySubject(userId, subject);
    const participants = self?.participants ?? [];
    const places = self?.places ?? [];
    const selfKey = subjectKey(subject);

    const relatedMap = new Map<string, RelatedNarrative>();
    const addRelated = (n: Narrative, via: ConnectionVia, sharedKey: string, w: number): void => {
      const key = subjectKey(n.subject);
      if (key === selfKey) return;
      let r = relatedMap.get(key);
      if (!r) {
        r = { subject: n.subject, title: n.title, status: n.status, via: [], weight: 0, sharedKeys: [] };
        relatedMap.set(key, r);
      }
      if (!r.via.includes(via)) r.via.push(via);
      if (!r.sharedKeys.includes(sharedKey)) r.sharedKeys.push(sharedKey);
      r.weight += w;
    };

    // shared-participant: any narrative listing a participant in common. If the
    // focus subject IS a person, include narratives where that person participates.
    const participantKeys = new Set(participants);
    if (subject.kind === 'person') participantKeys.add(subject.ref);
    for (const pid of participantKeys) {
      const sibs = await this.listForParticipant(userId, pid);
      for (const s of sibs) addRelated(s, 'shared-participant', pid, 1);
    }

    // shared-place: narratives that touch any of the same places.
    if (places.length > 0) {
      const { hits } = await this.searchDocs<NarrativeDoc>(userId, {
        filters: [{ terms: { places } }],
        size: 100,
        sort: [{ last_observed_at: { order: 'desc', missing: '_last' } }],
      });
      for (const h of hits) {
        if (!h._source || !h._id) continue;
        const n = docToNarrative(h._source, h._id);
        for (const pl of (n.places ?? []).filter((p) => places.includes(p))) {
          addRelated(n, 'shared-place', pl, 1);
        }
      }
    }

    // co-subject: subjects co-tagged on the focus subject's observations that
    // themselves have a narrative.
    const coSubjects = await this.coOccurringSubjects(userId, subject);
    for (const { subject: cs, count } of coSubjects.values()) {
      const n = await this.getBySubject(userId, cs);
      if (n) addRelated(n, 'co-subject', `${cs.kind}:${cs.ref}`, count);
    }

    const entities: EntityNode[] = [
      ...participants.map((p) => ({ kind: 'person' as const, ref: p })),
      ...places.map((p) => ({ kind: 'place' as const, ref: p })),
    ];

    const related = [...relatedMap.values()]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 50);

    return { subject, entities, related };
  }

  async upsert(
    userId: string,
    input: UpsertNarrativeInput,
  ): Promise<{ narrative: Narrative; created: boolean }> {
    const id = narrativeDocId(userId, input.subject);
    const existing = await this.getBySubject(userId, input.subject);
    const created = !existing;

    if (created && !input.title) {
      throw new Error('title is required when creating a new narrative');
    }
    if (input.status === 'closed' && !input.closedReason && !existing?.closedReason) {
      throw new Error('closed_reason is required when transitioning a narrative to closed');
    }

    const doc: NarrativeDoc = {
      user_id: userId,
      subject: { kind: input.subject.kind, ref: input.subject.ref },
      title: input.title ?? existing!.title,
      summary: input.summary ?? existing?.summary ?? '',
      current_mood: input.currentMood ?? existing?.currentMood,
      open_threads: input.openThreads ?? existing?.openThreads ?? [],
      recent_decisions: (input.recentDecisions ?? existing?.recentDecisions ?? []).map((d) => ({
        observed_at: d.observedAt,
        text: d.text,
      })),
      participants: input.participants ?? existing?.participants ?? [],
      places: input.places ?? existing?.places ?? [],
      observation_count: input.observationCount ?? existing?.observationCount ?? 0,
      first_observed_at: input.firstObservedAt ?? existing?.firstObservedAt,
      last_observed_at: input.lastObservedAt ?? existing?.lastObservedAt,
      last_consolidated_at: input.lastConsolidatedAt ?? existing?.lastConsolidatedAt,
      // Sensitivity is bumped (logical OR), never lowered.
      sensitive: (input.sensitive ?? false) || (existing?.sensitive ?? false),
      status: input.status ?? existing?.status ?? 'active',
      closed_reason: input.closedReason ?? existing?.closedReason,
    };

    await this.indexDoc(id, doc as unknown as Record<string, unknown>);
    return { narrative: docToNarrative(doc, id), created };
  }

  async delete(userId: string, subject: SubjectRef): Promise<boolean> {
    const id = narrativeDocId(userId, subject);
    return this.deleteById(userId, id);
  }
}
