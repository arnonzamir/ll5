import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { raiseAlert, clearAlert, type AlertSeverity } from '../utils/alerting.js';
import { withSchedulerHealth } from '../utils/scheduler-health.js';

interface MetricsMonitorConfig {
  intervalMinutes: number;
  startHour: number;
  endHour: number;
  timezone: string;
  userId: string;
  /** Only alert on a channel that's been active within this many days (so we
   *  never alert on a channel the user simply doesn't use). */
  baselineDays: number;
}

/**
 * A single input-channel freshness check. `app` is the value in
 * `ll5_awareness_messages.app`; we measure the age of the last INBOUND message
 * (from_me:false) and alert if it exceeds `staleMinutes` during active hours —
 * but only when the channel has a recent baseline.
 */
interface ChannelCheck {
  key: string;            // alert key, e.g. 'channel.slack'
  app: string;            // ll5_awareness_messages `source` value (the delivery path, e.g. 'phone')
  label: string;          // human label
  staleMinutes: number;   // expected-max age during active hours
  severity: AlertSeverity;
  suggestion: string;
}

// WhatsApp + phone are covered by their dedicated monitors. Slack, Gmail and SMS
// all arrive through ONE path — the Android notification-mirror listener — and
// the failure this check exists for is that listener dying (Slack dead ~29h,
// Gmail ~4.5 days in August). Per-app silence was the wrong signal: Slack is
// legitimately silent for whole days (0 on 4 of the last 14, ISS-031) and
// "Slack channel quiet" fired 10× in one evening. The mirror as a whole is not:
// in 14 healthy days the longest gap between ANY mirrored message was 16.8h.
// So: one check, on source=phone, 24h, active hours only.
const CHANNEL_CHECKS: ChannelCheck[] = [
  { key: 'channel.mirror', app: 'phone', label: 'Phone notification mirror (Slack / Gmail / SMS)', staleMinutes: 24 * 60, severity: 'warning',
    suggestion: 'No mirrored notification from ANY app in 24h during active hours — the Android notification-listener is probably dead. Open the LL5 app (it re-arms the listener), then check the permission banner.' },
];
/** Alert keys of the retired per-app checks — cleared once so no stale row keeps firing. */
const RETIRED_CHANNEL_KEYS = ['channel.slack', 'channel.gmail', 'channel.sms'];

/** How fresh a phone_status doc must be for its listener flags to count as "now". */
const LISTENER_STATE_MAX_AGE_MINUTES = 120;

/**
 * Ground truth about the phone's notification-mirror listener, read off the
 * newest phone_status doc (android review 2026-09-05, improvement 1). The app
 * stamps both flags on every phone_status push; null means we do not know —
 * no fresh doc, or an app build that predates the fields.
 */
export interface MirrorListenerState {
  enabled: boolean | null;    // the notification-access toggle on the phone
  connected: boolean | null;  // the listener service is actually bound
}

export type MirrorDecision =
  /** Ground truth says the mirror is broken — alert now, do not wait 24h. */
  | { kind: 'raise'; summary: string; value: string; expected: string; suggestion: string }
  /** Ground truth says the listener is bound — the silence is real quiet, not an outage. */
  | { kind: 'healthy' }
  /** Nothing to go on — fall back to the 24h silence rule, unchanged. */
  | { kind: 'silence-rule' };

/**
 * Decide channel.mirror from the listener flags alone. Pure, so it is testable
 * without ES/pg. The silence rule stays the fallback: an older app build sends
 * neither flag and must not see any change in behaviour.
 */
