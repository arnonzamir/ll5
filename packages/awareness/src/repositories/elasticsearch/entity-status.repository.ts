import type { Client } from '@elastic/elasticsearch';
import { BaseElasticsearchRepository } from './base.repository.js';
import type { EsQueryContainer } from './base.repository.js';
import type { EntityStatusRepository } from '../interfaces/entity-status.repository.js';
import type { EntityStatus } from '../../types/entity-status.js';

const INDEX = 'll5_awareness_entity_statuses';

interface EntityStatusDoc {
  user_id: string;
  entity_name: string;
  summary: string;
  location?: string;
  activity?: string;
  source?: string;
  source_message_id?: string;
  timestamp: string;
}

export class ElasticsearchEntityStatusRepository
  extends BaseElasticsearchRepository
  implements EntityStatusRepository
{
  constructor(client: Client) {
    super(client, INDEX);
  }

  async getByName(userId: string, entityName: string): Promise<EntityStatus | null> {
    const { hits } = await this.searchDocs<EntityStatusDoc>(userId, {
      musts: [
        {
          match: {
            entity_name: {
              query: entityName,
              fuzziness: 'AUTO',
            },
          },
        },
      ],
      size: 1,
      sort: [{ timestamp: { order: 'desc' } }],
    });

    if (hits.length === 0 || !hits[0]?._source) return null;
    return this.mapToEntityStatus(hits[0]._id!, hits[0]._source, userId);
  }

  async listRecent(
    userId: string,
    params: { since?: string; limit?: number },
  ): Promise<EntityStatus[]> {
    const filters: EsQueryContainer[] = [];

    if (params.since) {
      filters.push({ range: { timestamp: { gte: params.since } } });
    } else {
      // Default: 24h ago
      filters.push({
        range: {
          timestamp: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() },
        },
      });
    }

    const { hits } = await this.searchDocs<EntityStatusDoc>(userId, {
      filters,
      size: params.limit ?? 20,
      sort: [{ timestamp: { order: 'desc' } }],
    });

    return hits
      .filter((h) => h._source != null)
      .map((h) => this.mapToEntityStatus(h._id!, h._source!, userId));
  }

  async upsert(
    userId: string,
    data: {
      entityName: string;
      summary: string;
      location?: string;
      activity?: string;
      source?: string;
      timestamp: string;
    },
  ): Promise<EntityStatus> {
    const id = this.generateId();
    const doc: EntityStatusDoc = {
      user_id: userId,
      entity_name: data.entityName,
      summary: data.summary,
      location: data.location,
      activity: data.activity,
      source: data.source,
      timestamp: data.timestamp,
    };

    await this.indexDoc(id, doc as unknown as Record<string, unknown>);

    return {
      id,
      userId,
      entityName: data.entityName,
      summary: data.summary,
      location: data.location,
      activity: data.activity,
      source: data.source,
      timestamp: data.timestamp,
    };
  }

  private mapToEntityStatus(id: string, doc: EntityStatusDoc, userId: string): EntityStatus {
    return {
      id,
      userId,
      entityName: doc.entity_name,
      summary: doc.summary,
      location: doc.location,
      activity: doc.activity,
      source: doc.source,
      timestamp: doc.timestamp,
    };
  }
}
