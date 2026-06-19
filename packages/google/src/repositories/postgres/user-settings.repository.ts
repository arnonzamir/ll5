import { BasePostgresRepository } from './base.repository.js';
import { HOME_TIMEZONE_FALLBACK, DEFAULT_WORKING_ZONES } from '@ll5/shared';
import type { UserSettings, UserSettingsRepository } from '../interfaces/user-settings.repository.js';

const DEFAULT_TIMEZONE = HOME_TIMEZONE_FALLBACK;

export class PostgresUserSettingsRepository extends BasePostgresRepository implements UserSettingsRepository {

  async get(userId: string): Promise<UserSettings> {
    // Read from unified user_settings table, fall back to legacy google_user_settings
    const row = await this.queryOne<{ settings: Record<string, unknown> }>(
      `SELECT settings FROM user_settings WHERE user_id = $1`,
      [userId],
    );
    if (row?.settings?.timezone) {
      const s = row.settings;
      const workingZones = Array.isArray(s.working_zones) && s.working_zones.length > 0
        ? (s.working_zones as string[])
        : [...DEFAULT_WORKING_ZONES];
      return {
        user_id: userId,
        timezone: s.timezone as string,
        current_timezone: (s.current_timezone as string | undefined) ?? null,
        current_timezone_at: (s.current_timezone_at as string | undefined) ?? null,
        working_zones: workingZones,
      };
    }

    // Legacy fallback
    const legacy = await this.queryOne<{ timezone: string }>(
      `SELECT timezone FROM google_user_settings WHERE user_id = $1`,
      [userId],
    );
    return {
      user_id: userId,
      timezone: legacy?.timezone ?? DEFAULT_TIMEZONE,
      current_timezone: null,
      current_timezone_at: null,
      working_zones: [...DEFAULT_WORKING_ZONES],
    };
  }

  async setTimezone(userId: string, timezone: string): Promise<void> {
    // Write to unified user_settings table
    await this.query(
      `INSERT INTO user_settings (user_id, settings, updated_at)
       VALUES ($1, jsonb_build_object('timezone', $2::text), now())
       ON CONFLICT (user_id) DO UPDATE SET
         settings = user_settings.settings || jsonb_build_object('timezone', $2::text),
         updated_at = now()`,
      [userId, timezone],
    );

    // Also write to legacy table for backward compat during transition
    await this.query(
      `INSERT INTO google_user_settings (user_id, timezone)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET timezone = $2, updated_at = now()`,
      [userId, timezone],
    ).catch(() => { /* legacy table may not exist */ });
  }
}
