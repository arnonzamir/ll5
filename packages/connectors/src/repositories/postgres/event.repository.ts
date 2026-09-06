import type { ConnectorEventAck, ConnectorEventInput, ConnectorEventKind, ConnectorEventRecord } from '@ll5/shared';
import type { EventRepository, ExpiredEvent } from '../interfaces/event.repository.js';
import type { EventFilters, Page } from '../../types.js';
import type { ReconcileEvent } from '../../reconcile.js';
import { PgRepository, iso, num, currency } from './base.repository.js';

const COLUMNS = `id, connector_id, kind, occurred_at, received_at, amount, currency, is_foreign, account_ref,
  merchant_key, dedupe_key, payload_enc, rule_hits, matched_row_id, status`;

export class PgEventRepository extends PgRepository implements EventRepository {
  private toRecord(r: Record<string, unknown>): ConnectorEventRecord {
    const payload = this.decryptJson(r.payload_enc as string | null, 'PgEventRepository');
    const merchant = typeof payload?.merchant === 'string' ? payload.merchant : null;
    return {
      id: String(r.id),
      connector_id: String(r.connector_id),
      kind: String(r.kind) as ConnectorEventKind,
      occurred_at: iso(r.occurred_at) ?? '',
      received_at: iso(r.received_at) ?? '',
      amount: num(r.amount),
      currency: currency(r.currency),
      foreign: Boolean(r.is_foreign),
      merchant,
      account_ref: r.account_ref == null ? null : String(r.account_ref),
      dedupe_key: String(r.dedupe_key),
      rule_hits: Array.isArray(r.rule_hits) ? (r.rule_hits as string[]) : [],
      matched_row_id: r.matched_row_id == null ? null : String(r.matched_row_id),
      status: String(r.status) as ConnectorEventRecord['status'],
      payload,
    };
  }

  async insert(input: ConnectorEventInput, merchantKey: string | null): Promise<ConnectorEventAck> {
    const userId = this.userId();
    // The merchant lives only inside the encrypted payload (plus its HMAC key).
    const payload = { ...input.payload, ...(input.merchant ? { merchant: input.merchant } : {}) };
    const res = await this.pool.query(
      `INSERT INTO connector_events
         (user_id, connector_id, kind, occurred_at, amount, currency, is_foreign, account_ref,
          merchant_key, dedupe_key, payload_enc, rule_hits)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (user_id, dedupe_key) DO NOTHING
       RETURNING id`,
      [
        userId,
        input.connector_id,
        input.kind,
        input.occurred_at,
        input.amount ?? null,
        input.currency ?? null,
        input.foreign ?? false,
        input.account_ref ?? null,
        merchantKey,
        input.dedupe_key,
        this.encryptJson(payload),
        input.rule_hits ?? [],
      ],
    );
    if (res.rows[0]) return { id: String(res.rows[0].id), created: true };
    const existing = await this.pool.query(
      `SELECT id FROM connector_events WHERE user_id = $1 AND dedupe_key = $2`,
      [userId, input.dedupe_key],
    );
    return { id: String(existing.rows[0].id), created: false };
  }

  async query(f: EventFilters): Promise<Page<ConnectorEventRecord>> {
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
    if (f.status) add('status = ?', f.status);
    params.push(f.limit + 1, f.offset);
    const res = await this.pool.query(
      `SELECT ${COLUMNS} FROM connector_events WHERE ${where.join(' AND ')}
       ORDER BY occurred_at DESC, id LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const hasMore = res.rows.length > f.limit;
    return { items: res.rows.slice(0, f.limit).map((r) => this.toRecord(r)), hasMore };
  }

  async openForReconcile(connectorId: string, sinceIso: string): Promise<ReconcileEvent[]> {
    const res = await this.pool.query(
      `SELECT id, amount, merchant_key, occurred_at FROM connector_events
       WHERE user_id = $1 AND connector_id = $2 AND status = 'open' AND occurred_at >= $3`,
      [this.userId(), connectorId, sinceIso],
    );
    return res.rows.map((r) => ({
      id: String(r.id),
      amount: num(r.amount),
      merchant_key: r.merchant_key == null ? null : String(r.merchant_key),
      occurred_at: iso(r.occurred_at) ?? '',
    }));
  }

  async markMatched(pairs: Array<{ event_id: string; row_id: string }>): Promise<number> {
    if (pairs.length === 0) return 0;
    const userId = this.userId();
    let n = 0;
    for (const p of pairs) {
      const res = await this.pool.query(
        `UPDATE connector_events SET status = 'matched', matched_row_id = $3
         WHERE user_id = $1 AND id = $2 AND status = 'open'`,
        [userId, p.event_id, p.row_id],
      );
      n += res.rowCount ?? 0;
    }
    return n;
  }

  async expireOpenOlderThan(connectorId: string, hours: number): Promise<ExpiredEvent[]> {
    const res = await this.pool.query(
      `UPDATE connector_events SET status = 'expired'
       WHERE user_id = $1 AND connector_id = $2 AND status = 'open'
         AND occurred_at < now() - make_interval(hours => $3::int)
       RETURNING id, connector_id, kind, occurred_at`,
      [this.userId(), connectorId, hours],
    );
    return res.rows.map((r) => ({
      id: String(r.id),
      connector_id: String(r.connector_id),
      kind: String(r.kind),
      occurred_at: iso(r.occurred_at) ?? '',
    }));
  }

  async nullPayloadsOlderThan(days: number): Promise<number> {
    const res = await this.pool.query(
      `UPDATE connector_events SET payload_enc = NULL
       WHERE user_id = $1 AND payload_enc IS NOT NULL
         AND occurred_at < now() - make_interval(days => $2::int)`,
      [this.userId(), days],
    );
    return res.rowCount ?? 0;
  }

  async newestReceivedAt(): Promise<Record<string, string>> {
    const res = await this.pool.query(
      `SELECT connector_id, max(received_at) AS newest FROM connector_events
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
