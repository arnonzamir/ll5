import type { NotableEvent, NotableEventType } from '../types/notable-event.js';

export interface NotableEventRepository {
  getSince(userId: string, since: string, types?: NotableEventType[]): Promise<NotableEvent[]>;
  create(userId: string, data: {
    type: NotableEventType;
    summary: string;
    details?: Record<string, unknown>;
    timestamp: string;
  }): Promise<NotableEvent>;
  acknowledge(userId: string, id: string): Promise<void>;
}
