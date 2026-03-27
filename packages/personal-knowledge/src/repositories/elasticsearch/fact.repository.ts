import type { Client } from '@elastic/elasticsearch';
import type { FactRepository } from '../interfaces/fact.repository.js';
import type { Fact, FactFilters, UpsertFactInput } from '../../types/fact.js';
import type { PaginationParams, PaginatedResult, SearchResult } from '../../types/search.js';
import { BaseElasticsearchRepository } from './base.repository.js';
import type { EsQueryContainer } from './base.repository.js';

interface FactDoc {
  user_id: string;
  type: string;
  category: string;
  content: string;
  provenance: string;
  confidence: number;
  tags: string[];
  source?: string;
  valid_from?: string;
  valid_until?: string;
  created_at: string;
  updated_at: string;
}

function docToFact(doc: FactDoc, id: string): Fact {
  return {
    id,
    userId: doc.user_id,
    type: doc.type as Fact['type'],
    category: doc.category,
    content: doc.content,
    provenance: doc.provenance as Fact['provenance'],
    confidence: doc.confidence,
    tags: doc.tags ?? [],
    source: doc.source,
    validFrom: doc.valid_from,
    validUntil: doc.valid_until,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

export class ElasticsearchFactRepository
  extends BaseElasticsearchRepository
  implements FactRepository
{
  constructor(client: Client) {
    super(client, 'll5_knowledge_facts');
  }

  async list(
    userId: string,
    filters: FactFilters & PaginationParams,
  ): Promise<PaginatedResult<Fact>> {
    const filterClauses: EsQueryContainer[] = [];
    const mustClauses: EsQueryContainer[] = [];

    if (filters.type) {
      filterClauses.push({ term: { type: filters.type } });
    }
    if (filters.category) {
      filterClauses.push({ term: { category: filters.category } });
    }
    if (filters.provenance) {
      filterClauses.push({ term: { provenance: filters.provenance } });
    }
    if (filters.tags && filters.tags.length > 0) {
      for (const tag of filters.tags) {
        filterClauses.push({ term: { tags: tag } });
      }
    }
    if (filters.minConfidence !== undefined) {
      filterClauses.push({ range: { confidence: { gte: filters.minConfidence } } });
    }
    if (filters.query) {
      mustClauses.push({
        multi_match: {
          query: filters.query,
          fields: ['content'],
          fuzziness: 'AUTO',
        },
      });
    }

    const { hits, total } = await this.searchDocs<FactDoc>(userId, {
      filters: filterClauses,
      musts: mustClauses,
      size: filters.limit ?? 50,
      from: filters.offset ?? 0,
      sort: mustClauses.length > 0 ? undefined : [{ updated_at: { order: 'desc' } }],
    });

    return {
      items: hits.map((h) => docToFact(h._source!, h._id!)),
      total,
    };
  }

  async get(userId: string, id: string): Promise<Fact | null> {
    const doc = await this.getById<FactDoc>(userId, id);
    if (!doc) return null;
    return docToFact(doc as FactDoc, (doc as FactDoc & { id: string }).id ?? id);
  }

  async upsert(
    userId: string,
    data: UpsertFactInput,
  ): Promise<{ fact: Fact; created: boolean }> {
    const now = this.nowISO();
    const isCreate = !data.id;
    const id = data.id ?? this.generateId();

    let existingDoc: FactDoc | undefined;
    if (!isCreate) {
      const existing = await this.getById<FactDoc & { id: string }>(userId, id);
      if (existing) {
        existingDoc = existing as unknown as FactDoc;
      }
    }

    const doc: FactDoc = {
      user_id: userId,
      type: data.type,
      category: data.category,
      content: data.content,
      provenance: data.provenance,
      confidence: data.confidence,
      tags: data.tags ?? existingDoc?.tags ?? [],
      source: data.source ?? existingDoc?.source,
      valid_from: data.validFrom ?? existingDoc?.valid_from,
      valid_until: data.validUntil ?? existingDoc?.valid_until,
      created_at: existingDoc?.created_at ?? now,
      updated_at: now,
    };

    await this.indexDoc(id, doc as unknown as Record<string, unknown>);
    const created = !existingDoc;

    return { fact: docToFact(doc, id), created };
  }

  async delete(userId: string, id: string): Promise<boolean> {
    return this.deleteById(userId, id);
  }

  async search(
    userId: string,
    query: string,
    limit: number = 20,
  ): Promise<SearchResult<Fact>[]> {
    const { hits } = await this.searchDocs<FactDoc>(userId, {
      query: {
        bool: {
          filter: [this.userFilter(userId)],
          must: [
            {
              multi_match: {
                query,
                fields: ['content'],
                fuzziness: 'AUTO',
              },
            },
          ],
        },
      },
      size: limit,
      highlight: {
        fields: { content: {} },
        pre_tags: ['<em>'],
        post_tags: ['</em>'],
      },
    });

    return hits.map((hit) => {
      const fact = docToFact(hit._source!, hit._id!);
      const highlights = (hit.highlight as Record<string, string[]> | undefined);
      const highlight = highlights?.content?.[0] ?? fact.content;
      const maxScore = hits[0]?._score ?? 1;
      return {
        entityType: 'fact' as const,
        entityId: fact.id,
        score: (hit._score ?? 0) / (maxScore || 1),
        highlight,
        summary: fact.content.length > 120 ? fact.content.slice(0, 120) + '...' : fact.content,
        data: fact,
      };
    });
  }
}
