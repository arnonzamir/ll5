import type { CalendarEvent } from '../../types/calendar-event.js';

export interface CalendarEventQueryParams {
  from?: string;
  to?: string;
  calendar_name?: string;
  include_all_day?: boolean;
}

export interface CalendarEventRepository {
  /** Query events within a time range. */
  query(userId: string, params: CalendarEventQueryParams): Promise<CalendarEvent[]>;

  /** Get the next upcoming event from now. */
  getNext(userId: string): Promise<CalendarEvent | null>;

  /** Store or update a calendar event. */
  upsert(userId: string, data: {
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
  }): Promise<CalendarEvent>;
}