export function decideMirrorFromListener(state: MirrorListenerState): MirrorDecision {
  // Access revoked / never granted: nothing can be mirrored, and re-arming the
  // listener cannot help until the user flips the toggle back on.
  if (state.enabled === false) {
    return {
      kind: 'raise',
      summary: 'Notification access not granted',
      value: 'notification_listener_enabled=false',
      expected: 'notification access granted to the LL5 app',
      suggestion: 'Slack / Gmail / SMS cannot reach LL5 at all. Grant notification access to the LL5 app (Settings → Notifications → Device & app notifications).',
    };
  }
  // Granted but not bound — the silent-outage class this check exists for
  // (Slack ~29h, Gmail ~4.5 days in August), now visible within one tick.
  if (state.connected === false) {
    return {
      kind: 'raise',
      summary: 'Notification listener disconnected (Android killed the mirror)',
      value: 'notification_listener_connected=false',
      expected: 'listener bound',
      suggestion: 'Slack / Gmail / SMS are not reaching LL5. Open the LL5 app — it re-arms the listener — then check the permission banner.',
    };
  }
  if (state.connected === true) return { kind: 'healthy' };
  return { kind: 'silence-rule' };
}

/**
 * Metrics watchdog — the declarative companion to the dedicated monitors.
 * Covers the input channels NOT already watched (slack/gmail/sms) plus
 * Elasticsearch cluster health, and funnels everything through raiseAlert /
 * clearAlert so it reaches the agent, repeats, and shows in the apps.
 */
