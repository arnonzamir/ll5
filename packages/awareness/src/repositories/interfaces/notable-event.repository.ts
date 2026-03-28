import type { NotableEvent } from '../../types/notable-event.js';

export interface NotableEventQueryParams {
  since?: string;
  event_type?: string;
  min_severity?: string;
}

export interface NotableEventRepository {
  /** Create a new notable event. */
  create(userId: string, data: {
    event_type: string;
    summary: string;
    severity: string;
    payload: Record<string, unknown>;
    created_at: string;
  }): Promise<string>;

  /** Query unacknowledged notable events. */
  queryUnacknowledged(userId: string, params: NotableEventQueryParams): Promise<NotableEvent[]>;

  /** Mark events as acknowledged. Returns count of events updated. */
  acknowledge(userId: string, eventIds: string[]): Promise<number>;
}
