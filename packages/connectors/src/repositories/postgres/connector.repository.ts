import type { ConnectorRepository } from '../interfaces/connector.repository.js';
import type { ConnectorRow, ConnectorStatus, ConnectorSyncOutcome, ConnectorUpsert } from '../../types.js';
import { PgRepository, iso } from './base.repository.js';

const COLUMNS = `connector_id, enabled, status, schedule_minutes, last_success_at, last_error_at, last_error,
  consecutive_failures, cursor, config, created_at, updated_at`;

function toRow(r: Record<string, unknown>): ConnectorRow {
  return {
    connector_id: String(r.connector_id),
    enabled: Boolean(r.enabled),
    status: String(r.status) as ConnectorStatus,
    schedule_minutes: r.schedule_minutes == null ? null : Number(r.schedule_minutes),
    last_success_at: iso(r.last_success_at),
    last_error_at: iso(r.last_error_at),
    last_error: r.last_error == null ? null : String(r.last_error),
    consecutive_failures: Number(r.consecutive_failures ?? 0),
    cursor: r.cursor ?? null,
    config: (r.config as Record<string, unknown>) ?? {},
    created_at: iso(r.created_at) ?? '',
    updated_at: iso(r.updated_at) ?? '',
  };
}

export class PgConnectorRepository extends PgRepository implements ConnectorRepository {
  async list(): Promise<ConnectorRow[]> {
    const res = await this.pool.query(
      `SELECT ${COLUMNS} FROM connectors WHERE user_id = $1 ORDER BY connector_id`,
      [this.userId()],
    );
    return res.rows.map(toRow);
  }

  async get(connectorId: string): Promise<ConnectorRow | null> {
    const res = await this.pool.query(
      `SELECT ${COLUMNS} FROM connectors WHERE user_id = $1 AND connector_id = $2`,
      [this.userId(), connectorId],
    );
    return res.rows[0] ? toRow(res.rows[0]) : null;
  }

  async upsert(connectorId: string, patch: ConnectorUpsert): Promise<ConnectorRow> {
    const res = await this.pool.query(
      `INSERT INTO connectors (user_id, connector_id, enabled, schedule_minutes, config)
       VALUES ($1, $2, COALESCE($3, false), $4, COALESCE($5::jsonb, '{}'::jsonb))
       ON CONFLICT (user_id, connector_id) DO UPDATE SET
         enabled          = COALESCE($3, connectors.enabled),
         schedule_minutes = CASE WHEN $6 THEN $4 ELSE connectors.schedule_minutes END,
         config           = COALESCE($5::jsonb, connectors.config),
         updated_at       = now()
       RETURNING ${COLUMNS}`,
      [
        this.userId(),
        connectorId,
        patch.enabled ?? null,
        patch.schedule_minutes ?? null,
        patch.config === undefined ? null : JSON.stringify(patch.config),
        patch.schedule_minutes !== undefined,
      ],
    );
    return toRow(res.rows[0]);
  }

  async recordSync(connectorId: string, outcome: ConnectorSyncOutcome): Promise<void> {
    if (outcome.ok) {
      await this.pool.query(
        `UPDATE connectors SET status = $3, last_success_at = now(), last_error = NULL,
           consecutive_failures = 0, cursor = COALESCE($4::jsonb, cursor), updated_at = now()
         WHERE user_id = $1 AND connector_id = $2`,
        [this.userId(), connectorId, outcome.status, outcome.cursor === undefined ? null : JSON.stringify(outcome.cursor)],
      );
    } else {
      await this.pool.query(
        `UPDATE connectors SET status = $3, last_error_at = now(), last_error = $4,
           consecutive_failures = consecutive_failures + 1, updated_at = now()
         WHERE user_id = $1 AND connector_id = $2`,
        [this.userId(), connectorId, outcome.status, outcome.error ?? null],
      );
    }
  }

  async setStatus(connectorId: string, status: ConnectorStatus): Promise<void> {
    await this.pool.query(
      `UPDATE connectors SET status = $3, updated_at = now() WHERE user_id = $1 AND connector_id = $2`,
      [this.userId(), connectorId, status],
    );
  }
}
