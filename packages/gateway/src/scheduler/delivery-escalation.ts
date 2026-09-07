import type { Pool } from 'pg';
import type { Client } from '@elastic/elasticsearch';
import { logger } from '../utils/logger.js';
import { withSchedulerHealth } from '../utils/scheduler-health.js';
import { computeDeliveryMode } from '../utils/delivery-mode.js';
import type { DeliveryMode } from '../utils/delivery-mode.js';
import { getEffectiveTimezone } from '../utils/timezone.js';
import { nextRung } from '../utils/delivery-contract.js';
import {
  expireDelivery, isPastGrace, listOpenDeliveries, releaseHeldInitialPushes, sendRung,
} from '../delivery.js';
import type { DeliveryRow } from '../delivery.js';
import type { ReachConfig } from '../utils/reach.js';

interface DeliveryEscalationConfig {
  userId: string;
  timezone: string;
  intervalMinutes: number;
  /** Phase 2 of the ladder: the reach rung's self-WhatsApp (messaging MCP + user token). */
  reach?: ReachConfig | null;
}

/**
 * Do-by escalation ladder + ask expiry (DECISION-034 §5). Every tick:
 *
 *   1. release the initial push of do-by rows the quiet-hours hold withheld
 *      (ladder_start = max(send, quiet end) has arrived);
 *   2. for every open ask past due_at + 30 min → missed (do-by) / expired
 *      (needs-you), tray card expired, one `[Tray] missed:` to the agent;
 *   3. for every open do-by, `nextRung` decides: send the lowest unsent rung
 *      whose time has passed (one per tick), hold it in sleep / quiet_hours
 *      unless stakes are critical, or wait.
 *
 * Acknowledgement (tray ack / done) flips status off 'sent', which the
 * listing excludes — the ladder stops by itself. Queries are defensive: a
 * missing table (pre-migration deploy) logs and skips.
 */
export class DeliveryEscalationScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private pool: Pool,
    private es: Client,
    private config: DeliveryEscalationConfig,
  ) {}

  start(): void {
    logger.info('[DeliveryEscalation][start] Started', { userId: this.config.userId, intervalMinutes: this.config.intervalMinutes });
    this.timer = setInterval(() => void this.safeTick(), this.config.intervalMinutes * 60_000);
    void this.safeTick();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private async safeTick(): Promise<void> {
    try { await withSchedulerHealth('delivery_escalation', () => this.tick()); } catch { /* recorded by withSchedulerHealth */ }
  }

  /** One pass; exported for tests. */
  async tick(now = new Date()): Promise<void> {
    const userId = this.config.userId;
    const tz = await getEffectiveTimezone(this.pool, userId).catch(() => this.config.timezone);

    let mode: DeliveryMode = 'normal';
    try {
      mode = (await computeDeliveryMode(this.pool, this.es, userId, tz, now)).mode;
    } catch (err) {
      logger.warn('[DeliveryEscalation][tick] delivery mode unavailable — treating as normal', { error: err instanceof Error ? err.message : String(err) });
    }

    if (mode !== 'sleep' && mode !== 'quiet_hours') {
      await releaseHeldInitialPushes(this.pool, userId, now);
    }

    const open = await listOpenDeliveries(this.pool, userId);
    for (const d of open) {
      try {
        await this.advance(d, now, mode, tz);
      } catch (err) {
        logger.warn('[DeliveryEscalation][tick] delivery processing failed', {
          delivery_id: d.id, error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async advance(d: DeliveryRow, now: Date, mode: DeliveryMode, tz: string): Promise<void> {
    if (d.class === 'fyi') return;

    if (isPastGrace(d, now)) {
      await expireDelivery(this.pool, d, now);
      return;
    }
    if (d.class !== 'do-by' || d.status !== 'sent' || !d.escalation) return;
    // The ladder only runs once the initial push is out (a held do-by waits
    // for quiet hours to end; its rungs were planned from that instant).
    if (d.escalation.initial_push === 'held') return;

    const decision = nextRung(
      { rungs: d.escalation.rungs, rung_sent: d.rung_sent, acknowledged: false, stakes: d.stakes },
      now, mode,
    );
    switch (decision.action) {
      case 'send':
        await sendRung(this.pool, d, decision.index, tz, now, this.config.reach ?? null);
        return;
      case 'hold':
        logger.info('[DeliveryEscalation][tick] rung held by delivery mode', { delivery_id: d.id, rung: decision.rung.rung, mode });
        return;
      default:
        return;
    }
  }
}
