import type { Pool } from 'pg';
import { BasePostgresRepository, mapInboxRow } from './base.repository.js';
import type { InboxRepository } from '../interfaces/inbox.repository.js';
import type {
  InboxItem,
  CaptureInboxInput,
  ProcessInboxInput,
  InboxFilters,
  PaginationParams,
  PaginatedResult,
} from '../../types/index.js';

export class PostgresInboxRepository extends BasePostgresRepository implements InboxRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async capture(userId: string, data: CaptureInboxInput): Promise<InboxItem> {
    const sql = `
      INSERT INTO gtd_inbox (user_id, content, source, source_link, status)
      VALUES ($1, $2, $3, $4, 'captured')
      RETURNING *
    `;
    const params = [
      userId,
      data.content,
      data.source ?? 'direct',
      data.sourceLink ?? null,
    ];
    const row = await this.queryOne<Record<string, unknown>>(sql, params);
    return mapInboxRow(row!) as unknown as InboxItem;
  }

  async list(
    userId: string,
    filters: InboxFilters & PaginationParams,
  ): Promise<PaginatedResult<InboxItem>> {
    const whereClauses: string[] = ['user_id = $1'];
    const params: unknown[] = [userId];
    let paramIdx = 2;

    const status = filters.status ?? 'captured';
    whereClauses.push(`status = $${paramIdx}`);
    params.push(status);
    paramIdx++;

    const whereStr = whereClauses.join(' AND ');

    const countSql = `SELECT COUNT(*) FROM gtd_inbox WHERE ${whereStr}`;
    const total = await this.queryCount(countSql, params);

    const limit = Math.min(filters.limit ?? 50, 200);
    const offset = filters.offset ?? 0;

    const dataSql = `
      SELECT * FROM gtd_inbox
      WHERE ${whereStr}
      ORDER BY created_at ASC
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
    `;
    params.push(limit, offset);

    const rows = await this.query<Record<string, unknown>>(dataSql, params);
    const items = rows.map((r) => mapInboxRow(r) as unknown as InboxItem);

    return { items, total };
  }

  async findById(userId: string, id: string): Promise<InboxItem | null> {
    const sql = `SELECT * FROM gtd_inbox WHERE id = $1 AND user_id = $2`;
    const row = await this.queryOne<Record<string, unknown>>(sql, [id, userId]);
    return row ? mapInboxRow(row) as unknown as InboxItem : null;
  }

  async process(userId: string, id: string, data: ProcessInboxInput): Promise<InboxItem> {
    const sql = `
      UPDATE gtd_inbox
      SET status = 'processed',
          outcome_type = $3,
          outcome_id = $4,
          notes = $5,
          processed_at = now(),
          updated_at = now()
      WHERE id = $1 AND user_id = $2
      RETURNING *
    `;
    const params = [
      id,
      userId,
      data.outcomeType,
      data.outcomeId ?? null,
      data.notes ?? null,
    ];
    const row = await this.queryOne<Record<string, unknown>>(sql, params);
    if (!row) {
      throw new Error(`Inbox item not found: ${id}`);
    }
    return mapInboxRow(row) as unknown as InboxItem;
  }

  async delete(userId: string, id: string): Promise<boolean> {
    const sql = `DELETE FROM gtd_inbox WHERE id = $1 AND user_id = $2 RETURNING id`;
    const row = await this.queryOne<{ id: string }>(sql, [id, userId]);
    return row !== null;
  }

  async countByStatus(userId: string): Promise<Record<string, number>> {
    const sql = `
      SELECT status, COUNT(*) AS count
      FROM gtd_inbox
      WHERE user_id = $1
      GROUP BY status
    `;
    const rows = await this.query<{ status: string; count: string }>(sql, [userId]);
    const result: Record<string, number> = { captured: 0, reviewed: 0, processed: 0 };
    for (const row of rows) {
      result[row.status] = parseInt(row.count, 10);
    }
    return result;
  }
}
