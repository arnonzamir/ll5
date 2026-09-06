import type { LedgerRepository } from '../interfaces/ledger.repository.js';
import type { LedgerFilters, LedgerRowInput, LedgerRowRecord, Page } from '../../types.js';
import type { ReconcileRow } from '../../reconcile.js';
import { merchantKey } from '../../utils/keys.js';
import { PgRepository, iso, num, currency } from './base.repository.js';
import type { Pool } from 'pg';

const COLUMNS = `id, connector_id, account_ref, external_id, kind, occurred_at, posted_at, amount, currency,
  merchant_key, payload_enc, fetched_at`;

export class PgLedgerRepository extends PgRepository implements LedgerRepository {
  constructor(pool: Pool, encryptionKey: string, private readonly merchantSubKeyHex: string) {
    super(pool, encryptionKey);
  }

  private toRecord(r: Record<string, unknown>): LedgerRowRecord {
    return {
      id: String(r.id),
      connector_id: String(r.connector_id),
      account_ref: r.account_ref == null ? null : String(r.account_ref),
      external_id: String(r.external_id),
      kind: String(r.kind),
      occurred_at: iso(r.occurred_at) ?? '',
      posted_at: iso(r.posted_at),
      amount: num(r.amount),
      currency: currency(r.currency),
      merchant_key: r.merchant_key == null ? null : String(r.merchant_key),
      payload: this.decryptJson(r.payload_enc as string | null, 'PgLedgerRepository'),
      fetched_at: iso(r.fetched_at) ?? '',
    };
  }

  async upsertMany(connectorId: string, rows: LedgerRowInput[]): Promise<{ inserted: number; updated: number }> {
    if (rows.length === 0) return { inserted: 0, updated: 0 };
    const userId = this.userId();
    const client = await this.pool.connect();
    let inserted = 0;
    let updated = 0;
    try {
      await client.query('BEGIN');
      for (const row of rows) {
        const payload: Record<string, unknown> = {
          merchant: row.merchant ?? null,
          memo: row.memo ?? null,
          category: row.category ?? null,
          installments: row.installments ?? null,
          ...(row.extra ?? {}),
        };
        const res = await client.query(
          `INSERT INTO connector_ledger_rows
             (user_id, connector_id, account_ref, external_id, kind, occurred_at, posted_at, amount, currency,
              merchant_key, payload_enc, fetched_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
           ON CONFLICT (user_id, connector_id, external_id) DO UPDATE SET
             account_ref = EXCLUDED.account_ref, kind = EXCLUDED.kind, occurred_at = EXCLUDED.occurred_at,
             posted_at = EXCLUDED.posted_at, amount = EXCLUDED.amount, currency = EXCLUDED.currency,
             merchant_key = EXCLUDED.merchant_key, payload_enc = EXCLUDED.payload_enc, fetched_at = now()
           RETURNING (xmax = 0) AS inserted`,
          [
            userId,
            connectorId,
            row.account_ref ?? null,
            row.external_id,
            row.kind,
            row.occurred_at,
            row.posted_at ?? null,
            row.amount ?? null,
            row.currency ?? null,
            merchantKey(row.merchant, this.merchantSubKeyHex),
            this.encryptJson(payload),
          ],
        );
        if (res.rows[0]?.inserted) inserted++;
        else updated++;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return { inserted, updated };
  }

  async query(f: LedgerFilters): Promise<Page<LedgerRowRecord>> {
    const params: unknown[] = [this.userId()];
    const where = ['user_id = $1'];
    const add = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replace('?', `$${params.length}`));
    };
    if (f.connector_id) add('connector_id = ?', f.connector_id);
    if (f.since) add('occurred_at >= ?', f.since);
    if (f.until) add('occurred_at < ?', f.until);
    if (f.kind) add('kind = ?', f.kind);
    if (f.min_amount != null) add('amount >= ?', f.min_amount);
    params.push(f.limit + 1, f.offset);
    const res = await this.pool.query(
      `SELECT ${COLUMNS} FROM connector_ledger_rows WHERE ${where.join(' AND ')}
       ORDER BY occurred_at DESC, id LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const hasMore = res.rows.length > f.limit;
    return { items: res.rows.slice(0, f.limit).map((r) => this.toRecord(r)), hasMore };
  }

  async forReconcile(sinceIso: string, untilIso: string, connectorId?: string): Promise<ReconcileRow[]> {
    const params: unknown[] = [this.userId(), sinceIso, untilIso];
    let where = `user_id = $1 AND occurred_at >= $2 AND occurred_at <= $3`;
    if (connectorId) {
      params.push(connectorId);
      where += ` AND connector_id = $4`;
    }
    const res = await this.pool.query(
      `SELECT id, amount, merchant_key, account_ref, occurred_at FROM connector_ledger_rows WHERE ${where}`,
      params,
    );
    return res.rows.map((r) => ({
      id: String(r.id),
      amount: num(r.amount),
      merchant_key: r.merchant_key == null ? null : String(r.merchant_key),
      account_ref: r.account_ref == null ? null : String(r.account_ref),
      occurred_at: iso(r.occurred_at) ?? '',
    }));
  }

  async count(connectorId?: string): Promise<number> {
    const params: unknown[] = [this.userId()];
    let where = 'user_id = $1';
    if (connectorId) {
      params.push(connectorId);
      where += ' AND connector_id = $2';
    }
    const res = await this.pool.query(`SELECT count(*)::int AS n FROM connector_ledger_rows WHERE ${where}`, params);
    return Number(res.rows[0]?.n ?? 0);
  }

  async deleteOlderThan(connectorId: string, months: number): Promise<number> {
    const res = await this.pool.query(
      `DELETE FROM connector_ledger_rows
       WHERE user_id = $1 AND connector_id = $2 AND occurred_at < now() - make_interval(months => $3::int)`,
      [this.userId(), connectorId, months],
    );
    return res.rowCount ?? 0;
  }

  async newestFetchedAt(): Promise<Record<string, string>> {
    const res = await this.pool.query(
      `SELECT connector_id, max(fetched_at) AS newest FROM connector_ledger_rows
       WHERE user_id = $1 GROUP BY connector_id`,
      [this.userId()],
    );
    const out: Record<string, string> = {};
    for (const r of res.rows) {
      const t = iso(r.newest);
      if (t) out[String(r.connector_id)] = t;
    }
    return out;
  }
}
