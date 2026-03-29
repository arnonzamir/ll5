import { BasePostgresRepository } from './base.repository.js';
import type { UserSettings, UserSettingsRepository } from '../interfaces/user-settings.repository.js';

const DEFAULT_TIMEZONE = 'Asia/Jerusalem';

export class PostgresUserSettingsRepository extends BasePostgresRepository implements UserSettingsRepository {

  async get(userId: string): Promise<UserSettings> {
    const row = await this.queryOne<{ user_id: string; timezone: string }>(
      `SELECT user_id, timezone FROM google_user_settings WHERE user_id = $1`,
      [userId],
    );
    return row ?? { user_id: userId, timezone: DEFAULT_TIMEZONE };
  }

  async setTimezone(userId: string, timezone: string): Promise<void> {
    await this.query(
      `INSERT INTO google_user_settings (user_id, timezone)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET timezone = $2, updated_at = now()`,
      [userId, timezone],
    );
  }
}
