import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { raiseAlert, clearAlert } from '../utils/alerting.js';
import { withSchedulerHealth } from '../utils/scheduler-health.js';
import { getBridgeLiveness } from '../utils/whatsapp-bridge-liveness.js';

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
  /** Why the last evaluation decided what it did (ISS-013). */
  reason?: FlowReason;
  /** Minutes since ANY Evolution event reached the gateway; null = no event since boot. */
  bridge_event_age_minutes?: number | null;
  connection_state?: 'open' | 'connecting' | 'close' | null;
  /** True when this local hour is empty on ≥ QUIET_HOUR_MIN_ZERO of the last 14 days. */
  quiet_hour?: boolean;
}

const CACHED_SNAPSHOT: Map<string, WhatsAppFlowSnapshot> = new Map();

export function getWhatsAppFlowSnapshot(userId: string): WhatsAppFlowSnapshot | undefined {
  return CACHED_SNAPSHOT.get(userId);
}

export function getAllWhatsAppFlowSnapshots(): WhatsAppFlowSnapshot[] {
  return [...CACHED_SNAPSHOT.values()];
}

// ---------------------------------------------------------------------------
// Policy (pure) — ISS-013, 2026-09-05.
//
// History: over 14 days this monitor raised 14 times, every one between 01:07
// and 05:21 local, all on the flat "no inbound for 2h" rule (once on the
// divergence rule, tripped by a phone notification at 01:31). The inbox is
// simply empty at night — 01:00–05:00 local has zero WhatsApp inbound on 7–10
// of 14 nights — and Evolution showed no fault. The agent answered each alert
// with restarts that changed nothing until people woke up.
//
// Now two ground-truth signals outrank silence:
//   1. connection.update state 'close' (from Evolution) — a real fault, any hour.
//   2. ANY Evolution event within BRIDGE_FRESH_MINUTES (receipts, chat updates,
//      lifecycle) — the bridge is alive; a silent inbox at a quiet hour is fine.
// and silence rules only apply when this hour of day is normally busy
// (quiet_hour = empty on ≥ QUIET_HOUR_MIN_ZERO of the last QUIET_HOUR_DAYS).
// ---------------------------------------------------------------------------
export const BRIDGE_FRESH_MINUTES = 30;
export const CONNECTION_CLOSE_GRACE_MINUTES = 5;
export const QUIET_HOUR_DAYS = 14;
export const QUIET_HOUR_MIN_ZERO = 5;

export type FlowReason =
  | 'connection_closed'
  | 'bridge_alive'
  | 'quiet_hour'
  | 'flat_silence'
  | 'divergence'
  | 'flowing'
  | 'no_messages_ever';

export interface FlowInput {
  messageAgeMinutes: number | null;
  /** Minutes since the last inbound on a NON-WhatsApp human channel (slack/sms/gmail). */
  otherChannelAgeMinutes: number | null;
  bridgeEventAgeMinutes: number | null;
  connectionState: 'open' | 'connecting' | 'close' | null;
  connectionStateAgeMinutes: number | null;
  quietHour: boolean;
}

export interface FlowPolicy {
  stalenessHours: number;
  fastStaleMinutes: number;
  otherChannelFreshMinutes: number;
}

export function evaluateWhatsAppFlow(i: FlowInput, p: FlowPolicy): { stale: boolean; reason: FlowReason } {
  // 1. Evolution says the socket is closed and has stayed closed: real, any hour.
  if (i.connectionState === 'close' && (i.connectionStateAgeMinutes ?? 0) >= CONNECTION_CLOSE_GRACE_MINUTES) {
    return { stale: true, reason: 'connection_closed' };
  }
  const flatSilent = i.messageAgeMinutes === null || i.messageAgeMinutes > p.stalenessHours * 60;
  const divergent =
    i.messageAgeMinutes !== null &&
    i.messageAgeMinutes > p.fastStaleMinutes &&
    i.otherChannelAgeMinutes !== null &&
    i.otherChannelAgeMinutes <= p.otherChannelFreshMinutes;
  if (!flatSilent && !divergent) return { stale: false, reason: 'flowing' };
  // 2. The inbox is silent — but is the bridge? At a quiet hour, silence is the
  //    normal state; a live bridge (any event recently) settles it at any hour
  //    short of the daytime flat window, which stays a real anomaly (14 days of
  //    data: 08:00–22:00 local never had an empty hour).
  const bridgeAlive = i.bridgeEventAgeMinutes !== null && i.bridgeEventAgeMinutes <= BRIDGE_FRESH_MINUTES;
  if (i.quietHour) return { stale: false, reason: bridgeAlive ? 'bridge_alive' : 'quiet_hour' };
  if (divergent && !flatSilent) {
    // Fast rule only: a live bridge beats a 45-minute lull, even in daytime.
    return bridgeAlive ? { stale: false, reason: 'bridge_alive' } : { stale: true, reason: 'divergence' };
  }
  return { stale: true, reason: i.messageAgeMinutes === null ? 'no_messages_ever' : 'flat_silence' };
}

