import type { Client } from '@elastic/elasticsearch';
import { BaseElasticsearchRepository } from './base.repository.js';
import type { EsQueryContainer } from './base.repository.js';
import type { MessageRepository, MessageQueryParams } from '../interfaces/message.repository.js';
import type { PushMessage } from '../../types/message.js';
import type { MessageSearchResult } from '../../types/message.js';

const INDEX = 'll5_awareness_messages';

interface MessageDoc {
  user_id: string;
  sender: string;
  app: string;
  content: string;
  conversation_id?: string;
  conversation_name?: string;
  is_group: boolean;
  processed: boolean;
  timestamp: string;
}

export class ElasticsearchMessageRepository
  extends BaseElasticsearchRepository
  implements MessageRepository
{
  constructor(client: Client) {
    super(client, INDEX);
  }

  async query(userId: string, params: MessageQueryParams): Promise<MessageSearchResult[]> {
    const filters: EsQueryContainer[] = [];
    const musts: EsQueryContainer[] = [];

    // Time range
    const range: Record<string, string> = {};
    if (params.from) {
      range.gte = params.from;
    } else {
      // Default: 24h ago
      range.gte = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    }
    if (params.to) {
      range.lte = params.to;
    }
    filters.push({ range: { timestamp: range } });

    if (params.app) {
      filters.push({ term: { app: params.app } });
    }

    if (params.conversation_id) {
      filters.push({ term: { conversation_id: params.conversation_id } });
    }

    if (params.is_group !== undefined) {
      filters.push({ term: { is_group: params.is_group } });
    }

    // Fuzzy sender match
    if (params.sender) {
      musts.push({
        match: {
          sender: {
            query: params.sender,
            fuzziness: 'AUTO',
          },
        },
      });
    }

    // Full-text keyword search on content
    if (params.keyword) {
      musts.push({
        match: {
          content: {
            query: params.keyword,
            fuzziness: 'AUTO',
          },
        },
      });
    }

    const hasTextQuery = musts.length > 0;

    const sort: Array<Record<string, unknown>> = hasTextQuery
      ? [{ _score: { order: 'desc' } }, { timestamp: { order: 'desc' } }]
      : [{ timestamp: { order: 'desc' } }];

    const { hits } = await this.searchDocs<MessageDoc>(userId, {
      filters,
      musts,
      size: params.limit ?? 50,
      sort,
    });

    return hits
      .filter((h) => h._source != null)
      .map((h) => ({
        id: h._id!,
        timestamp: h._source!.timestamp,
        sender: h._source!.sender,
        app: h._source!.app,
        content: h._source!.content,
        conversation_id: h._source!.conversation_id ?? null,
        conversation_name: h._source!.conversation_name ?? null,
        is_group: h._source!.is_group,
        relevance_score: hasTextQuery ? (h._score ?? null) : null,
      }));
  }

  async create(
    userId: string,
    data: {
      sender: string;
      app: string;
      content: string;
      conversation_id?: string;
      conversation_name?: string;
      is_group?: boolean;
      timestamp: string;
    },
  ): Promise<PushMessage> {
    const id = this.generateId();
    const doc: MessageDoc = {
      user_id: userId,
      sender: data.sender,
      app: data.app,
      content: data.content,
      conversation_id: data.conversation_id,
      conversation_name: data.conversation_name,
      is_group: data.is_group ?? false,
      processed: false,
      timestamp: data.timestamp,
    };

    await this.indexDoc(id, doc as unknown as Record<string, unknown>);

    return {
      id,
      userId,
      sender: data.sender,
      app: data.app,
      content: data.content,
      processed: false,
      timestamp: data.timestamp,
    };
  }

  async countActiveConversations(userId: string, since: string): Promise<number> {
    const response = await this.client.search({
      index: this.index,
      size: 0,
      query: this.buildBoolQuery(userId, [
        { range: { timestamp: { gte: since } } },
      ]),
      aggs: {
        unique_conversations: {
          cardinality: {
            field: 'conversation_id',
          },
        },
      },
    });

    const aggs = response.aggregations as Record<string, { value?: number }> | undefined;
    return aggs?.unique_conversations?.value ?? 0;
  }
}
