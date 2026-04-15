import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { sendFCMNotification } from '../utils/fcm-sender.js';

interface ChannelLivenessConfig {
  /** How often to check (minutes). */
  intervalMinutes: number;
  /** Oldest inbound message age (seconds) that still counts as "delivery in flight". */
  stalenessSeconds: number;
  startHour: number;
  endHour: number;
  timezone: string;
  userId: string;
}

export interface ChannelLivenessSnapshot {
  userId: string;
  pending_inbound: number;
  oldest_pending_age_seconds: number | null;
  last_outbound_at: string | null;
  last_delivered_at: string | null;
  stale: boolean;
  checked_at: string;
}

const CACHED_SNAPSHOT: Map<string, ChannelLivenessSnapshot> = new Map();

/** Latest snapshot for a user — powers the /admin/health endpoint. */
export function getLivenessSnapshot(userId: string): ChannelLivenessSnapshot | undefined {
  return CACHED_SNAPSHOT.get(userId);
}

/** All snapshots across all users. */
export function getAllLivenessSnapshots(): ChannelLivenessSnapshot[] {
  return [...CACHED_SNAPSHOT.values()];
}

/**
 * Channel liveness monitor — detects the "channel MCP looks alive but isn't
 * delivering" failure mode. The bridge's job is to move inbound rows from
 * `status='pending'` → `status='processing'` within seconds. If rows pile up
 * during active hours, the bridge is broken somewhere and the user gets no
 * signal, so we push a critical FCM to make them open the laptop.
 *
 * This is the layer that catches bugs the client-side watchdog cannot —
 * a zombie channel MCP whose process is alive but whose SSE reader has stalled.
 */
export class ChannelLivenessMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastAlertAt: number = 0;
  private readonly ALERT_COOLDOWN_MS = 10 * 60 * 1000; // don't re-spam within 10 min

  constructor(
    private pool: Pool,
    private config: ChannelLivenessConfig,
  ) {}

  start(): void {
    logger.info('[ChannelLivenessMonitor][start] Started', {
      userId: this.config.userId,
      intervalMinutes: this.config.intervalMinutes,
      stalenessSeconds: this.config.stalenessSeconds,
    });
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.intervalMinutes * 60 * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private getCurrentHour(): number {
    return parseInt(
      new Intl.DateTimeFormat('en-US', {
        timeZone: this.config.timezone,
        hour: 'numeric',
        hour12: false,
      }).format(new Date()),
      10,
    );
  }

  private async tick(): Promise<void> {
    try {
      // Oldest pending inbound + count
      const pendingResult = await this.pool.query<{ count: string; oldest: Date | null }>(
        `SELECT COUNT(*)::int AS count, MIN(created_at) AS oldest
         FROM chat_messages
         WHERE user_id = $1
           AND direction = 'inbound'
           AND status = 'pending'`,
        [this.config.userId],
      );

      const pendingCount = parseInt(pendingResult.rows[0]?.count ?? '0', 10);
      const oldestPending = pendingResult.rows[0]?.oldest;
      const oldestAgeSec = oldestPending
        ? Math.round((Date.now() - new Date(oldestPending).getTime()) / 1000)
        : null;

      // Last outbound from the assistant and last delivered inbound
      const assistantResult = await this.pool.query<{ created_at: Date | null }>(
        `SELECT MAX(created_at) AS created_at
         FROM chat_messages
         WHERE user_id = $1 AND direction = 'outbound' AND role = 'assistant'`,
        [this.config.userId],
      );
      const deliveredResult = await this.pool.query<{ created_at: Date | null }>(
        `SELECT MAX(created_at) AS created_at
         FROM chat_messages
         WHERE user_id = $1
           AND direction = 'inbound'
           AND status IN ('processing', 'delivered')`,
        [this.config.userId],
      );

      const stale = oldestAgeSec !== null && oldestAgeSec > this.config.stalenessSeconds;

      const snapshot: ChannelLivenessSnapshot = {
        userId: this.config.userId,
        pending_inbound: pendingCount,
        oldest_pending_age_seconds: oldestAgeSec,
        last_outbound_at: assistantResult.rows[0]?.created_at?.toISOString() ?? null,
        last_delivered_at: deliveredResult.rows[0]?.created_at?.toISOString() ?? null,
        stale,
        checked_at: new Date().toISOString(),
      };
      CACHED_SNAPSHOT.set(this.config.userId, snapshot);

      const snapshotCtx = { ...snapshot } as Record<string, unknown>;
      if (!stale) {
        logger.debug('[ChannelLivenessMonitor][tick] Channel healthy', snapshotCtx);
        return;
      }

      // Only alert during active hours
      const hour = this.getCurrentHour();
      if (hour < this.config.startHour || hour >= this.config.endHour) {
        logger.info('[ChannelLivenessMonitor][tick] Stale channel outside active hours — not alerting', snapshotCtx);
        return;
      }

      // Cooldown so we don't spam the user every 2 min
      if (Date.now() - this.lastAlertAt < this.ALERT_COOLDOWN_MS) {
        logger.debug('[ChannelLivenessMonitor][tick] Stale channel but within cooldown', snapshotCtx);
        return;
      }
      this.lastAlertAt = Date.now();

      logger.error('[ChannelLivenessMonitor][alert] Channel bridge stale', snapshotCtx);

      await sendFCMNotification(this.pool, this.config.userId, {
        title: 'LL5 channel bridge stalled',
        body: `${pendingCount} message(s) undelivered, oldest ${Math.round(oldestAgeSec! / 60)}min. Open LL5 on the laptop or run ./ll5 --resume.`,
        type: 'channel_stall',
        notification_level: 'critical',
        data: {
          pending: String(pendingCount),
          age_seconds: String(oldestAgeSec),
        },
      });
    } catch (err) {
      logger.warn('[ChannelLivenessMonitor][tick] Failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