/** Count how many of the last N same-hour buckets were empty. Buckets come from a date_histogram in the user's tz. */
export function isQuietHour(buckets: Array<{ key_as_string: string; doc_count: number }>, localHour: number): boolean {
  const same = buckets.filter((b) => parseInt(b.key_as_string.slice(11, 13), 10) === localHour);
  if (same.length < 7) return false; // not enough history: never assume quiet
  const zero = same.filter((b) => b.doc_count === 0).length;
  return zero >= QUIET_HOUR_MIN_ZERO;
}

/**
 * WhatsApp flow monitor — detects the "Evolution API ghost-connected" failure.
 *
 * Evolution's connectionState can report `state: open` while the underlying
 * Baileys WhatsApp Web socket has silently desynced and the webhook never
 * fires. The existing mcp-health-monitor only pings /health on our services,
 * and the account's self-reported status lies. The ground truth is what
 * actually reaches the gateway: message flow during busy hours, and ANY
 * Evolution event at all during quiet ones (see evaluateWhatsAppFlow).
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
    return (parseInt(new Intl.DateTimeFormat('en-US', {
        timeZone: this.config.timezone,
        hour: 'numeric',
        hour12: false,
      }).format(new Date()), 10) % 24);
  }

  private async lastInboundAgeMinutes(whatsapp: boolean): Promise<{ ts: string | null; ageMinutes: number | null }> {
    const res = await this.es.search<{ timestamp: string }>({
      index: 'll5_awareness_messages',
      size: 1,
      sort: [{ timestamp: { order: 'desc' } }],
      query: {
        bool: {
          filter: [{ term: { user_id: this.config.userId } }, { term: { from_me: false } }],
          ...(whatsapp ? { must: [{ term: { app: 'whatsapp' } }] } : { must_not: [{ term: { app: 'whatsapp' } }] }),
        },
      },
    });
    const ts = res.hits?.hits?.[0]?._source?.timestamp ?? null;
    return { ts, ageMinutes: ts ? (Date.now() - new Date(ts).getTime()) / 60_000 : null };
  }

  private async quietHourNow(localHour: number): Promise<boolean> {
    try {
      const res = await this.es.search({
        index: 'll5_awareness_messages',
        size: 0,
        query: {
          bool: {
            filter: [
              { term: { user_id: this.config.userId } },
              { term: { app: 'whatsapp' } },
              { term: { from_me: false } },
              { range: { timestamp: { gte: `now-${QUIET_HOUR_DAYS}d` } } },
            ],
          },
        },
        aggs: { h: { date_histogram: { field: 'timestamp', calendar_interval: 'hour', time_zone: this.config.timezone, min_doc_count: 0 } } },
      });
      const buckets = ((res.aggregations as { h?: { buckets?: Array<{ key_as_string: string; doc_count: number }> } })?.h?.buckets) ?? [];
      return isQuietHour(buckets, localHour);
    } catch (err) {
      logger.warn('[WhatsAppFlowMonitor][quietHour] histogram failed — assuming busy hour', { error: err instanceof Error ? err.message : String(err) });
      return false;
    }
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
        CACHED_SNAPSHOT.set(this.config.userId, {
          userId: this.config.userId, account_count: 0, last_message_at: null, last_message_age_hours: null,
          stale: false, checked_at: new Date().toISOString(), reason: 'flowing',
        });
        return;
      }

      // Last inbound WhatsApp message (outbound ignored: a silent inbox while we
      // send still counts), and the last inbound on any other human channel.
      const wa = await this.lastInboundAgeMinutes(true);
      let other: { ts: string | null; ageMinutes: number | null } = { ts: null, ageMinutes: null };
      try { other = await this.lastInboundAgeMinutes(false); } catch { /* best effort; fall back to the flat rule */ }

      const bridge = getBridgeLiveness(this.config.userId);
      const ageMin = (iso: string | null) => (iso ? (Date.now() - new Date(iso).getTime()) / 60_000 : null);
      const hour = this.getCurrentHour();
      const quietHour = await this.quietHourNow(hour);

      const input: FlowInput = {
        messageAgeMinutes: wa.ageMinutes,
        otherChannelAgeMinutes: other.ageMinutes,
        bridgeEventAgeMinutes: ageMin(bridge?.last_event_at ?? null),
        connectionState: bridge?.connection_state ?? null,
        connectionStateAgeMinutes: ageMin(bridge?.connection_state_at ?? null),
        quietHour,
      };
      const verdict = evaluateWhatsAppFlow(input, this.config);

      const snapshot: WhatsAppFlowSnapshot = {
        userId: this.config.userId,
        account_count: accountCount,
        last_message_at: wa.ts,
        last_message_age_hours: wa.ageMinutes === null ? null : Math.round(wa.ageMinutes / 6) / 10,
        stale: verdict.stale,
        checked_at: new Date().toISOString(),
        reason: verdict.reason,
        bridge_event_age_minutes: input.bridgeEventAgeMinutes === null ? null : Math.round(input.bridgeEventAgeMinutes),
        connection_state: input.connectionState,
        quiet_hour: quietHour,
      };
      CACHED_SNAPSHOT.set(this.config.userId, snapshot);
      const ctx = snapshot as unknown as Record<string, unknown>;

      if (!verdict.stale) {
        await clearAlert(this.pool, this.config.userId, 'channel.whatsapp');
        logger.debug('[WhatsAppFlowMonitor][tick] WhatsApp ok', ctx);
        return;
      }

      // Stale. Only RAISE during active hours (a quiet inbox at 3am is normal,
      // not an outage); an alert already firing from earlier persists overnight.
      // connection_closed is exempt: Evolution itself reported the socket down.
      if (verdict.reason !== 'connection_closed' && (hour < this.config.startHour || hour >= this.config.endHour)) {
        logger.info('[WhatsAppFlowMonitor][tick] Stale WhatsApp outside active hours — not raising', ctx);
        return;
      }

      const m = wa.ageMinutes;
      const bodyAge = m === null ? 'no messages on record' : m < 90 ? `last inbound ${Math.round(m)}m ago` : `last inbound ${Math.round(m / 60)}h ago`;
      const bridgeNote = input.bridgeEventAgeMinutes === null
        ? 'no Evolution event since gateway start'
        : `last Evolution event ${Math.round(input.bridgeEventAgeMinutes)}m ago`;
      const summary =
        verdict.reason === 'connection_closed' ? 'WhatsApp connection closed (Evolution reported state=close)'
        : verdict.reason === 'divergence' ? 'WhatsApp ingestion stalled (other channels flowing — WhatsApp-specific)'
        : 'WhatsApp ingestion stalled';
      logger.error('[WhatsAppFlowMonitor][alert] WhatsApp flow stalled', ctx);
      await raiseAlert(this.pool, {
        userId: this.config.userId,
        key: 'channel.whatsapp',
        severity: 'critical',
        summary,
        value: `${bodyAge}; ${bridgeNote}`,
        expected:
          verdict.reason === 'connection_closed' ? 'connection state open'
          : verdict.reason === 'divergence' ? `< ${Math.round(this.config.fastStaleMinutes)}m while other channels flow`
          : `< ${Math.round(this.config.stalenessHours)}h during a busy hour`,
        suggestion:
          verdict.reason === 'connection_closed'
            ? 'Evolution reports the WhatsApp socket closed. Wait 5 minutes for Baileys to reconnect; if still closed, restart_whatsapp_account, then re-pair only if the state stays close.'
            : 'The bridge has been silent AND the inbox is empty during a normally busy hour. Check the whatsapp.dlq for poison messages and Evolution webhook delivery before restarting; a restart does not create messages.',
      });
    }); } catch {
      // withSchedulerHealth already recorded the failure + logged at error.
    }
  }
}
