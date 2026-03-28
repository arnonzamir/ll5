import type { Client } from '@elastic/elasticsearch';
import { BaseElasticsearchRepository } from './base.repository.js';
import type { EsQueryContainer } from './base.repository.js';
import type {
  NotableEventRepository,
  NotableEventQueryParams,
} from '../interfaces/notable-event.repository.js';
import type { NotableEvent } from '../../types/notable-event.js';
import { NotableEventType, SEVERITY_ORDER } from '../../types/notable-event.js';

const INDEX = 'll5_awareness_notable_events';

interface NotableEventDoc {
  user_id: string;
  event_type: string;
  summary: string;
  severity: string;
  payload: Record<string, unknown>;
  acknowledged: boolean;
  acknowledged_at?: string;
  created_at: string;
}

export class ElasticsearchNotableEventRepository
  extends BaseElasticsearchRepository
  implements NotableEventRepository
{
  constructor(client: Client) {
    super(client, INDEX);
  }

  async create(
    userId: string,
    data: {
      event_type: string;
      summary: string;
      severity: string;
      payload: Record<string, unknown>;
      created_at: string;
    },
  ): Promise<string> {
    const id = this.generateId();
    const doc: NotableEventDoc = {
      user_id: userId,
      event_type: data.event_type,
      summary: data.summary,
      severity: data.severity,
      payload: data.payload,
      acknowledged: false,
      created_at: data.created_at,
    };

    await this.indexDoc(id, doc as unknown as Record<string, unknown>);
    return id;
  }

  async queryUnacknowledged(
    userId: string,
    params: NotableEventQueryParams,
  ): Promise<NotableEvent[]> {
    const filters: EsQueryContainer[] = [
      { term: { acknowledged: false } },
    ];

    if (params.since) {
      filters.push({ range: { created_at: { gte: params.since } } });
    } else {
      // Default: 1h ago
      filters.push({
        range: {
          created_at: { gte: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
        },
      });
    }

    if (params.event_type) {
      filters.push({ term: { event_type: params.event_type } });
    }

    const { hits } = await this.searchDocs<NotableEventDoc>(userId, {
      filters,
      size: 100,
      sort: [{ created_at: { order: 'desc' } }],
    });

    let results = hits
      .filter((h) => h._source != null)
      .map((h) => this.mapToNotableEvent(h._id!, h._source!, userId));

    // Filter by minimum severity
    if (params.min_severity) {
      const minLevel = SEVERITY_ORDER[params.min_severity] ?? 0;
      results = results.filter((e) => {
        const details = e.details as Record<string, unknown> | undefined;
        const severity = (details?.severity as string) ?? 'low';
        return (SEVERITY_ORDER[severity] ?? 0) >= minLevel;
      });
    }

    return results;
  }

  async acknowledge(userId: string, eventIds: string[]): Promise<number> {
    if (eventIds.length === 0) return 0;

    const now = this.nowISO();

    const updated = await this.updateByQuery(
      {
        bool: {
          filter: [
            { term: { user_id: userId } },
            { terms: { _id: eventIds } },
            { term: { acknowledged: false } },
          ],
        },
      },
      {
        source: 'ctx._source.acknowledged = true; ctx._source.acknowledged_at = params.now;',
        params: { now },
      },
    );

    return updated;
  }

  private mapToNotableEvent(id: string, doc: NotableEventDoc, userId: string): NotableEvent {
    // Map the string event_type back to the enum
    const typeMap: Record<string, NotableEventType> = {
      location_change: NotableEventType.LOCATION_CHANGE,
      message_important: NotableEventType.MESSAGE_IMPORTANT,
      calendar_upcoming: NotableEventType.CALENDAR_UPCOMING,
      entity_status_change: NotableEventType.ENTITY_STATUS_CHANGE,
      overdue_item: NotableEventType.OVERDUE_ITEM,
      stale_waiting: NotableEventType.STALE_WAITING,
    };

    return {
      id,
      userId,
      type: typeMap[doc.event_type] ?? NotableEventType.LOCATION_CHANGE,
      summary: doc.summary,
      details: { ...doc.payload, severity: doc.severity },
      acknowledged: doc.acknowledged,
      timestamp: doc.created_at,
    };
  }
}
