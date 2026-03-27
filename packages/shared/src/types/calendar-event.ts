export interface CalendarEvent {
  id: string;
  userId: string;
  title: string;
  description?: string;
  startTime: string;
  endTime: string;
  location?: string;
  calendarId?: string;
  sourceEventId?: string;
  allDay?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CalendarEventQuery {
  startTime?: string;
  endTime?: string;
  calendarId?: string;
  limit?: number;
  offset?: number;
}
