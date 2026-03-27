import type { Client } from '@elastic/elasticsearch';
import type { PlaceRepository } from '../interfaces/place.repository.js';
import type { Place, PlaceFilters, UpsertPlaceInput } from '../../types/place.js';
import type { PaginationParams, PaginatedResult, SearchResult } from '../../types/search.js';
import { BaseElasticsearchRepository } from './base.repository.js';
import type { EsQueryContainer } from './base.repository.js';

interface PlaceDoc {
  user_id: string;
  name: string;
  type: string;
  address?: string;
  geo?: { lat: number; lon: number };
  tags: string[];
  notes?: string;
  created_at: string;
  updated_at: string;
}

function docToPlace(doc: PlaceDoc, id: string): Place {
  return {
    id,
    userId: doc.user_id,
    name: doc.name,
    type: doc.type as Place['type'],
    address: doc.address,
    geo: doc.geo,
    tags: doc.tags ?? [],
    notes: doc.notes,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

export class ElasticsearchPlaceRepository
  extends BaseElasticsearchRepository
  implements PlaceRepository
{
  constructor(client: Client) {
    super(client, 'll5_knowledge_places');
  }

  async list(
    userId: string,
    filters: PlaceFilters & PaginationParams,
  ): Promise<PaginatedResult<Place>> {
    const filterClauses: EsQueryContainer[] = [];
    const mustClauses: EsQueryContainer[] = [];

    if (filters.type) {
      filterClauses.push({ term: { type: filters.type } });
    }
    if (filters.tags && filters.tags.length > 0) {
      for (const tag of filters.tags) {
        filterClauses.push({ term: { tags: tag } });
      }
    }
    if (filters.near) {
      filterClauses.push({
        geo_distance: {
          distance: `${filters.near.radiusKm}km`,
          geo: { lat: filters.near.lat, lon: filters.near.lon },
        },
      } as unknown as EsQueryContainer);
    }
    if (filters.query) {
      mustClauses.push({
        multi_match: {
          query: filters.query,
          fields: ['name', 'address', 'notes'],
          fuzziness: 'AUTO',
        },
      });
    }

    const sort: Array<Record<string, unknown>> = [];
    if (filters.near) {
      sort.push({
        _geo_distance: {
          geo: { lat: filters.near.lat, lon: filters.near.lon },
          order: 'asc',
          unit: 'km',
        },
      });
    } else if (mustClauses.length === 0) {
      sort.push({ updated_at: { order: 'desc' } });
    }

    const { hits, total } = await this.searchDocs<PlaceDoc>(userId, {
      filters: filterClauses,
      musts: mustClauses,
      size: filters.limit ?? 50,
      from: filters.offset ?? 0,
      sort: sort.length > 0 ? sort : undefined,
    });

    return {
      items: hits.map((h) => docToPlace(h._source!, h._id!)),
      total,
    };
  }

  async get(userId: string, id: string): Promise<Place | null> {
    const doc = await this.getById<PlaceDoc>(userId, id);
    if (!doc) return null;
    return docToPlace(doc as PlaceDoc, (doc as PlaceDoc & { id: string }).id ?? id);
  }

  async upsert(
    userId: string,
    data: UpsertPlaceInput,
  ): Promise<{ place: Place; created: boolean }> {
    const now = this.nowISO();
    const isCreate = !data.id;
    const id = data.id ?? this.generateId();

    let existingDoc: PlaceDoc | undefined;
    if (!isCreate) {
      const existing = await this.getById<PlaceDoc & { id: string }>(userId, id);
      if (existing) {
        existingDoc = existing as unknown as PlaceDoc;
      }
    }

    const doc: PlaceDoc = {
      user_id: userId,
      name: data.name,
      type: data.type,
      address: data.address ?? existingDoc?.address,
      geo: data.geo ?? existingDoc?.geo,
      tags: data.tags ?? existingDoc?.tags ?? [],
      notes: data.notes ?? existingDoc?.notes,
      created_at: existingDoc?.created_at ?? now,
      updated_at: now,
    };

    await this.indexDoc(id, doc as unknown as Record<string, unknown>);
    const created = !existingDoc;

    return { place: docToPlace(doc, id), created };
  }

  async delete(userId: string, id: string): Promise<boolean> {
    return this.deleteById(userId, id);
  }

  async search(
    userId: string,
    query: string,
    limit: number = 20,
  ): Promise<SearchResult<Place>[]> {
    const { hits } = await this.searchDocs<PlaceDoc>(userId, {
      query: {
        bool: {
          filter: [this.userFilter(userId)],
          must: [
            {
              multi_match: {
                query,
                fields: ['name^2', 'address', 'notes'],
                fuzziness: 'AUTO',
              },
            },
          ],
        },
      },
      size: limit,
      highlight: {
        fields: { name: {}, address: {}, notes: {} },
        pre_tags: ['<em>'],
        post_tags: ['</em>'],
      },
    });

    return hits.map((hit) => {
      const place = docToPlace(hit._source!, hit._id!);
      const highlights = (hit.highlight as Record<string, string[]> | undefined);
      const highlight =
        highlights?.name?.[0] ??
        highlights?.address?.[0] ??
        highlights?.notes?.[0] ??
        place.name;
      const maxScore = hits[0]?._score ?? 1;
      return {
        entityType: 'place' as const,
        entityId: place.id,
        score: (hit._score ?? 0) / (maxScore || 1),
        highlight,
        summary: `${place.name} (${place.type})${place.address ? ' - ' + place.address : ''}`,
        data: place,
      };
    });
  }
}
