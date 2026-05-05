import type { Client } from '@elastic/elasticsearch';
import { BaseElasticsearchRepository, type EsQueryContainer } from './base.repository.js';
import type { NarrativeRepository } from '../interfaces/narrative.repository.js';
import {
  type Narrative,
  type NarrativeFilters,
  type SubjectRef,
  type UpsertNarrativeInput,
  narrativeDocId,
} from '../../types/narrative.js';

const INDEX = 'll5_knowledge_narratives';

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

  async getBySubject(userId: string, subject: SubjectRef): Promise<Narrative | null> {
    const id = narrativeDocId(userId, subject);
    try {
      const got = await this.client.get<NarrativeDoc>({ index: INDEX, id });
      const src = got._source;
      if (!src || src.user_id !== userId) return null;
      return docToNarrative(src, id);
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
    if (filters.query) {
      mustClauses.push({
        multi_match: {
          query: filters.query,
          fields: ['title^2', 'summary', 'open_threads'],
          fuzziness: 'AUTO',
        },
      });
    }

    const { hits, total } = await this.searchDocs<NarrativeDoc>(userId, {
      filters: filterClauses,
      musts: mustClauses,
      size: filters.limit ?? 50,
      from: filters.offset ?? 0,
      sort: [{ last_observed_at: { order: 'desc', missing: '_last' } }],
    });

    const items = hits
      .filter((h) => h._source != null && h._id != null)
      .map((h) => docToNarrative(h._source!, h._id!));

    return { items, total };
  }

  async listForParticipant(userId: string, personId: string): Promise<Narrative[]> {
    const { hits } = await this.searchDocs<NarrativeDoc>(userId, {
      filters: [{ term: { participants: personId } }],
      size: 50,
      sort: [{ last_observed_at: { order: 'desc', missing: '_last' } }],
    });

    return hits
      .filter((h) => h._source != null && h._id != null)
      .map((h) => docToNarrative(h._source!, h._id!));
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
