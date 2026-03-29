export type CalendarAccessMode = 'ignore' | 'read' | 'readwrite';

export interface CalendarConfigRecord {
  user_id: string;
  calendar_id: string;
  calendar_name: string;
  enabled: boolean;
  color: string;
  role: string;
  access_mode: CalendarAccessMode;
  created_at: Date;
  updated_at: Date;
}

export interface UpsertCalendarConfigInput {
  calendar_id: string;
  calendar_name: string;
  color: string;
  role?: string;
  access_mode?: CalendarAccessMode;
}

export interface CalendarConfigRepository {
  /** Upsert calendar config. Used when syncing calendar list from Google. */
  upsert(userId: string, config: UpsertCalendarConfigInput): Promise<void>;

  /** List all calendar configs for a user. */
  list(userId: string): Promise<CalendarConfigRecord[]>;

  /** Get calendar config by role (e.g., 'tickler'). */
  getByRole(userId: string, role: string): Promise<CalendarConfigRecord | null>;

  /** Set access mode for a calendar. */
  setAccessMode(userId: string, calendarId: string, mode: CalendarAccessMode): Promise<void>;

  /** Get calendar IDs with read or readwrite access (excludes 'ignore'). */
  getReadableCalendarIds(userId: string): Promise<string[]>;

  /** Get calendar IDs with readwrite access. */
  getWritableCalendarIds(userId: string): Promise<string[]>;

  /** Delete all calendar configs for a user. Used during disconnect. */
  deleteAll(userId: string): Promise<void>;
}
