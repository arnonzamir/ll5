import type { Client } from '@elastic/elasticsearch';
import type { DataGapRepository } from '../interfaces/data-gap.repository.js';
import type { DataGap, DataGapFilters, UpsertDataGapInput } from '../../types/data-gap.js';
import type { PaginationParams, PaginatedResult } from '../../types/search.js';
import { BaseElasticsearchRepository } from './base.repository.js';
import type { EsQueryContainer } from './base.repository.js';

interface DataGapDoc {
  user_id: string;
  question: string;
  priority: number;
  status: string;
  context?: string;
  answer?: string;
  created_at: string;
  updated_at: string;
}

function docToDataGap(doc: DataGapDoc, id: string): DataGap {
  return {
    id,
    userId: doc.user_id,
    question: doc.question,
    priority: doc.priority,
    status: doc.status as DataGap['status'],
    context: doc.context,
    answer: doc.answer,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

export class ElasticsearchDataGapRepository
  extends BaseElasticsearchRepository
  implements DataGapRepository
{
  constructor(client: Client) {
    super(client, 'll5_knowledge_data_gaps');
  }

  async list(
    userId: string,
    filters: DataGapFilters & PaginationParams,
  ): Promise<PaginatedResult<DataGap>> {
    const filterClauses: EsQueryContainer[] = [];

    if (filters.status) {
      filterClauses.push({ term: { status: filters.status } });
    }
    if (filters.minPriority !== undefined) {
      filterClauses.push({ range: { priority: { gte: filters.minPriority } } });
    }

    const { hits, total } = await this.searchDocs<DataGapDoc>(userId, {
      filters: filterClauses,
      size: filters.limit ?? 50,
      from: filters.offset ?? 0,
      sort: [{ priority: { order: 'desc' } }, { updated_at: { order: 'desc' } }],
    });

    return {
      items: hits.map((h) => docToDataGap(h._source!, h._id!)),
      total,
    };
  }

  async get(userId: string, id: string): Promise<DataGap | null> {
    const doc = await this.getById<DataGapDoc>(userId, id);
    if (!doc) return null;
    return docToDataGap(doc as DataGapDoc, (doc as DataGapDoc & { id: string }).id ?? id);
  }

  async upsert(
    userId: string,
    data: UpsertDataGapInput,
  ): Promise<{ dataGap: DataGap; created: boolean }> {
    const now = this.nowISO();
    const isCreate = !data.id;
    const id = data.id ?? this.generateId();

    let existingDoc: DataGapDoc | undefined;
    if (!isCreate) {
      const existing = await this.getById<DataGapDoc & { id: string }>(userId, id);
      if (existing) {
        existingDoc = existing as unknown as DataGapDoc;
      }
    }

    const doc: DataGapDoc = {
      user_id: userId,
      question: data.question ?? existingDoc?.question ?? '',
      priority: data.priority ?? existingDoc?.priority ?? 5,
      status: data.status ?? existingDoc?.status ?? 'open',
      context: data.context ?? existingDoc?.context,
      answer: data.answer ?? existingDoc?.answer,
      created_at: existingDoc?.created_at ?? now,
      updated_at: now,
    };

    await this.indexDoc(id, doc as unknown as Record<string, unknown>);
    const created = !existingDoc;

    return { dataGap: docToDataGap(doc, id), created };
  }
}
