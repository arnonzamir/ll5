/**
 * Scheduled ledger pulls (docs/design/connectors.md, Section 2: "Scheduling of
 * pulls — gateway ConnectorSyncScheduler calls the MCP's POST /api/sync").
 *
 * Every `intervalMinutes` (default 15) per user, for each catalog entry that
 * has a ledger feed AND a default cadence, POST /api/sync { connector_id,
 * scheduled: true }. The SERVICE owns the cadence: it answers
 * `{ ok:false, reason:'not_due' }` until last_success_at + schedule_minutes has
 * passed (the per-user schedule_minutes override lives on its row), so this
 * scheduler stays a dumb, cheap ticker. Refusals that mean "nothing to do"
 * (not_due, disabled, no_credentials, no_adapter) are counted and otherwise
 * ignored; a real failure raises `connector.<id>.sync` (warning) and a later
 * success clears it. Nothing here wakes the agent directly — the alert spine
 * does that on the raise edge with its own cadence.
 */
import type { Pool } from 'pg';
import { CONNECTOR_CATALOG } from '@ll5/shared';
import { logger } from '../utils/logger.js';
import { raiseAlert, clearAlert } from '../utils/alerting.js';
import { withSchedulerHealth } from '../utils/scheduler-health.js';
import { createConnectorsClient, type ConnectorsClient, type ConnectorSyncResponse } from '../connectors/client.js';

export const DEFAULT_CONNECTOR_SYNC_INTERVAL_MINUTES = 15;

/** Refusals that are the normal state of a connector, not a failure. */
export const SILENT_SYNC_REASONS = new Set(['not_due', 'disabled', 'no_credentials', 'no_adapter']);

/** Catalog ids the scheduler pulls for: ledger feed + a default cadence. */
export function scheduledSyncTargets(): string[] {
  return CONNECTOR_CATALOG.filter((c) => c.kinds.includes('ledger') && c.default_schedule_minutes != null).map((c) => c.id);
}

export function alertKeyFor(connectorId: string): string {
  return `connector.${connectorId}.sync`;
}

export interface ConnectorSyncConfig {
  userId: string;
  intervalMinutes?: number;
  /** settings.scheduler.connector_sync_enabled; default true. */
  enabled?: boolean;
}

export interface ConnectorSyncTickCounts {
  attempted: number;
  synced: number;
  not_due: number;
  skipped: number;
  failed: number;
}

export class ConnectorSyncScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly client: ConnectorsClient;
  private readonly intervalMs: number;
  private readonly enabled: boolean;
  /** Alert keys currently raised by this scheduler (per process) so a recovery clears exactly what fired. */
  private readonly firing = new Set<string>();
  /** Keys cleared at least once since boot (a firing alert from before a restart is cleared on the first success). */
  private readonly clearedOnce = new Set<string>();

  constructor(
    private readonly pool: Pool,
    private readonly config: ConnectorSyncConfig,
    client?: ConnectorsClient,
  ) {
    this.client = client ?? createConnectorsClient();
    this.intervalMs = Math.max(1, config.intervalMinutes ?? DEFAULT_CONNECTOR_SYNC_INTERVAL_MINUTES) * 60_000;
    this.enabled = config.enabled ?? true;
  }

  start(): void {
    if (!this.enabled) {
      logger.info('[ConnectorSyncScheduler][start] disabled by settings.scheduler.connector_sync_enabled', { userId: this.config.userId });
      return;
    }
    logger.info('[ConnectorSyncScheduler][start] started', {
      userId: this.config.userId,
      intervalMinutes: this.intervalMs / 60_000,
      targets: scheduledSyncTargets(),
      baseUrl: this.client.baseUrl,
    });
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    // First tick shortly after boot (not immediately: the connectors service boots alongside).
    setTimeout(() => void this.tick(), 30_000).unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    try {
      await withSchedulerHealth('connector_sync', () => this.run());
    } catch {
      // withSchedulerHealth already recorded + logged the failure.
    }
  }

  /** One pass over the targets. Exposed for tests; throws only when the service is unreachable. */
  async run(): Promise<ConnectorSyncTickCounts> {
    const counts: ConnectorSyncTickCounts = { attempted: 0, synced: 0, not_due: 0, skipped: 0, failed: 0 };
    const userId = this.config.userId;

    for (const connectorId of scheduledSyncTargets()) {
      counts.attempted++;
      let result: ConnectorSyncResponse;
      try {
        result = await this.client.postSync(userId, connectorId, { scheduled: true });
      } catch (err) {
        // Transport-level: the service is down or the token cannot be minted. One
        // error for the whole tick (mcp-health-monitor owns the "service down" alert).
        throw new Error(`connectors MCP unreachable while syncing ${connectorId}: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (result.ok) {
        counts.synced++;
        await this.clear(connectorId);
        continue;
      }
      const reason = result.reason ?? 'unknown';
      if (reason === 'not_due') {
        counts.not_due++;
        continue;
      }
      if (SILENT_SYNC_REASONS.has(reason)) {
        counts.skipped++;
        continue;
      }
      counts.failed++;
      await this.raise(connectorId, result);
    }

    logger.info('[ConnectorSyncScheduler][run] tick', { userId, ...counts });
    return counts;
  }

  private async raise(connectorId: string, result: ConnectorSyncResponse): Promise<void> {
    const key = alertKeyFor(connectorId);
    const cause = result.code ?? result.status ?? result.reason ?? 'failed';
    // `error` is the adapter's message: never a credential (adapters do not echo them), but keep it short.
    const detail = typeof result.error === 'string' ? result.error.slice(0, 160) : '';
    this.firing.add(key);
    await raiseAlert(this.pool, {
      userId: this.config.userId,
      key,
      severity: 'warning',
      summary: `Connector ${connectorId}: scheduled sync failed (${cause})`,
      value: detail ? `${cause}: ${detail}` : cause,
      expected: 'ok',
      suggestion:
        cause === 'auth_failed'
          ? `Re-enter the ${connectorId} credentials on the dashboard (Settings → Connectors).`
          : cause === 'plan_not_eligible'
            ? `The ${connectorId} plan does not cover the data endpoint the adapter reads; check the plan in the provider's app.`
            : `Check the connectors service log for ${connectorId}; run sync_connector to retry now.`,
    });
  }

  private async clear(connectorId: string): Promise<void> {
    const key = alertKeyFor(connectorId);
    // clearAlert is a no-op when nothing fires; skip the DB round trip when this
    // process never raised it AND it is not the first pass after a restart.
    if (!this.firing.has(key) && this.clearedOnce.has(key)) return;
    this.firing.delete(key);
    this.clearedOnce.add(key);
    await clearAlert(this.pool, this.config.userId, key);
  }
}
