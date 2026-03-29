import { BasePostgresRepository } from './base.repository.js';
import type {
  CalendarConfigRepository,
  CalendarConfigRecord,
  UpsertCalendarConfigInput,
} from '../interfaces/calendar-config.repository.js';

interface CalendarConfigRow {
  id: string;
  user_id: string;
  calendar_id: string;
  calendar_name: string;
  enabled: boolean;
  color: string;
  role: string;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: CalendarConfigRow): CalendarConfigRecord {
  return {
    user_id: row.user_id,
    calendar_id: row.calendar_id,
    calendar_name: row.calendar_name ?? '',
    enabled: row.enabled,
    color: row.color ?? '#4285f4',
    role: row.role ?? 'user',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class PostgresCalendarConfigRepository extends BasePostgresRepository implements CalendarConfigRepository {

  async upsert(userId: string, config: UpsertCalendarConfigInput): Promise<void> {
    const role = config.role ?? 'user';
    await this.query(
      `INSERT INTO google_calendar_config (user_id, calendar_id, calendar_name, color, role)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, calendar_id) DO UPDATE SET
         calendar_name = EXCLUDED.calendar_name,
         color = EXCLUDED.color,
         role = EXCLUDED.role,
         updated_at = now()`,
      [userId, config.calendar_id, config.calendar_name, config.color, role],
    );
  }

  async list(userId: string): Promise<CalendarConfigRecord[]> {
    const rows = await this.query<CalendarConfigRow>(
      `SELECT * FROM google_calendar_config WHERE user_id = $1 ORDER BY calendar_name`,
      [userId],
    );
    return rows.map(mapRow);
  }

  async getByRole(userId: string, role: string): Promise<CalendarConfigRecord | null> {
    const row = await this.queryOne<CalendarConfigRow>(
      `SELECT * FROM google_calendar_config WHERE user_id = $1 AND role = $2`,
      [userId, role],
    );
    return row ? mapRow(row) : null;
  }

  async setEnabled(userId: string, calendarId: string, enabled: boolean): Promise<void> {
    await this.query(
      `UPDATE google_calendar_config SET enabled = $1, updated_at = now() WHERE user_id = $2 AND calendar_id = $3`,
      [enabled, userId, calendarId],
    );
  }

  async getEnabledCalendarIds(userId: string): Promise<string[]> {
    const rows = await this.query<{ calendar_id: string }>(
      `SELECT calendar_id FROM google_calendar_config WHERE user_id = $1 AND enabled = true`,
      [userId],
    );
    return rows.map((r) => r.calendar_id);
  }

  async deleteAll(userId: string): Promise<void> {
    await this.query(`DELETE FROM google_calendar_config WHERE user_id = $1`, [userId]);
  }
}
