import type { Client } from '@elastic/elasticsearch';
import { BaseElasticsearchRepository } from './base.repository.js';
import type { EsQueryContainer } from './base.repository.js';
import type { NotificationRepository, NotificationQueryParams, NotificationRecord } from '../interfaces/notification.repository.js';

const INDEX = 'll5_awareness_notifications';

interface NotificationDoc {
  user_id: string;
  package: string;
  app_label?: string | null;
  title?: string | null;
  text?: string | null;
  big_text?: string | null;
  category?: string | null;
  channel_id?: string | null;
  ongoing?: boolean;
  posted_at: string;
  received_at: string;
  removed_at?: string | null;
}

function toRecord(id: string, d: NotificationDoc): NotificationRecord {
  return {
    id,
    package: d.package,
    app_label: d.app_label ?? null,
    title: d.title ?? null,
    text: d.text ?? null,
    big_text: d.big_text ?? null,
    category: d.category ?? null,
    channel_id: d.channel_id ?? null,
    ongoing: !!d.ongoing,
    posted_at: d.posted_at,
    received_at: d.received_at,
    removed_at: d.removed_at ?? null,
  };
}

export class ElasticsearchNotificationRepository
  extends BaseElasticsearchRepository
  implements NotificationRepository
{
  constructor(client: Client) {
    super(client, INDEX);
  }

  async query(userId: string, params: NotificationQueryParams): Promise<NotificationRecord[]> {
    const filters: EsQueryContainer[] = [];
    const musts: EsQueryContainer[] = [];

    const range: Record<string, string> = {};
    range.gte = params.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    if (params.until) range.lte = params.until;
    filters.push({ range: { received_at: range } });

    if (params.package) filters.push({ term: { package: params.package } });
    if (!params.include_ongoing) filters.push({ bool: { must_not: [{ term: { ongoing: true } }] } });
    if (params.app) musts.push({ match: { app_label: { query: params.app, fuzziness: 'AUTO' } } });
    if (params.search) {
      musts.push({ multi_match: { query: params.search, fields: ['title^2', 'text', 'big_text'], fuzziness: 'AUTO' } });
    }

    const hasTextQuery = musts.length > 0;
    const sort: Array<Record<string, unknown>> = hasTextQuery
      ? [{ _score: { order: 'desc' } }, { received_at: { order: 'desc' } }]
      : [{ received_at: { order: 'desc' } }];

    const { hits } = await this.searchDocs<NotificationDoc>(userId, {
      filters, musts, size: params.limit ?? 50, from: params.offset ?? 0, sort,
    });
    return hits.filter((h) => h._source != null).map((h) => toRecord(h._id!, h._source!));
  }

  async recent(userId: string, since: string, limit: number): Promise<NotificationRecord[]> {
    const { hits } = await this.searchDocs<NotificationDoc>(userId, {
      filters: [
        { range: { received_at: { gte: since } } },
        { bool: { must_not: [{ term: { ongoing: true } }] } },
      ],
      size: limit,
      sort: [{ received_at: { order: 'desc' } }],
    });
    return hits.filter((h) => h._source != null).map((h) => toRecord(h._id!, h._source!));
  }
}
