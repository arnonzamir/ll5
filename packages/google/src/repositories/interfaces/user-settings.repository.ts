export interface UserSettings {
  user_id: string;
  /** Home IANA timezone. */
  timezone: string;
  /** GPS-derived current IANA timezone, if known. */
  current_timezone: string | null;
  /** ISO timestamp when current_timezone was observed. */
  current_timezone_at: string | null;
  /** IANA working zones the user commonly cares about. */
  working_zones: string[];
}

export interface UserSettingsRepository {
  get(userId: string): Promise<UserSettings>;
  setTimezone(userId: string, timezone: string): Promise<void>;
}
