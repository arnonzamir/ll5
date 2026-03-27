import type { CalendarEvent, CalendarEventQuery } from '../types/calendar-event.js';

export interface CalendarEventRepository {
  query(userId: string, query: CalendarEventQuery): Promise<CalendarEvent[]>;
  create(userId: string, data: {
    title: string;
    description?: string;
    startTime: string;
    endTime: string;
    location?: string;
    calendarId?: string;
    sourceEventId?: string;
    allDay?: boolean;
  }): Promise<CalendarEvent>;
  update(userId: string, id: string, data: {
    title?: string;
    description?: string;
    startTime?: string;
    endTime?: string;
    location?: string;
    allDay?: boolean;
  }): Promise<CalendarEvent>;
  delete(userId: string, id: string): Promise<void>;
}
