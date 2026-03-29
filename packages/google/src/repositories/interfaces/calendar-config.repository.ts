export interface CalendarConfigRecord {
  user_id: string;
  calendar_id: string;
  calendar_name: string;
  enabled: boolean;
  color: string;
  role: string;
  created_at: Date;
  updated_at: Date;
}

export interface UpsertCalendarConfigInput {
  calendar_id: string;
  calendar_name: string;
  color: string;
  role?: string;
}

export interface CalendarConfigRepository {
  /** Upsert calendar config. Used when syncing calendar list from Google. */
  upsert(userId: string, config: UpsertCalendarConfigInput): Promise<void>;

  /** List all calendar configs for a user. */
  list(userId: string): Promise<CalendarConfigRecord[]>;

  /** Get calendar config by role (e.g., 'tickler'). */
  getByRole(userId: string, role: string): Promise<CalendarConfigRecord | null>;

  /** Update enabled status for a calendar. */
  setEnabled(userId: string, calendarId: string, enabled: boolean): Promise<void>;

  /** Get only enabled calendar IDs. */
  getEnabledCalendarIds(userId: string): Promise<string[]>;

  /** Delete all calendar configs for a user. Used during disconnect. */
  deleteAll(userId: string): Promise<void>;
}
