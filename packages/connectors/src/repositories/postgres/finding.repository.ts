import type { FindingRepository } from '../interfaces/finding.repository.js';
import type { FindingInput, FindingRecord } from '../../types.js';
import { PgRepository, iso } from './base.repository.js';

const COLUMNS = `id, connector_id, kind, summary, ref_id, opened_at, resolved_at, resolution, delivered`;

function toRecord(r: Record<string, unknown>): FindingRecord {
  return {
    id: String(r.id),
    connector_id: String(r.connector_id),
    kind: String(r.kind),
    summary: String(r.summary),
    ref_id: r.ref_id == null ? null : String(r.ref_id),
    opened_at: iso(r.opened_at) ?? '',
    resolved_at: iso(r.resolved_at),
    resolution: r.resolution == null ? null : String(r.resolution),
    delivered: String(r.delivered),
  };
}

export class PgFindingRepository extends PgRepository implements FindingRepository {
  async open(input: FindingInput): Promise<FindingRecord> {
    const userId = this.userId();
    if (input.ref_id) {
      const existing = await this.pool.query(
        `SELECT ${COLUMNS} FROM connector_findings
         WHERE user_id = $1 AND connector_id = $2 AND kind = $3 AND ref_id = $4 AND resolved_at IS NULL`,
        [userId, input.connector_id, input.kind, input.ref_id],
      );
      if (existing.rows[0]) return toRecord(existing.rows[0]);
    }
    const res = await this.pool.query(
      `INSERT INTO connector_findings (user_id, connector_id, kind, summary, ref_id, delivered)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
      [userId, input.connector_id, input.kind, input.summary, input.ref_id ?? null, input.delivered ?? 'none'],
    );
    return toRecord(res.rows[0]);
  }

  async resolve(id: string, note?: string): Promise<FindingRecord | null> {
    const res = await this.pool.query(
      `UPDATE connector_findings SET resolved_at = COALESCE(resolved_at, now()), resolution = COALESCE($3, resolution)
       WHERE user_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
      [this.userId(), id, note ?? null],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }

  async listOpen(connectorId?: string): Promise<FindingRecord[]> {
    const params: unknown[] = [this.userId()];
    let where = 'user_id = $1 AND resolved_at IS NULL';
    if (connectorId) {
      params.push(connectorId);
      where += ` AND connector_id = $${params.length}`;
    }
    const res = await this.pool.query(
      `SELECT ${COLUMNS} FROM connector_findings WHERE ${where} ORDER BY opened_at DESC LIMIT 500`,
      params,
    );
    return res.rows.map(toRecord);
  }

  async deleteResolvedOlderThan(months: number): Promise<number> {
    const res = await this.pool.query(
      `DELETE FROM connector_findings
       WHERE user_id = $1 AND resolved_at IS NOT NULL AND resolved_at < now() - make_interval(months => $2::int)`,
      [this.userId(), months],
    );
    return res.rowCount ?? 0;
  }
}
