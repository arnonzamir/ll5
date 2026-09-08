import type { Client } from '@elastic/elasticsearch';
import { BaseElasticsearchRepository } from './base.repository.js';
import type { EsQueryContainer } from './base.repository.js';
import type { CallRepository, CallQueryParams, CallRecord, CallDirection, CallState } from '../interfaces/call.repository.js';

const INDEX = 'll5_awareness_calls';

interface CallDoc {
  user_id: string;
  state: CallState;
  direction?: CallDirection | null;
  number?: string | null;
  contact_name?: string | null;
  person_id?: string | null;
  known_contact?: boolean;
  started_at: string;
  ended_at?: string | null;
  duration_s?: number | null;
  call_log_id?: string | null;
  updated_at: string;
}

function toRecord(id: string, d: CallDoc): CallRecord {
  return {
    id,
    state: d.state,
    direction: d.direction ?? null,
    number: d.number ?? null,
    contact_name: d.contact_name ?? null,
    person_id: d.person_id ?? null,
    known_contact: !!d.known_contact,
    started_at: d.started_at,
    ended_at: d.ended_at ?? null,
    duration_s: d.duration_s ?? null,
    call_log_id: d.call_log_id ?? null,
    updated_at: d.updated_at,
  };
}

export class ElasticsearchCallRepository
  extends BaseElasticsearchRepository
  implements CallRepository
{
  constructor(client: Client) {
    super(client, INDEX);
  }

  async query(userId: string, params: CallQueryParams): Promise<CallRecord[]> {
    const filters: EsQueryContainer[] = [];
    const musts: EsQueryContainer[] = [];

    const range: Record<string, string> = {};
    range.gte = params.since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    if (params.until) range.lte = params.until;
    filters.push({ range: { started_at: range } });

    if (params.direction) filters.push({ term: { direction: params.direction } });
    if (params.number) {
      // Match the number as sent or by its trailing digits (local vs +country form).
      const digits = params.number.replace(/\D/g, '');
      const tail = digits.length > 9 ? digits.slice(-9) : digits;
      filters.push({ bool: { should: [
        { term: { number: params.number } },
        ...(tail ? [{ wildcard: { number: { value: `*${tail}` } } }] : []),
      ], minimum_should_match: 1 } });
    }
    if (params.contact) musts.push({ match: { contact_name: { query: params.contact, fuzziness: 'AUTO' } } });

    const hasTextQuery = musts.length > 0;
    const sort: Array<Record<string, unknown>> = hasTextQuery
      ? [{ _score: { order: 'desc' } }, { started_at: { order: 'desc' } }]
      : [{ started_at: { order: 'desc' } }];

    const { hits } = await this.searchDocs<CallDoc>(userId, {
      filters, musts, size: params.limit ?? 50, from: params.offset ?? 0, sort,
    });
    return hits.filter((h) => h._source != null).map((h) => toRecord(h._id!, h._source!));
  }

  async getActive(userId: string, now: Date, maxAgeMs: number): Promise<CallRecord | null> {
    const since = new Date(now.getTime() - maxAgeMs).toISOString();
    const { hits } = await this.searchDocs<CallDoc>(userId, {
      filters: [{ term: { state: 'offhook' } }, { range: { updated_at: { gte: since } } }],
      size: 1,
      sort: [{ updated_at: { order: 'desc' } }],
    });
    const h = hits[0];
    return h?._source ? toRecord(h._id!, h._source) : null;
  }

  async recentMissed(userId: string, since: string, limit: number): Promise<CallRecord[]> {
    const { hits } = await this.searchDocs<CallDoc>(userId, {
      filters: [{ term: { direction: 'missed' } }, { range: { started_at: { gte: since } } }],
      size: limit,
      sort: [{ started_at: { order: 'desc' } }],
    });
    return hits.filter((h) => h._source != null).map((h) => toRecord(h._id!, h._source!));
  }
}
