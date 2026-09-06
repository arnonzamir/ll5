/**
 * One connector pull + the maintenance step that runs inside every sync
 * (docs/design/connectors.md, Section 3): reconcile events against ledger rows,
 * expire events unmatched after 48 h (as findings when the connector has a
 * ledger feed at all), and apply retention. Never wakes the agent — the
 * gateway reads the returned findings and decides.
 */
import { logAudit } from '@ll5/shared';
import type { Repositories } from './repositories/postgres/index.js';
import type { ConnectorAdapterRegistry } from './adapters/registry.js';
import type { OtpStore } from './otp.js';
import type { FindingRecord } from './types.js';
import { reconcile } from './reconcile.js';
import { logger } from './utils/logger.js';

export const SYNC_MIN_INTERVAL_MS = 10 * 60_000;
export const RECONCILE_WINDOW_DAYS = 3;
export const RECONCILE_LOOKBACK_DAYS = 30;
export const EVENT_EXPIRE_HOURS = 48;
export const PAYLOAD_RETENTION_DAYS = 90;
export const LEDGER_RETENTION_MONTHS_DEFAULT = 24;
export const FINDING_RETENTION_MONTHS = 12;

/** Adapters throw this when the source rejected the credentials. */
export class AdapterAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterAuthError';
  }
}

export type SyncRefusalReason = 'unknown_connector' | 'no_adapter' | 'disabled' | 'rate_limited' | 'no_credentials';

export interface MaintenanceCounts {
  matched: number;
  expired: number;
  findings_opened: number;
  payloads_nulled: number;
  ledger_rows_deleted: number;
  findings_deleted: number;
}

export type SyncResult =
  | {
      ok: true;
      connector_id: string;
      pulled: number;
      inserted: number;
      updated: number;
      maintenance: MaintenanceCounts;
      findings: FindingRecord[];
    }
  | {
      ok: false;
      connector_id: string;
      reason: SyncRefusalReason;
      retry_after_seconds?: number;
      maintenance?: MaintenanceCounts;
    }
  | {
      ok: false;
      connector_id: string;
      reason: 'pull_failed';
      status: 'auth_failed' | 'error';
      error: string;
      findings: FindingRecord[];
    };

export interface SyncDeps {
  repos: Repositories;
  registry: ConnectorAdapterRegistry;
  otp: OtpStore;
  getUserId: () => string;
  now?: () => number;
}