export class MetricsMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private pool: Pool,
    private es: Client,
    private config: MetricsMonitorConfig,
  ) {}

  start(): void {
    logger.info('[MetricsMonitor][start] Started', {
      userId: this.config.userId,
      intervalMinutes: this.config.intervalMinutes,
    });
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.intervalMinutes * 60 * 1000);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private inActiveHours(): boolean {
    const hour = (parseInt(new Intl.DateTimeFormat('en-US', { timeZone: this.config.timezone, hour: 'numeric', hour12: false }).format(new Date()), 10) % 24);
    return hour >= this.config.startHour && hour < this.config.endHour;
  }

  /** Last inbound message age (hours) for a channel + whether it has a baseline. */
  private async channelState(app: string): Promise<{ ageHours: number | null; hasBaseline: boolean }> {
    try {
      const res = await this.es.search<{ timestamp: string }>({
        index: 'll5_awareness_messages',
        size: 1,
        sort: [{ timestamp: { order: 'desc' } }],
        _source: ['timestamp'],
        query: {
          bool: {
            filter: [
              { term: { user_id: this.config.userId } },
              { term: { 'source.keyword': app } },
              { term: { from_me: false } },
              { range: { timestamp: { gte: `now-${this.config.baselineDays}d` } } },
            ],
          },
        },
      });
      const total = typeof res.hits.total === 'object' ? res.hits.total.value : (res.hits.total ?? 0);
      const lastTs = res.hits.hits?.[0]?._source?.timestamp ?? null;
      const ageHours = lastTs ? (Date.now() - new Date(lastTs).getTime()) / 3_600_000 : null;
      return { ageHours, hasBaseline: total > 0 };
    } catch (err) {
      logger.debug('[MetricsMonitor][channelState] query failed', { app, error: err instanceof Error ? err.message : String(err) });
      return { ageHours: null, hasBaseline: false };
    }
  }

  /**
   * Newest phone_status doc within LISTENER_STATE_MAX_AGE_MINUTES, reduced to
   * the two listener flags. Anything older is not evidence about right now
   * (a phone that stopped reporting at all is the phone-liveness monitor's job),
   * so it reads back as unknown and channel.mirror falls back to the silence rule.
   */
  private async mirrorListenerState(): Promise<MirrorListenerState> {
    try {
      const res = await this.es.search<{
        notification_listener_enabled?: boolean;
        notification_listener_connected?: boolean;
      }>({
        index: 'll5_awareness_phone_statuses',
        size: 1,
        sort: [{ timestamp: { order: 'desc' } }],
        _source: ['notification_listener_enabled', 'notification_listener_connected'],
        query: {
          bool: {
            filter: [
              { term: { user_id: this.config.userId } },
              { range: { timestamp: { gte: `now-${LISTENER_STATE_MAX_AGE_MINUTES}m` } } },
            ],
          },
        },
      });
      const src = res.hits.hits?.[0]?._source;
      return {
        enabled: src?.notification_listener_enabled ?? null,
        connected: src?.notification_listener_connected ?? null,
      };
    } catch (err) {
      // Index might not exist yet — not fatal, just means "unknown".
      logger.debug('[MetricsMonitor][mirrorListenerState] query failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { enabled: null, connected: null };
    }
  }

  private retiredCleared = false;

  private async checkChannels(): Promise<void> {
    const active = this.inActiveHours();
    if (!this.retiredCleared) {
      for (const key of RETIRED_CHANNEL_KEYS) await clearAlert(this.pool, this.config.userId, key);
      this.retiredCleared = true;
    }
    for (const c of CHANNEL_CHECKS) {
      // Ground truth beats inference (android review 2026-09-05, improvement 1):
      // the app now tells us whether the notification listener is alive, which
      // separates "Android killed the mirror" from "quiet weekend". Deliberately
      // NOT gated on hasBaseline — a listener dead longer than baselineDays has
      // no baseline left, which is exactly when the silence rule goes blind.
      if (c.key === 'channel.mirror') {
        const decision = decideMirrorFromListener(await this.mirrorListenerState());
        if (decision.kind === 'raise') {
          // Same active-hours gate as below: raise on the next waking tick, not
          // at 03:00. "Immediately" here means without waiting out 24h of silence.
          if (active) {
            await raiseAlert(this.pool, {
              userId: this.config.userId,
              key: c.key,
              severity: c.severity,
              summary: decision.summary,
              value: decision.value,
              expected: decision.expected,
              suggestion: decision.suggestion,
            });
          }
          continue;
        }
        if (decision.kind === 'healthy') {
          // Listener bound → the mirror is alive; skip the silence rule this tick.
          await clearAlert(this.pool, this.config.userId, c.key);
          continue;
        }
        // 'silence-rule' → fall through to the unchanged 24h check below.
      }

      const { ageHours, hasBaseline } = await this.channelState(c.app);
      // No baseline → channel unused; clear any stale alert and skip.
      if (!hasBaseline) { await clearAlert(this.pool, this.config.userId, c.key); continue; }

      const stale = ageHours !== null && ageHours * 60 > c.staleMinutes;
      if (!stale) {
        await clearAlert(this.pool, this.config.userId, c.key);
      } else if (active) {
        // Only raise during active hours; an existing alert persists overnight.
        await raiseAlert(this.pool, {
          userId: this.config.userId,
          key: c.key,
          severity: c.severity,
          summary: `${c.label} channel quiet`,
          value: ageHours === null ? 'no recent messages' : `last inbound ${Math.round(ageHours)}h ago`,
          expected: `< ${Math.round(c.staleMinutes / 60)}h`,
          suggestion: c.suggestion,
        });
      }
    }
  }

  private async checkElasticsearch(): Promise<void> {
    const key = 'service.elasticsearch';
    try {
      const health = await this.es.cluster.health({}, { requestTimeout: 8000 });
      // yellow is normal for a single-node cluster (unassigned replicas); red is real.
      if (health.status === 'red') {
        await raiseAlert(this.pool, {
          userId: this.config.userId, key, severity: 'critical',
          summary: 'Elasticsearch cluster RED',
          value: `status=red, unassigned=${health.unassigned_shards ?? '?'}`,
          expected: 'green/yellow',
          suggestion: 'ES is the awareness/knowledge/health backing store — raise its memory; a restart can cascade to those MCPs.',
        });
      } else {
        await clearAlert(this.pool, this.config.userId, key);
      }
    } catch (err) {
      await raiseAlert(this.pool, {
        userId: this.config.userId, key, severity: 'critical',
        summary: 'Elasticsearch unreachable',
        value: err instanceof Error ? err.message.slice(0, 120) : 'ping failed',
        expected: 'reachable',
        suggestion: 'Check the elasticsearch container; the ES-backed MCPs will be failing too.',
      });
    }
  }

  private async tick(): Promise<void> {
    try {
      await withSchedulerHealth('metrics_monitor', async () => {
        await this.checkChannels();
        await this.checkElasticsearch();
      });
    } catch {
      // withSchedulerHealth already recorded + logged the failure.
    }
  }
}
