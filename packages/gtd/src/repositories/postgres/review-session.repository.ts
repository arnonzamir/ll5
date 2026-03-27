import type { Pool } from 'pg';
import { BasePostgresRepository, mapReviewRow } from './base.repository.js';
import type { ReviewSessionRepository } from '../interfaces/review-session.repository.js';
import type {
  ReviewSession,
  CreateReviewInput,
  UpdateReviewInput,
  ReviewFilters,
  PaginationParams,
  PaginatedResult,
} from '../../types/index.js';

export class PostgresReviewSessionRepository extends BasePostgresRepository implements ReviewSessionRepository {
  constructor(pool: Pool) {
    super(pool);
  }

  async create(userId: string, data: CreateReviewInput): Promise<ReviewSession> {
    const sql = `
      INSERT INTO gtd_review_sessions (user_id, review_type, status, current_phase, phase_data)
      VALUES ($1, $2, 'in_progress', $3, $4)
      RETURNING *
    `;
    const params = [
      userId,
      data.type,
      data.currentPhase ?? null,
      data.phaseData ? JSON.stringify(data.phaseData) : null,
    ];
    const row = await this.queryOne<Record<string, unknown>>(sql, params);
    return mapReviewRow(row!) as unknown as ReviewSession;
  }

  async findById(userId: string, id: string): Promise<ReviewSession | null> {
    const sql = `SELECT * FROM gtd_review_sessions WHERE id = $1 AND user_id = $2`;
    const row = await this.queryOne<Record<string, unknown>>(sql, [id, userId]);
    return row ? mapReviewRow(row) as unknown as ReviewSession : null;
  }

  async find(
    userId: string,
    filters: ReviewFilters & PaginationParams,
  ): Promise<PaginatedResult<ReviewSession>> {
    const whereClauses: string[] = ['user_id = $1'];
    const params: unknown[] = [userId];
    let paramIdx = 2;

    if (filters.type) {
      whereClauses.push(`review_type = $${paramIdx}`);
      params.push(filters.type);
      paramIdx++;
    }

    if (filters.status) {
      whereClauses.push(`status = $${paramIdx}`);
      params.push(filters.status);
      paramIdx++;
    }

    const whereStr = whereClauses.join(' AND ');

    const countSql = `SELECT COUNT(*) FROM gtd_review_sessions WHERE ${whereStr}`;
    const total = await this.queryCount(countSql, params);

    const limit = Math.min(filters.limit ?? 50, 200);
    const offset = filters.offset ?? 0;

    const dataSql = `
      SELECT * FROM gtd_review_sessions
      WHERE ${whereStr}
      ORDER BY started_at DESC
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
    `;
    params.push(limit, offset);

    const rows = await this.query<Record<string, unknown>>(dataSql, params);
    const items = rows.map((r) => mapReviewRow(r) as unknown as ReviewSession);

    return { items, total };
  }

  async update(userId: string, id: string, data: UpdateReviewInput): Promise<ReviewSession> {
    const setClauses: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (data.status !== undefined) {
      setClauses.push(`status = $${paramIdx}`);
      params.push(data.status);
      paramIdx++;
    }

    if (data.currentPhase !== undefined) {
      setClauses.push(`current_phase = $${paramIdx}`);
      params.push(data.currentPhase);
      paramIdx++;
    }

    if (data.phaseData !== undefined) {
      setClauses.push(`phase_data = $${paramIdx}`);
      params.push(data.phaseData ? JSON.stringify(data.phaseData) : null);
      paramIdx++;
    }

    if (data.completedAt !== undefined) {
      setClauses.push(`completed_at = $${paramIdx}`);
      params.push(data.completedAt);
      paramIdx++;
    }

    if (setClauses.length === 0) {
      throw new Error('No fields to update');
    }

    params.push(id, userId);
    const sql = `
      UPDATE gtd_review_sessions
      SET ${setClauses.join(', ')}
      WHERE id = $${paramIdx} AND user_id = $${paramIdx + 1}
      RETURNING *
    `;

    const row = await this.queryOne<Record<string, unknown>>(sql, params);
    if (!row) {
      throw new Error(`Review session not found: ${id}`);
    }
    return mapReviewRow(row) as unknown as ReviewSession;
  }

  async findLatest(userId: string, type?: string): Promise<ReviewSession | null> {
    let sql: string;
    let params: unknown[];

    if (type) {
      sql = `
        SELECT * FROM gtd_review_sessions
        WHERE user_id = $1 AND review_type = $2
        ORDER BY started_at DESC
        LIMIT 1
      `;
      params = [userId, type];
    } else {
      sql = `
        SELECT * FROM gtd_review_sessions
        WHERE user_id = $1
        ORDER BY started_at DESC
        LIMIT 1
      `;
      params = [userId];
    }

    const row = await this.queryOne<Record<string, unknown>>(sql, params);
    return row ? mapReviewRow(row) as unknown as ReviewSession : null;
  }
}