export class SyncService {
  /** `${userId}:${connectorId}` → last pull start (ms). In memory, per process. */
  private readonly lastPull = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly deps: SyncDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  async run(connectorId: string): Promise<SyncResult> {
    const { repos, registry } = this.deps;
    const userId = this.deps.getUserId();

    const adapter = registry.get(connectorId);
    if (!adapter) {
      // No pull possible, but the retention/reconcile step still runs for
      // event-fed and skill-fed connectors.
      const maintenance = await this.maintain(connectorId);
      return { ok: false, connector_id: connectorId, reason: 'no_adapter', maintenance };
    }

    const row = await repos.connectors.get(connectorId);
    if (!row || !row.enabled) {
      return { ok: false, connector_id: connectorId, reason: 'disabled' };
    }

    const key = `${userId}:${connectorId}`;
    const last = this.lastPull.get(key);
    if (last != null && this.now() - last < SYNC_MIN_INTERVAL_MS) {
      const retry = Math.ceil((SYNC_MIN_INTERVAL_MS - (this.now() - last)) / 1000);
      return { ok: false, connector_id: connectorId, reason: 'rate_limited', retry_after_seconds: retry };
    }

    const creds = await repos.credentials.get(connectorId);
    if (!creds) {
      return { ok: false, connector_id: connectorId, reason: 'no_credentials' };
    }

    this.lastPull.set(key, this.now());
    let pulled: { rows: Awaited<ReturnType<typeof adapter.pull>>['rows']; cursor: unknown };
    try {
      pulled = await adapter.pull(creds.secret, row.cursor, {
        waitForOtp: (timeoutMs) => this.deps.otp.waitFor(userId, connectorId, timeoutMs),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof AdapterAuthError ? 'auth_failed' : 'error';
      logger.error('[SyncService][run] pull failed', { connectorId, status, error: message });
      await repos.connectors.recordSync(connectorId, { ok: false, status, error: message });
      const findings: FindingRecord[] = [];
      if (status === 'auth_failed') {
        findings.push(await repos.findings.open({
          connector_id: connectorId,
          kind: 'auth_failed',
          summary: `${connectorId}: the source rejected the stored credentials`,
        }));
      }
      logAudit({
        user_id: userId, source: 'connectors', action: 'connector_sync', entity_type: 'connector', entity_id: connectorId,
        summary: `Sync ${connectorId} failed (${status})`, metadata: { status },
      });
      return { ok: false, connector_id: connectorId, reason: 'pull_failed', status, error: message, findings };
    }

    const counts = await repos.ledger.upsertMany(connectorId, pulled.rows);
    await repos.connectors.recordSync(connectorId, { ok: true, status: 'ok', cursor: pulled.cursor });
    const maintenance = await this.maintain(connectorId);
    const findings = await repos.findings.listOpen(connectorId);

    logAudit({
      user_id: userId, source: 'connectors', action: 'connector_sync', entity_type: 'connector', entity_id: connectorId,
      summary: `Sync ${connectorId}: ${pulled.rows.length} rows`, metadata: { pulled: pulled.rows.length, ...counts, ...maintenance },
    });

    return { ok: true, connector_id: connectorId, pulled: pulled.rows.length, ...counts, maintenance, findings };
  }

  /** Reconcile + expire + retention for one connector. Safe to run any time. */
  async maintain(connectorId: string): Promise<MaintenanceCounts> {
    const { repos } = this.deps;
    const nowMs = this.now();
    const day = 24 * 3_600_000;

    const events = await repos.events.openForReconcile(connectorId, new Date(nowMs - RECONCILE_LOOKBACK_DAYS * day).toISOString());
    let matched = 0;
    if (events.length > 0) {
      const rows = await repos.ledger.forReconcile(
        connectorId,
        new Date(nowMs - (RECONCILE_LOOKBACK_DAYS + RECONCILE_WINDOW_DAYS) * day).toISOString(),
        new Date(nowMs + RECONCILE_WINDOW_DAYS * day).toISOString(),
      );
      const result = reconcile(events, rows, { windowDays: RECONCILE_WINDOW_DAYS });
      matched = await repos.events.markMatched(result.matches);
    }

    const expired = await repos.events.expireOpenOlderThan(connectorId, EVENT_EXPIRE_HOURS);
    let findings_opened = 0;
    // An unmatched event is only a finding when there is a ledger to match against.
    if (expired.length > 0 && (await repos.ledger.count(connectorId)) > 0) {
      for (const ev of expired) {
        await repos.findings.open({
          connector_id: connectorId,
          kind: 'unmatched_event',
          summary: `${connectorId}: ${ev.kind} event of ${ev.occurred_at.slice(0, 10)} has no ledger row after ${EVENT_EXPIRE_HOURS} h`,
          ref_id: ev.id,
          delivered: 'digest',
        });
        findings_opened++;
      }
    }

    const row = await repos.connectors.get(connectorId);
    const retentionMonths = Number(row?.config?.retention_months ?? LEDGER_RETENTION_MONTHS_DEFAULT) || LEDGER_RETENTION_MONTHS_DEFAULT;
    const payloads_nulled = await repos.events.nullPayloadsOlderThan(PAYLOAD_RETENTION_DAYS);
    const ledger_rows_deleted = await repos.ledger.deleteOlderThan(connectorId, retentionMonths);
    const findings_deleted = await repos.findings.deleteResolvedOlderThan(FINDING_RETENTION_MONTHS);

    return { matched, expired: expired.length, findings_opened, payloads_nulled, ledger_rows_deleted, findings_deleted };
  }
}
