import type { Client } from '@elastic/elasticsearch';
import type { PersonRepository } from '../interfaces/person.repository.js';
import type { Person, PersonFilters, UpsertPersonInput } from '../../types/person.js';
import type { PaginationParams, PaginatedResult, SearchResult } from '../../types/search.js';
import { BaseElasticsearchRepository } from './base.repository.js';
import type { EsQueryContainer } from './base.repository.js';

interface PersonDoc {
  user_id: string;
  name: string;
  aliases: string[];
  relationship: string;
  contact_info?: Record<string, string>;
  tags: string[];
  notes?: string;
  created_at: string;
  updated_at: string;
}

function docToPerson(doc: PersonDoc, id: string): Person {
  return {
    id,
    userId: doc.user_id,
    name: doc.name,
    aliases: doc.aliases ?? [],
    relationship: doc.relationship ?? '',
    contactInfo: doc.contact_info,
    tags: doc.tags ?? [],
    notes: doc.notes,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

export class ElasticsearchPersonRepository
  extends BaseElasticsearchRepository
  implements PersonRepository
{
  constructor(client: Client) {
    super(client, 'll5_knowledge_people');
  }

  async list(
    userId: string,
    filters: PersonFilters & PaginationParams,
  ): Promise<PaginatedResult<Person>> {
    const filterClauses: EsQueryContainer[] = [];
    const mustClauses: EsQueryContainer[] = [];

    if (filters.relationship) {
      filterClauses.push({ term: { relationship: filters.relationship } });
    }
    if (filters.tags && filters.tags.length > 0) {
      for (const tag of filters.tags) {
        filterClauses.push({ term: { tags: tag } });
      }
    }
    if (filters.query) {
      mustClauses.push({
        multi_match: {
          query: filters.query,
          fields: ['name', 'aliases', 'notes'],
          fuzziness: 'AUTO',
        },
      });
    }

    const { hits, total } = await this.searchDocs<PersonDoc>(userId, {
      filters: filterClauses,
      musts: mustClauses,
      size: filters.limit ?? 50,
      from: filters.offset ?? 0,
      sort: mustClauses.length > 0 ? undefined : [{ updated_at: { order: 'desc' } }],
    });

    return {
      items: hits.map((h) => docToPerson(h._source!, h._id!)),
      total,
    };
  }

  async get(userId: string, id: string): Promise<Person | null> {
    const doc = await this.getById<PersonDoc>(userId, id);
    if (!doc) return null;
    return docToPerson(doc as PersonDoc, (doc as PersonDoc & { id: string }).id ?? id);
  }

  async upsert(
    userId: string,
    data: UpsertPersonInput,
  ): Promise<{ person: Person; created: boolean }> {
    const now = this.nowISO();
    const isCreate = !data.id;
    const id = data.id ?? this.generateId();

    let existingDoc: PersonDoc | undefined;
    if (!isCreate) {
      const existing = await this.getById<PersonDoc & { id: string }>(userId, id);
      if (existing) {
        existingDoc = existing as unknown as PersonDoc;
      }
    }

    const doc: PersonDoc = {
      user_id: userId,
      name: data.name,
      aliases: data.aliases ?? existingDoc?.aliases ?? [],
      relationship: data.relationship ?? existingDoc?.relationship ?? '',
      contact_info: data.contactInfo ?? existingDoc?.contact_info,
      tags: data.tags ?? existingDoc?.tags ?? [],
      notes: data.notes ?? existingDoc?.notes,
      created_at: existingDoc?.created_at ?? now,
      updated_at: now,
    };

    await this.indexDoc(id, doc as unknown as Record<string, unknown>);
    const created = !existingDoc;

    return { person: docToPerson(doc, id), created };
  }

  async delete(userId: string, id: string): Promise<boolean> {
    return this.deleteById(userId, id);
  }

  async search(
    userId: string,
    query: string,
    limit: number = 20,
  ): Promise<SearchResult<Person>[]> {
    const { hits } = await this.searchDocs<PersonDoc>(userId, {
      query: {
        bool: {
          filter: [this.userFilter(userId)],
          must: [
            {
              multi_match: {
                query,
                fields: ['name^2', 'aliases^2', 'notes'],
                fuzziness: 'AUTO',
              },
            },
          ],
        },
      },
      size: limit,
      highlight: {
        fields: { name: {}, aliases: {}, notes: {} },
        pre_tags: ['<em>'],
        post_tags: ['</em>'],
      },
    });

    return hits.map((hit) => {
      const person = docToPerson(hit._source!, hit._id!);
      const highlights = (hit.highlight as Record<string, string[]> | undefined);
      const highlight =
        highlights?.name?.[0] ??
        highlights?.aliases?.[0] ??
        highlights?.notes?.[0] ??
        person.name;
      const maxScore = hits[0]?._score ?? 1;
      return {
        entityType: 'person' as const,
        entityId: person.id,
        score: (hit._score ?? 0) / (maxScore || 1),
        highlight,
        summary: `${person.name}${person.relationship ? ' (' + person.relationship + ')' : ''}`,
        data: person,
      };
    });
  }
}
