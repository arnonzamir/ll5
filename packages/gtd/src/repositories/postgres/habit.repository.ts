import type { Pool } from 'pg';
import { BasePostgresRepository, mapHabitRow, mapHabitLogRow } from './base.repository.js';
import type { HabitRepository } from '../interfaces/habit.repository.js';
import type {
  Habit,
  HabitLogEntry,
  CreateHabitInput,
  UpdateHabitInput,
  LogHabitOutcomeInput,
  HabitFilters,
  HabitLogFilters,
} from '../../types/index.js';

export class PostgresHabitRepository extends BasePostgresRepository implements HabitRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(userId: string, data: CreateHabitInput): Promise<Habit> {
    const sql = `
      INSERT INTO gtd_habits (user_id, name, description, schedule, check_kind, check_config, escalation, timezone)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `;
    const params = [
      userId,
      data.name,
      data.description ?? null,
      JSON.stringify(data.schedule),
      data.checkKind,
      JSON.stringify(data.checkConfig ?? {}),
      JSON.stringify(data.escalation ?? []),
      data.timezone ?? null,
    ];
    const row = await this.queryOne<Record<string, unknown>>(sql, params);
    return mapHabitRow(row!) as unknown as Habit;
  }

  async update(userId: string, id: string, data: UpdateHabitInput): Promise<Habit> {
    const setClauses: string[] = ['updated_at = now()'];
    const params: unknown[] = [];
    let paramIdx = 1;

    const fieldMap: Record<string, { column: string; transform?: (v: unknown) => unknown }> = {
      name: { column: 'name' },
      description: { column: 'description' },
      schedule: { column: 'schedule', transform: (v) => JSON.stringify(v) },
      checkKind: { column: 'check_kind' },
      checkConfig: { column: 'check_config', transform: (v) => JSON.stringify(v ?? {}) },
      escalation: { column: 'escalation', transform: (v) => JSON.stringify(v ?? []) },
      status: { column: 'status' },
      timezone: { column: 'timezone' },
    };

    for (const [key, mapping] of Object.entries(fieldMap)) {
      if (key in data) {
        const value = (data as Record<string, unknown>)[key];
        const transformed = mapping.transform ? mapping.transform(value) : value;
        setClauses.push(`${mapping.column} = $${paramIdx}`);
        params.push(transformed);
        paramIdx++;
      }
    }

    params.push(id, userId);
    const sql = `
      UPDATE gtd_habits
      SET ${setClauses.join(', ')}
      WHERE id = $${paramIdx} AND user_id = $${paramIdx + 1}
      RETURNING *
    `;

    const row = await this.queryOne<Record<string, unknown>>(sql, params);
    if (!row) {
      throw new Error(`Habit not found: ${id}`);
    }
    return mapHabitRow(row) as unknown as Habit;
  }

  async findById(userId: string, id: string): Promise<Habit | null> {
    const sql = `SELECT * FROM gtd_habits WHERE id = $1 AND user_id = $2`;
    const row = await this.queryOne<Record<string, unknown>>(sql, [id, userId]);
    return row ? mapHabitRow(row) as unknown as Habit : null;
  }

  async list(userId: string, filters: HabitFilters = {}): Promise<Habit[]> {
    const whereClauses = ['user_id = $1'];
    const params: unknown[] = [userId];
    if (filters.status) {
      whereClauses.push(`status = $2`);
      params.push(filters.status);
    }
    const sql = `
      SELECT * FROM gtd_habits
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY created_at ASC
    `;
    const rows = await this.query<Record<string, unknown>>(sql, params);
    return rows.map((r) => mapHabitRow(r) as unknown as Habit);
  }

  async logOutcome(userId: string, data: LogHabitOutcomeInput): Promise<HabitLogEntry> {
    // Upsert: the user may confirm before the scheduler has created the row.
    // On conflict only outcome/closed_at/note change — steps_fired stays
    // scheduler-owned. The user_id guard on DO UPDATE is a defense-in-depth
    // backstop; callers must verify habit ownership first (findById is scoped).
    const sql = `
      INSERT INTO gtd_habit_log (habit_id, user_id, due_date, due_time, outcome, closed_at, note)
      VALUES ($1, $2, $3, $4, $5, now(), $6)
      ON CONFLICT (habit_id, due_date, due_time)
      DO UPDATE SET
        outcome = EXCLUDED.outcome,
        closed_at = now(),
        note = COALESCE(EXCLUDED.note, gtd_habit_log.note)
      WHERE gtd_habit_log.user_id = $2
      RETURNING *
    `;
    const params = [
      data.habitId,
      userId,
      data.dueDate,
      data.dueTime,
      data.outcome,
      data.note ?? null,
    ];
    const row = await this.queryOne<Record<string, unknown>>(sql, params);
    if (!row) {
      throw new Error(`Habit occurrence not writable: ${data.habitId} ${data.dueDate} ${data.dueTime}`);
    }
    return mapHabitLogRow(row) as unknown as HabitLogEntry;
  }

  async listLog(userId: string, filters: HabitLogFilters = {}): Promise<HabitLogEntry[]> {
    const whereClauses = ['user_id = $1'];
    const params: unknown[] = [userId];
    let paramIdx = 2;

    if (filters.habitId) {
      whereClauses.push(`habit_id = $${paramIdx}`);
      params.push(filters.habitId);
      paramIdx++;
    }
    if (filters.fromDate) {
      whereClauses.push(`due_date >= $${paramIdx}`);
      params.push(filters.fromDate);
      paramIdx++;
    }
    if (filters.toDate) {
      whereClauses.push(`due_date <= $${paramIdx}`);
      params.push(filters.toDate);
      paramIdx++;
    }

    const sql = `
      SELECT * FROM gtd_habit_log
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY due_date DESC, due_time DESC
    `;
    const rows = await this.query<Record<string, unknown>>(sql, params);
    return rows.map((r) => mapHabitLogRow(r) as unknown as HabitLogEntry);
  }
}
