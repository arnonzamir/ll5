import type { Pool } from 'pg';
import { triggerAgent, getAgentSessionId } from '../utils/agent-trigger.js';
import { logger } from '../utils/logger.js';
import type { SourceRoutingMeta, SchedulerEventMeta } from '../utils/system-message.js';

interface StuckMessageSweepConfig {
  /** How often to scan. */
  intervalMinutes: number;
  /** Rows older than this in pending/processing status are considered stuck. */
  stuckAfterMinutes: number;
  /** Which channels are eligible for auto-flip to delivered. Default ['system'].
   *  user-visible channels (web/android/cli) keep waiting for an explicit
   *  agent reply to flip them — the user-facing UX needs that signal. */
  channels: string[];
  /** PENDING rows older than this get their NOTIFY re-emitted (lost-delivery
   *  recovery) before any flip is considered. */
  renotifyAfterMinutes: number;
  /** How many re-notify attempts a pending row gets before the sweep gives up
   *  and flips it (loudly). */
  maxRenotifies: number;
  /** Optional user_id scoping. Empty = all users. */
  userId?: string;
}

/**
 * Periodic sweep over long-pending/processing system messages, in two passes:
 *
 * PASS A — re-notify lost deliveries. A system row still `pending` minutes
 * after insert was never picked up by the channel MCP at all: its PG NOTIFY
 * is non-durable and is lost when the insert lands inside an SSE-reconnect
 * window (observed 2026-07-02: two gateway restarts orphaned 17 rows,
 * including that evening's [Evening Close] beat). For those rows the sweep
 * re-emits the SAME `new_message` NOTIFY the insert trigger sends (payload
 * shape: migration 018), up to `maxRenotifies` times, tracking attempts in
 * `metadata.re_notify_count`. A `processing` row is NOT re-notified — the
 * channel demonstrably received it.
 *
 * PASS B — flip genuinely handled rows. `processing` rows older than
 * `stuckAfterMinutes` flip to `delivered` (claude legitimately handles system
 * events via push_to_user / journal / silent ack instead of the `reply` tool,
 * so the row never gets flipped by the channel — the original 2026-05-12
 * leak). `pending` rows only flip after their re-notifies are EXHAUSTED, and
 * loudly (error log with ids): before 2026-07-03 the blind flip silently
 * MASKED real delivery loss as "delivered".
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
      renotifyAfterMinutes: this.config.renotifyAfterMinutes,
      maxRenotifies: this.config.maxRenotifies,
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

  private userClause(params: Array<string | number | string[]>): string {
    if (!this.config.userId) return '';
    params.push(this.config.userId);
    return `AND user_id = $${params.length}::uuid`;
  }

  /** PASS A: re-emit the insert trigger's NOTIFY for never-delivered pending rows. */
  private async renotifyLostPending(): Promise<void> {
    const { channels, renotifyAfterMinutes, maxRenotifies } = this.config;
    const params: Array<string | number | string[]> = [channels, renotifyAfterMinutes, maxRenotifies];
    const userClause = this.userClause(params);

    // Bump the attempt counter and re-emit the same `new_message` payload the
    // insert trigger sends (migration 018) so the channel MCP treats it as a
    // fresh delivery. The metadata-only UPDATE does not re-fire the trigger
    // (its UPDATE branch requires a status change), so the explicit pg_notify
    // is the only signal emitted.
    const sql = `
      WITH bumped AS (
        UPDATE chat_messages
        SET metadata = jsonb_set(
              COALESCE(metadata, '{}'::jsonb),
              '{re_notify_count}',
              to_jsonb(COALESCE((metadata->>'re_notify_count')::int, 0) + 1)
            )
        WHERE channel = ANY($1::text[])
          AND status = 'pending'
          AND created_at < now() - ($2 || ' minutes')::interval
          AND COALESCE((metadata->>'re_notify_count')::int, 0) < $3
          ${userClause}
        RETURNING id, user_id, conversation_id, channel, direction, role,
                  content, status, metadata, created_at
      )
      SELECT id, (metadata->>'re_notify_count')::int AS attempt,
             pg_notify('chat_messages', json_build_object(
               'event', 'new_message',
               'id', id,
               'user_id', user_id,
               'conversation_id', conversation_id,
               'channel', channel,
               'direction', direction,
               'role', role,
               'content', substring(content from 1 for 4000),
               'status', status,
               'has_attachments', (metadata ? 'attachments') IS NOT NULL
                 AND jsonb_array_length(metadata -> 'attachments') > 0,
               'source', CASE WHEN metadata ? 'source' THEN metadata -> 'source' ELSE NULL END,
               'created_at', created_at
             )::text)
      FROM bumped
    `;
    const result = await this.pool.query(sql, params);
    if (result.rowCount && result.rowCount > 0) {
      logger.warn('[StuckMessageSweep][renotify] Re-notified lost pending rows', {
        count: result.rowCount,
        ids: result.rows.map((r) => r.id),
        attempts: result.rows.map((r) => r.attempt),
        renotifyAfterMinutes,
      });
      // Agent trigger redelivery (dual-run-variant Phase 2): alongside
      // pg_notify (which re-notifies the Claude Code channel bridge), also
      // call triggerAgent for the opencode variant. This is the redelivery
      // mechanism — if the initial triggerAgent in insertSystemMessage
      // failed, the sweep retries it here. Fire-and-forget per row; a
      // failure here just means the next sweep tick tries again (up to
      // maxRenotifies, after which pass B flips the row to delivered).
      if (process.env.OPENCODE_SERVER_URL) {
        for (const row of result.rows) {
          void (async () => {
            try {
              const sessionId = await getAgentSessionId(this.pool, row.user_id);
              if (!sessionId) return;
              const meta = row.metadata as Record<string, unknown> | null;
              const source = meta?.source as SourceRoutingMeta | undefined;
              const scheduler = meta
                ? ({
                    scheduler: meta.scheduler,
                    event_id: meta.event_id,
                    fired_at: meta.fired_at,
                  } as SchedulerEventMeta | undefined)
                : undefined;
              await triggerAgent(sessionId, {
                content: row.content,
                metadata: {
                  ...(source ? { source } : {}),
                  ...(scheduler ? { scheduler } : {}),
                },
              });
            } catch (err) {
              logger.warn('[StuckMessageSweep][renotify] triggerAgent redelivery failed', {
                id: row.id,
                user_id: row.user_id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          })();
        }
      }
    }
  }

  /** PASS B: flip handled/exhausted rows to delivered. */
  private async flipStuck(): Promise<void> {
    const { channels, stuckAfterMinutes, maxRenotifies } = this.config;
    const params: Array<string | number | string[]> = [channels, stuckAfterMinutes, maxRenotifies];
    const userClause = this.userClause(params);

    // `processing` = the channel received it (original handled-but-unflipped
    // case). `pending` only flips once re-notifies are exhausted — and that is
    // a real delivery loss, logged loudly, never a silent mask.
    const sql = `
      UPDATE chat_messages
      SET status = 'delivered'
      WHERE channel = ANY($1::text[])
        AND created_at < now() - ($2 || ' minutes')::interval
        AND (
          status = 'processing'
          OR (status = 'pending' AND COALESCE((metadata->>'re_notify_count')::int, 0) >= $3)
        )
        ${userClause}
      RETURNING id, (metadata->>'re_notify_count') AS re_notify_count
    `;
    const result = await this.pool.query(sql, params);
    if (result.rowCount && result.rowCount > 0) {
      const lost = result.rows.filter((r) => r.re_notify_count != null);
      logger.info('[StuckMessageSweep][tick] Flipped stuck rows to delivered', {
        count: result.rowCount,
        channels,
        stuckAfterMinutes,
      });
      if (lost.length > 0) {
        logger.error('[StuckMessageSweep][lost] Rows NEVER delivered despite re-notifies — flipped to stop re-processing, but this was a real delivery loss', {
          count: lost.length,
          ids: lost.map((r) => r.id),
        });
      }
    } else {
      logger.debug('[StuckMessageSweep][tick] No stuck rows found');
    }
  }

  private async tick(): Promise<void> {
    try {
      await this.renotifyLostPending();
    } catch (err) {
      logger.error('[StuckMessageSweep][renotify] Failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      await this.flipStuck();
    } catch (err) {
      logger.error('[StuckMessageSweep][tick] Failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
