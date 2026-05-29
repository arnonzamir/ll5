import type { Client } from '@elastic/elasticsearch';
import { BaseElasticsearchRepository } from './base.repository.js';
import type { EsQueryContainer } from './base.repository.js';
import type {
  CalendarEventRepository,
  CalendarEventQueryParams,
} from '../interfaces/calendar-event.repository.js';
import type { CalendarEvent } from '../../types/calendar-event.js';
import { logger } from '../../utils/logger.js';

const INDEX = 'll5_awareness_calendar_events';

interface CalendarEventDoc {
  user_id: string;
  title: string;
  description?: string;
  start_time: string;
  end_time: string;
  location?: string;
  calendar_name?: string;
  source?: string;
  all_day: boolean;
  attendees: string[];
  created_at: string;
  updated_at: string;
}

export class ElasticsearchCalendarEventRepository
  extends BaseElasticsearchRepository
  implements CalendarEventRepository
{
  constructor(client: Client) {
    super(client, INDEX);
  }

  async query(userId: string, params: CalendarEventQueryParams): Promise<CalendarEvent[]> {
    const filters: EsQueryContainer[] = [];

    // Default to today if no range specified
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

    const from = params.from ?? startOfDay;
    const to = params.to ?? endOfDay;

    // Events that overlap with the range: start_time < to AND end_time > from
    filters.push({ range: { start_time: { lt: to } } });
    filters.push({ range: { end_time: { gt: from } } });

    if (params.calendar_name) {
      filters.push({ term: { calendar_name: params.calendar_name } });
    }

    if (params.include_all_day === false) {
      filters.push({ term: { all_day: false } });
    }

    const { hits } = await this.searchDocs<CalendarEventDoc>(userId, {
      filters,
      size: 100,
      sort: [{ start_time: { order: 'asc' } }],
    });

    return hits
      .filter((h) => h._source != null)
      .map((h) => this.mapToCalendarEvent(h._id!, h._source!, userId));
  }

  async getNext(userId: string): Promise<CalendarEvent | null> {
    const now = this.nowISO();

    const { hits } = await this.searchDocs<CalendarEventDoc>(userId, {
      filters: [
        { range: { start_time: { gte: now } } },
      ],
      size: 1,
      sort: [{ start_time: { order: 'asc' } }],
    });

    if (hits.length === 0 || !hits[0]?._source) return null;
    return this.mapToCalendarEvent(hits[0]._id!, hits[0]._source, userId);
  }

  async upsert(
    userId: string,
    data: {
      id?: string;
      title: string;
      description?: string;
      startTime: string;
      endTime: string;
      location?: string;
      calendarName?: string;
      source?: string;
      allDay?: boolean;
      attendees?: string[];
    },
  ): Promise<CalendarEvent> {
    const id = data.id ?? this.generateId();

    // When the caller supplies an id, verify ownership before overwriting.
    // indexDoc writes by id and would otherwise silently clobber another
    // tenant's doc (the new doc would carry the caller's user_id). Mirror the
    // network/narrative ownership discipline.
    if (data.id) {
      const existingOwner = await this.getOwnerById(id);
      if (existingOwner !== null && existingOwner !== userId) {
        logger.warn('cross_user_access_denied', {
          actor_user_id: userId,
          owner_user_id: existingOwner,
          resource: 'calendar_event',
          id,
        });
        throw new Error('calendar event id belongs to another user');
      }
    }

    const now = this.nowISO();

    const doc: CalendarEventDoc = {
      user_id: userId,
      title: data.title,
      description: data.description,
      start_time: data.startTime,
      end_time: data.endTime,
      location: data.location,
      calendar_name: data.calendarName,
      source: data.source,
      all_day: data.allDay ?? false,
      attendees: data.attendees ?? [],
      created_at: now,
      updated_at: now,
    };

    await this.indexDoc(id, doc as unknown as Record<string, unknown>);

    return this.mapToCalendarEvent(id, doc, userId);
  }

  /**
   * Return the user_id of the doc at `id`, or null if it does not exist.
   * Unlike base.getById, this surfaces the existing owner so a cross-tenant
   * overwrite can be rejected and logged with the real owner.
   */
  private async getOwnerById(id: string): Promise<string | null> {
    try {
      const response = await this.client.get<CalendarEventDoc>({ index: this.index, id });
      const owner = response._source?.user_id;
      return owner ?? null;
    } catch (err: unknown) {
      const error = err as { meta?: { statusCode?: number } };
      if (error.meta?.statusCode === 404) return null;
      throw err;
    }
  }

  private mapToCalendarEvent(id: string, doc: CalendarEventDoc, userId: string): CalendarEvent {
    return {
      id,
      userId,
      title: doc.title,
      description: doc.description,
      startTime: doc.start_time,
      endTime: doc.end_time,
      location: doc.location,
      calendarId: doc.calendar_name,
      allDay: doc.all_day,
      createdAt: doc.created_at,
      updatedAt: doc.updated_at,
    };
  }
}
