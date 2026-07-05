import type { Pool } from 'pg';
import { defaultOptionOf, type TrayDecisionOption } from '../tray.js';
import { insertSystemMessage, createSchedulerEvent } from '../utils/system-message.js';
import { logger } from '../utils/logger.js';

interface TrayItemExpiryConfig {
  /** How often to scan. Cheap single-index query; 10 min default. */
  intervalMinutes: number;
  userId: string;
}

/**
 * Expiry sweep for agent-filed decision cards (tray_items, migration 037).
 *
 * Interaction model §3: "cards expire with the agent's default applied AND
 * disclosed — review always concludes." This sweep is deliberately dumb: it
 * only FLIPS open rows past expires_at to 'expired' and notifies the agent
 * with the default that now applies — the AGENT performs the default action
 * (it filed the card; it owns the domain write). The escalation-honesty line
 * on the card already told the user this default would apply, so the notice
 * says so.
 */
export class TrayItemExpiry {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private pool: Pool,
    private config: TrayItemExpiryConfig,
  ) {}

  start(): void {
    logger.info('[TrayItemExpiry][start] Started', {
      intervalMinutes: this.config.intervalMinutes,
      userId: this.config.userId,
    });
    this.timer = setInterval(() => void this.tick(), this.config.intervalMinutes * 60_000);
    // Run once on start to catch backlog immediately (restart during a deadline).
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    let expired: Array<{
      id: string;
      question: string;
      options: TrayDecisionOption[] | null;
      default_key: string | null;
    }>;
    try {
      const res = await this.pool.query(
        `UPDATE tray_items
         SET status = 'expired'
         WHERE user_id = $1 AND status = 'open'
           AND expires_at IS NOT NULL AND expires_at < now()
         RETURNING id, question, options, default_key`,
        [this.config.userId],
      );
      expired = res.rows;
    } catch (err) {
      // 42P01 = table missing (pre-migration deploy) — quiet skip, like the tray.
      if ((err as { code?: string } | null)?.code === '42P01') return;
      logger.error('[TrayItemExpiry][tick] Failed', {
        userId: this.config.userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (expired.length === 0) return;

    logger.info('[TrayItemExpiry][tick] Expired decision cards', {
      userId: this.config.userId,
      count: expired.length,
      ids: expired.map((r) => r.id),
    });

    for (const row of expired) {
      const fallback = defaultOptionOf(row.options ?? [], row.default_key) as TrayDecisionOption | undefined;
      const label = fallback?.label ?? '(no default)';
      await insertSystemMessage(
        this.pool,
        this.config.userId,
        `[Decision] expired: applied default '${label}' for: ${row.question} — user was told the default would apply`,
        undefined,
        createSchedulerEvent('tray_item_expiry'),
      );
    }
  }
}
