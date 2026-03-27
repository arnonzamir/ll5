import type { Pool, QueryResult } from 'pg';

export class BasePostgresRepository {
  constructor(protected pool: Pool) {}

  protected async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result: QueryResult = await this.pool.query(sql, params);
    return result.rows as T[];
  }

  protected async queryOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  protected async queryCount(sql: string, params: unknown[] = []): Promise<number> {
    const row = await this.queryOne<{ count: string }>(sql, params);
    return row ? parseInt(row.count, 10) : 0;
  }
}

/**
 * Maps a snake_case database row to a camelCase domain object for the horizons table.
 */
export function mapHorizonRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    userId: row.user_id,
    horizon: row.horizon,
    title: row.title,
    description: row.description ?? null,
    status: row.status,
    energy: row.energy ?? null,
    listType: row.list_type ?? null,
    context: Array.isArray(row.context) ? row.context : parseJsonbArray(row.context),
    dueDate: row.due_date ? String(row.due_date) : null,
    startDate: row.start_date ? String(row.start_date) : null,
    projectId: row.project_id ?? null,
    areaId: row.area_id ?? null,
    waitingFor: row.waiting_for ?? null,
    timeEstimate: row.time_estimate != null ? Number(row.time_estimate) : null,
    category: row.category ?? null,
    completedAt: row.completed_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Maps a snake_case inbox row to a camelCase domain object.
 */
export function mapInboxRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    userId: row.user_id,
    content: row.content,
    source: row.source ?? null,
    sourceLink: row.source_link ?? null,
    status: row.status,
    outcomeType: row.outcome_type ?? null,
    outcomeId: row.outcome_id ?? null,
    notes: row.notes ?? null,
    processedAt: row.processed_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Maps a snake_case review session row to a camelCase domain object.
 */
export function mapReviewRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.review_type,
    status: row.status,
    currentPhase: row.current_phase ?? null,
    phaseData: row.phase_data ?? null,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? null,
  };
}

function parseJsonbArray(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value as string[];
  return [];
}
