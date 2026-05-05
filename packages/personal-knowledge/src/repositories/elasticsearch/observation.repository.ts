import type { Client } from '@elastic/elasticsearch';
import { BaseElasticsearchRepository, type EsQueryContainer } from './base.repository.js';
import type { ObservationRepository } from '../interfaces/observation.repository.js';
import type {
  Observation,
  CreateObservationInput,
  RecallFilters,
  SubjectRef,
} from '../../types/narrative.js';

const INDEX = 'll5_knowledge_observations';

interface ObservationDoc {
  user_id: string;
  subjects: Array<{ kind: string; ref: string }>;
  text: string;
  source: string;
  source_id?: string;
  source_excerpt?: string;
  confidence: string;
  mood?: string;
  sensitive: boolean;
  observed_at: string;
  created_at: string;
}

function docToObservation(doc: ObservationDoc, id: string): Observation {
  return {
    id,
    userId: doc.user_id,
    subjects: (doc.subjects ?? []).map((s) => ({
      kind: s.kind as Observation['subjects'][number]['kind'],
      ref: s.ref,
    })),
    text: doc.text,
    source: doc.source as Observation['source'],
    sourceId: doc.source_id,
    sourceExcerpt: doc.source_excerpt,
    confidence: (doc.confidence ?? 'medium') as Observation['confidence'],
    mood: doc.mood,
    sensitive: doc.sensitive ?? false,
    observedAt: doc.observed_at,
    createdAt: doc.created_at,
  };
}

function subjectsFilter(subjects: SubjectRef[]): EsQueryContainer {
  // Match if observation has ANY of the requested subjects (OR semantics).
  return {
    nested: {
      path: 'subjects',
      query: {
        bool: {
          should: subjects.map((s) => ({
            bool: {
              filter: [
                { term: { 'subjects.kind': s.kind } },
                { term: { 'subjects.ref': s.ref } },
              ],
            },
          })),
          minimum_should_match: 1,
        },
      },
    },
  };
}

export class ElasticsearchObservationRepository
  extends BaseElasticsearchRepository
  implements ObservationRepository
{
  constructor(client: Client) {
    super(client, INDEX);
  }

  async create(userId: string, input: CreateObservationInput): Promise<Observation> {
    const id = this.generateId();
    const now = this.nowISO();
    const doc: ObservationDoc = {
      user_id: userId,
      subjects: input.subjects.map((s) => ({ kind: s.kind, ref: s.ref })),
      text: input.text,
      source: input.source,
      source_id: input.sourceId,
      source_excerpt: input.sourceExcerpt,
      confidence: input.confidence ?? 'medium',
      mood: input.mood,
      sensitive: input.sensitive ?? false,
      observed_at: input.observedAt ?? now,
      created_at: now,
    };

    await this.indexDoc(id, doc as unknown as Record<string, unknown>);
    return docToObservation(doc, id);
  }

  async recall(userId: string, filters: RecallFilters): Promise<Observation[]> {
    const filterClauses: EsQueryContainer[] = [];
    const mustClauses: EsQueryContainer[] = [];

    if (filters.subjects && filters.subjects.length > 0) {
      filterClauses.push(subjectsFilter(filters.subjects));
    }

    if (filters.since) {
      filterClauses.push({ range: { observed_at: { gte: filters.since } } });
    }

    if (filters.query) {
      mustClauses.push({
        multi_match: {
          query: filters.query,
          fields: ['text', 'source_excerpt'],
          fuzziness: 'AUTO',
        },
      });
    }

    const { hits } = await this.searchDocs<ObservationDoc>(userId, {
      filters: filterClauses,
      musts: mustClauses,
      size: filters.limit ?? 30,
      sort: [{ observed_at: { order: 'desc' } }],
    });

    return hits
      .filter((h) => h._source != null && h._id != null)
      .map((h) => docToObservation(h._source!, h._id!));
  }

  async statsForSubject(
    userId: string,
    subject: SubjectRef,
  ): Promise<{
    count: number;
    firstObservedAt?: string;
    lastObservedAt?: string;
    sensitive: boolean;
  }> {
    const query: EsQueryContainer = {
      bool: {
        filter: [{ term: { user_id: userId } }, subjectsFilter([subject])],
      },
    };

    const response = await this.client.search({
      index: INDEX,
      query,
      size: 0,
      aggs: {
        first_seen: { min: { field: 'observed_at' } },
        last_seen: { max: { field: 'observed_at' } },
        any_sensitive: { max: { field: 'sensitive' } },
      },
      track_total_hits: true,
    });

    const total = response.hits.total;
    const count = typeof total === 'number' ? total : (total?.value ?? 0);
    type AggBucket = { value?: number | null; value_as_string?: string };
    const aggs = (response.aggregations ?? {}) as Record<string, AggBucket>;
    const firstAgg = aggs.first_seen;
    const lastAgg = aggs.last_seen;
    const sensitiveAgg = aggs.any_sensitive;

    return {
      count,
      firstObservedAt: firstAgg?.value_as_string ?? undefined,
      lastObservedAt: lastAgg?.value_as_string ?? undefined,
      sensitive: (sensitiveAgg?.value ?? 0) > 0,
    };
  }

  async listForSubject(
    userId: string,
    subject: SubjectRef,
    opts?: { since?: string; limit?: number },
  ): Promise<Observation[]> {
    const filterClauses: EsQueryContainer[] = [subjectsFilter([subject])];
    if (opts?.since) {
      filterClauses.push({ range: { observed_at: { gte: opts.since } } });
    }

    const { hits } = await this.searchDocs<ObservationDoc>(userId, {
      filters: filterClauses,
      size: opts?.limit ?? 200,
      sort: [{ observed_at: { order: 'asc' } }],
    });

    return hits
      .filter((h) => h._source != null && h._id != null)
      .map((h) => docToObservation(h._source!, h._id!));
  }

  async delete(userId: string, id: string): Promise<boolean> {
    return this.deleteById(userId, id);
  }
}
