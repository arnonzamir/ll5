import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { sendFCMNotification } from '../utils/fcm-sender.js';
import { withSchedulerHealth } from '../utils/scheduler-health.js';

interface WhatsAppFlowMonitorConfig {
  /** How often to check (minutes). */
  intervalMinutes: number;
  /** Alert if no inbound WhatsApp messages for this many hours during active hours. */
  stalenessHours: number;
  startHour: number;
  endHour: number;
  timezone: string;
  userId: string;
}

export interface WhatsAppFlowSnapshot {
  userId: string;
  account_count: number;
  last_message_at: string | null;
  last_message_age_hours: number | null;
  stale: boolean;
  checked_at: string;
}

const CACHED_SNAPSHOT: Map<string, WhatsAppFlowSnapshot> = new Map();

export function getWhatsAppFlowSnapshot(userId: string): WhatsAppFlowSnapshot | undefined {
  return CACHED_SNAPSHOT.get(userId);
}

export function getAllWhatsAppFlowSnapshots(): WhatsAppFlowSnapshot[] {
  return [...CACHED_SNAPSHOT.values()];
}

/**
 * WhatsApp flow monitor — detects the "Evolution API ghost-connected" failure.
 *
 * Evolution's connectionState can report `state: open` while the underlying
 * Baileys WhatsApp Web socket has silently desynced and the webhook never
 * fires. The existing mcp-health-monitor only pings /health on our services,
 * and the account's self-reported status lies. The one ground-truth signal
 * is message flow itself: if there's a configured WhatsApp account and
 * nothing has arrived for hours during active hours, something is wrong.
 */
export class WhatsAppFlowMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastAlertAt: number = 0;
  private alertCount: number = 0;
  private readonly ALERT_COOLDOWN_MS = 30 * 60 * 1000;
  private readonly MAX_ALERTS_PER_EPISODE = 2;

  constructor(
    private pool: Pool,
    private es: Client,
    private config: WhatsAppFlowMonitorConfig,
  ) {}

  start(): void {
    logger.info('[WhatsAppFlowMonitor][start] Started', {
      userId: this.config.userId,
      intervalMinutes: this.config.intervalMinutes,
      stalenessHours: this.config.stalenessHours,
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
    try { await withSchedulerHealth('whatsapp_flow_monitor', async () => {
      const accountRes = await this.pool.query<{ count: string }>(
        `SELECT COUNT(*)::int AS count
         FROM messaging_whatsapp_accounts
         WHERE user_id = $1`,
        [this.config.userId],
      );
      const accountCount = parseInt(accountRes.rows[0]?.count ?? '0', 10);

      if (accountCount === 0) {
        const snapshot: WhatsAppFlowSnapshot = {
          userId: this.config.userId,
          account_count: 0,
          last_message_at: null,
          last_message_age_hours: null,
          stale: false,
          checked_at: new Date().toISOString(),
        };
        CACHED_SNAPSHOT.set(this.config.userId, snapshot);
        return;
      }

      // Last inbound WhatsApp message. We ignore outbound (from_me=true) so a
      // silent inbox — even when we're sending — still counts as stalled.
      const searchRes = await this.es.search<{ timestamp: string }>({
        index: 'll5_awareness_messages',
        size: 1,
        sort: [{ timestamp: { order: 'desc' } }],
        query: {
          bool: {
            filter: [
              { term: { user_id: this.config.userId } },
              { term: { app: 'whatsapp' } },
              { term: { from_me: false } },
            ],
          },
        },
      });

      const hits = searchRes.hits?.hits ?? [];
      const lastTs = hits[0]?._source?.timestamp ?? null;
      const lastMs = lastTs ? new Date(lastTs).getTime() : null;
      const ageHours = lastMs !== null ? (Date.now() - lastMs) / (3600 * 1000) : null;
      const stale = ageHours === null || ageHours > this.config.stalenessHours;

      const snapshot: WhatsAppFlowSnapshot = {
        userId: this.config.userId,
        account_count: accountCount,
        last_message_at: lastTs,
        last_message_age_hours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
        stale,
        checked_at: new Date().toISOString(),
      };
      CACHED_SNAPSHOT.set(this.config.userId, snapshot);

      if (!stale) {
        if (this.alertCount > 0) {
          logger.info('[WhatsAppFlowMonitor][tick] Flow recovered, resetting alert counter', { alertCount: this.alertCount });
          this.alertCount = 0;
        }
        logger.debug('[WhatsAppFlowMonitor][tick] WhatsApp flowing', snapshot as unknown as Record<string, unknown>);
        return;
      }

      const hour = this.getCurrentHour();
      if (hour < this.config.startHour || hour >= this.config.endHour) {
        logger.info('[WhatsAppFlowMonitor][tick] Stale WhatsApp outside active hours — not alerting', snapshot as unknown as Record<string, unknown>);
        return;
      }

      if (this.alertCount >= this.MAX_ALERTS_PER_EPISODE) {
        logger.debug('[WhatsAppFlowMonitor][tick] Stale but max alerts reached', { alertCount: this.alertCount });
        return;
      }
      if (Date.now() - this.lastAlertAt < this.ALERT_COOLDOWN_MS) {
        logger.debug('[WhatsAppFlowMonitor][tick] Stale but within cooldown', snapshot as unknown as Record<string, unknown>);
        return;
      }
      this.lastAlertAt = Date.now();
      this.alertCount += 1;

      logger.error('[WhatsAppFlowMonitor][alert] WhatsApp flow stalled', snapshot as unknown as Record<string, unknown>);

      const bodyAge = ageHours === null
        ? 'no messages on record'
        : `last inbound ${Math.round(ageHours)}h ago`;

      await sendFCMNotification(this.pool, this.config.userId, {
        title: 'LL5 WhatsApp stalled',
        body: `No inbound WhatsApp in ${Math.round(this.config.stalenessHours)}h+ (${bodyAge}). Evolution likely ghost-connected — call restart_whatsapp_account or restart the container.`,
        type: 'whatsapp_flow_stall',
        notification_level: 'critical',
        data: {
          last_message_at: lastTs ?? '',
          age_hours: ageHours === null ? '' : String(Math.round(ageHours)),
        },
      });
    }); } catch {
      // withSchedulerHealth already recorded the failure + logged at error.
    }
  }
}
