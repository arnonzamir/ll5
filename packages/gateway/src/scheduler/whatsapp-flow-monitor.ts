import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { raiseAlert, clearAlert } from '../utils/alerting.js';
import { withSchedulerHealth } from '../utils/scheduler-health.js';

interface WhatsAppFlowMonitorConfig {
  /** How often to check (minutes). */
  intervalMinutes: number;
  /** Alert if no inbound WhatsApp messages for this many hours during active hours. */
  stalenessHours: number;
  /** Cross-channel early trigger: if WhatsApp has been silent longer than this
   *  (minutes) WHILE another channel is actively flowing, it's a WhatsApp-specific
   *  outage now — don't wait for the flat stalenessHours window. */
  fastStaleMinutes: number;
  /** A non-WhatsApp channel seen within this many minutes counts as "the pipeline
   *  is alive", making a silent WhatsApp a divergence signal. */
  otherChannelFreshMinutes: number;
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
      const ageMinutes = lastMs !== null ? (Date.now() - lastMs) / 60_000 : null;

      // Cross-channel divergence: is ANOTHER inbound channel flowing right now?
      // If so, a silent WhatsApp is a WhatsApp-specific fault we can catch in
      // ~45 min instead of waiting out the flat 2h window (2026-07-06: the
      // webhook jammed at 09:07, other channels kept flowing, but the flat
      // threshold hadn't tripped when the user noticed).
      let otherFreshMinutes: number | null = null;
      try {
        const otherRes = await this.es.search<{ timestamp: string }>({
          index: 'll5_awareness_messages',
          size: 1,
          sort: [{ timestamp: { order: 'desc' } }],
          query: {
            bool: {
              filter: [
                { term: { user_id: this.config.userId } },
                { term: { from_me: false } },
              ],
              must_not: [{ term: { app: 'whatsapp' } }],
            },
          },
        });
        const otherTs = otherRes.hits?.hits?.[0]?._source?.timestamp ?? null;
        if (otherTs) otherFreshMinutes = (Date.now() - new Date(otherTs).getTime()) / 60_000;
      } catch {
        /* other-channel probe is best-effort; fall back to the flat threshold */
      }

      const flatStale = ageHours === null || ageHours > this.config.stalenessHours;
      const divergenceStale =
        ageMinutes !== null &&
        ageMinutes > this.config.fastStaleMinutes &&
        otherFreshMinutes !== null &&
        otherFreshMinutes <= this.config.otherChannelFreshMinutes;
      const stale = flatStale || divergenceStale;

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
        await clearAlert(this.pool, this.config.userId, 'channel.whatsapp');
        logger.debug('[WhatsAppFlowMonitor][tick] WhatsApp flowing', snapshot as unknown as Record<string, unknown>);
        return;
      }

      // Stale. Only RAISE during active hours (a quiet inbox at 3am is normal,
      // not an outage); an alert already firing from earlier persists overnight.
      const hour = this.getCurrentHour();
      if (hour < this.config.startHour || hour >= this.config.endHour) {
        logger.info('[WhatsAppFlowMonitor][tick] Stale WhatsApp outside active hours — not raising', snapshot as unknown as Record<string, unknown>);
        return;
      }

      const bodyAge = ageHours === null
        ? 'no messages on record'
        : ageMinutes !== null && ageMinutes < 90
          ? `last inbound ${Math.round(ageMinutes)}m ago`
          : `last inbound ${Math.round(ageHours ?? 0)}h ago`;
      const divergenceNote =
        divergenceStale && !flatStale
          ? ` (other channels flowing ${Math.round(otherFreshMinutes ?? 0)}m ago — WhatsApp-specific)`
          : '';
      logger.error('[WhatsAppFlowMonitor][alert] WhatsApp flow stalled', {
        ...(snapshot as unknown as Record<string, unknown>),
        divergenceStale,
        otherFreshMinutes,
      });
      await raiseAlert(this.pool, {
        userId: this.config.userId,
        key: 'channel.whatsapp',
        severity: 'critical',
        summary: `WhatsApp ingestion stalled${divergenceNote}`,
        value: bodyAge,
        expected:
          divergenceStale && !flatStale
            ? `< ${Math.round(this.config.fastStaleMinutes)}m while other channels flow`
            : `< ${Math.round(this.config.stalenessHours)}h`,
        suggestion:
          'Check the gateway whatsapp.dlq for poison messages and Evolution webhook delivery; ' +
          'if ghost-connected, call restart_whatsapp_account or restart the evolution container.',
      });
    }); } catch {
      // withSchedulerHealth already recorded the failure + logged at error.
    }
  }
}
