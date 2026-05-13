import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';

interface StuckMessageSweepConfig {
  /** How often to scan. */
  intervalMinutes: number;
  /** Rows older than this in pending/processing status are considered stuck. */
  stuckAfterMinutes: number;
  /** Which channels are eligible for auto-flip to delivered. Default ['system'].
   *  user-visible channels (web/android/cli) keep waiting for an explicit
   *  agent reply to flip them — the user-facing UX needs that signal. */
  channels: string[];
  /** Optional user_id scoping. Empty = all users. */
  userId?: string;
}

/**
 * Periodic sweep that flips long-pending/processing system messages to
 * `delivered`. Closes the gap caused by claude legitimately handling a
 * system event via push_to_user / journal / silent acknowledgment instead
 * of via the `reply` tool — without an explicit reply_to_id, channel MCP
 * never gets a chance to mark `delivered`, and the row pins at
 * `processing` (or `pending` if the PATCH to processing failed first).
 *
 * On 2026-05-12 this leaked 15+ rows pinned for 30+ hours that the
 * pending-age channel-liveness monitor read as "agent disconnected".
 * Channel MCP now marks system rows `delivered` directly on delivery
 * (ll5-run commit f56a..), but this sweep is the safety net for any row
 * that slips through (network blip on the PATCH, future code path that
 * forgets to mark, etc.).
 *
 * Per-row update path uses parameterised SQL with explicit user_id filter
 * when configured — no destructive wildcards.
 */
export class StuckMessageSweep {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private pool: Pool,
    private config: StuckMessageSweepConfig,
  ) {}

  start(): void {
    logger.info('[StuckMessageSweep][start] Started', {
      intervalMinutes: this.config.intervalMinutes,
      stuckAfterMinutes: this.config.stuckAfterMinutes,
      channels: this.config.channels,
      userId: this.config.userId ?? '<all>',
    });
    this.timer = setInterval(() => void this.tick(), this.config.intervalMinutes * 60_000);
    // Run once on start to catch backlog immediately.
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    try {
      const { channels, stuckAfterMinutes, userId } = this.config;
      // Build a parameterised query. channels[] uses ANY() so the array can
      // be any length without composing the SQL string at runtime.
      const params: Array<string | number | string[]> = [channels, stuckAfterMinutes];
      let userClause = '';
      if (userId) {
        params.push(userId);
        userClause = `AND user_id = $${params.length}::uuid`;
      }

      const sql = `
        UPDATE chat_messages
        SET status = 'delivered'
        WHERE channel = ANY($1::text[])
          AND status IN ('pending', 'processing')
          AND created_at < now() - ($2 || ' minutes')::interval
          ${userClause}
        RETURNING id
      `;
      const result = await this.pool.query(sql, params);
      if (result.rowCount && result.rowCount > 0) {
        logger.info('[StuckMessageSweep][tick] Flipped stuck rows to delivered', {
          count: result.rowCount,
          channels,
          stuckAfterMinutes,
        });
      } else {
        logger.debug('[StuckMessageSweep][tick] No stuck rows found');
      }
    } catch (err) {
      logger.error('[StuckMessageSweep][tick] Failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
