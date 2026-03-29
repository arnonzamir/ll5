export interface UserSettings {
  user_id: string;
  timezone: string;
}

export interface UserSettingsRepository {
  get(userId: string): Promise<UserSettings>;
  setTimezone(userId: string, timezone: string): Promise<void>;
}
