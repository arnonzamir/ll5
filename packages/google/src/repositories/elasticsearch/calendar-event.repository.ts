import type { Client } from '@elastic/elasticsearch';
import { logger } from '../../utils/logger.js';

const INDEX = 'll5_awareness_calendar_events';

export interface CalendarEventDoc {
  user_id: string;
  title: string;
  description?: string | null;
  start_time: string;
  end_time: string;
  location?: string | null;
  calendar_name?: string | null;
  calendar_id?: string | null;
  calendar_color?: string | null;
  google_event_id?: string | null;
  html_link?: string | null;
  source: string;
  status?: string;
  all_day: boolean;
  recurring?: boolean;
  is_free_busy?: boolean;
  is_tickler?: boolean;
  attendees?: string[];
  attendees_detail?: Array<{ email: string; name?: string | null; response_status?: string }>;
  created_at: string;
  updated_at: string;
}

export interface QueryParams {
  from?: string;
  to?: string;
  calendarId?: string;
  calendarIds?: string[];
  isTickler?: boolean;
  query?: string;
  includeAllDay?: boolean;
  limit?: number;
}

interface ESHit {
  _id: string;
  _source?: CalendarEventDoc;
}

/**
 * ES calendar event repository for the unified calendar layer.
 * Reads and writes to the shared ll5_awareness_calendar_events index.
 */
export class ESCalendarEventRepository {
  constructor(private es: Client) {}

  async query(userId: string, params: QueryParams): Promise<CalendarEventDoc[]> {
    const tz = 'Asia/Jerusalem'; // default; caller provides proper range
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

    const from = params.from ?? startOfDay.toISOString();
    const to = params.to ?? endOfDay.toISOString();
    const limit = params.limit ?? 100;

    const filters: Record<string, unknown>[] = [
      { term: { user_id: userId } },
      { range: { start_time: { lt: to } } },
      { range: { end_time: { gt: from } } },
    ];

    // Use calendar_id.keyword for exact matching (calendar_id may be mapped as text on older indices)
    if (params.calendarId) {
      filters.push({ term: { 'calendar_id.keyword': params.calendarId } });
    } else if (params.calendarIds && params.calendarIds.length > 0) {
      // Include docs with matching calendar_id OR docs with no calendar_id (legacy)
      filters.push({
        bool: {
          should: [
            { terms: { 'calendar_id.keyword': params.calendarIds } },
            { bool: { must_not: { exists: { field: 'calendar_id' } } } },
          ],
          minimum_should_match: 1,
        },
      });
    }

    const mustNot: Record<string, unknown>[] = [];
    if (params.isTickler === false) {
      // Exclude ticklers: match docs where is_tickler is explicitly true
      mustNot.push({ term: { is_tickler: true } });
    } else if (params.isTickler === true) {
      filters.push({ term: { is_tickler: true } });
    }

    if (params.includeAllDay === false) {
      filters.push({ term: { all_day: false } });
    }

    const must: Record<string, unknown>[] = [];
    if (params.query) {
      must.push({ match: { title: params.query } });
    }

    const response = await this.es.search({
      index: INDEX,
      query: {
        bool: {
          filter: filters,
          ...(must.length > 0 ? { must } : {}),
          ...(mustNot.length > 0 ? { must_not: mustNot } : {}),
        },
      },
      sort: [{ start_time: { order: 'asc' } }],
      size: limit,
    });

    return (response.hits.hits as ESHit[])
      .filter((h) => h._source)
      .map((h) => h._source!);
  }

  async upsertFromGoogle(
    userId: string,
    event: {
      event_id: string;
      calendar_id: string;
      calendar_name: string;
      calendar_color?: string;
      title: string;
      start: string;
      end: string;
      all_day: boolean;
      location?: string | null;
      description?: string | null;
      attendees?: Array<{ email: string; name?: string | null; response_status?: string }>;
      html_link?: string;
      status?: string;
      recurring?: boolean;
      is_free_busy?: boolean;
    },
    isTickler: boolean = false,
  ): Promise<void> {
    const now = new Date().toISOString();
    const docId = isTickler ? `tickler-${event.event_id}` : `google-${event.event_id}`;

    const doc: CalendarEventDoc = {
      user_id: userId,
      title: event.title,
      description: event.description,
      start_time: event.start,
      end_time: event.end,
      location: event.location,
      calendar_name: event.calendar_name,
      calendar_id: event.calendar_id,
      calendar_color: event.calendar_color,
      google_event_id: event.event_id,
      html_link: event.html_link,
      source: isTickler ? 'tickler' : 'google',
      status: event.status ?? 'confirmed',
      all_day: event.all_day,
      recurring: event.recurring ?? false,
      is_free_busy: event.is_free_busy ?? false,
      is_tickler: isTickler,
      attendees: event.attendees?.map((a) => a.name ?? a.email) ?? [],
      attendees_detail: event.attendees,
      created_at: now,
      updated_at: now,
    };

    await this.es.index({
      index: INDEX,
      id: docId,
      document: doc,
      refresh: false,
    });
  }

  async deleteByDocId(docId: string): Promise<void> {
    try {
      await this.es.delete({ index: INDEX, id: docId, refresh: false });
    } catch (err) {
      // 404 is expected (document may not exist), log other errors
      const statusCode = (err as { statusCode?: number })?.statusCode;
      if (statusCode !== 404) {
        logger.warn('[calendarEventRepo] deleteByDocId failed', { docId, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}
