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
    const hour = parseInt(
      new Intl.DateTimeFormat('en-US', { timeZone: this.config.timezone, hour: 'numeric', hour12: false }).format(new Date()),
      10,
    );
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

  private retiredCleared = false;

  private async checkChannels(): Promise<void> {
    const active = this.inActiveHours();
    if (!this.retiredCleared) {
      for (const key of RETIRED_CHANNEL_KEYS) await clearAlert(this.pool, this.config.userId, key);
      this.retiredCleared = true;
    }
    for (const c of CHANNEL_CHECKS) {
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
