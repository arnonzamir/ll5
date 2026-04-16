import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { sendFCMNotification } from '../utils/fcm-sender.js';

export interface ServiceHealth {
  name: string;
  url: string;
  healthy: boolean;
  status_code: number | null;
  response_time_ms: number;
  error: string | null;
  consecutive_failures: number;
  last_healthy_at: string | null;
  last_checked_at: string;
}

export interface MCPErrorRateSample {
  service: string;
  total_calls: number;
  errors: number;
  error_rate: number; // 0-1
}

interface MCPHealthMonitorConfig {
  intervalMinutes: number;
  mcpUrls: Record<string, string>;
  userId: string;
  /** Require this many consecutive failures before alerting (prevents false positives on transient blips). */
  failureThreshold: number;
  /** Error-rate threshold (0-1). When the last 15 min of tool calls exceed this, raise an alert. */
  errorRateThreshold: number;
  /** Minimum tool-call sample size before an error rate is actionable. */
  errorRateMinSamples: number;
}

const CACHED_STATE: Map<string, ServiceHealth> = new Map();

/** Snapshot of the latest health state — used by /admin/health endpoint. */
export function getHealthSnapshot(): ServiceHealth[] {
  return [...CACHED_STATE.values()];
}

/**
 * Pings all MCPs and the gateway /health endpoint on an interval and reports
 * via audit log + FCM on state transitions (healthy ↔ unhealthy). Also sweeps
 * the ll5_app_log index for elevated tool error rates per service — a service
 * that responds 200 on /health but whose tool calls are failing is still broken.
 *
 * Keyed by user_id so alerts respect notification-level routing, but the
 * checks themselves are user-independent.
 */
const MAX_ALERTS_PER_EPISODE = 5;

export class MCPHealthMonitorScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private alertCounts: Map<string, number> = new Map(); // per-service alert counter, resets on recovery

  constructor(
    private pool: Pool,
    private es: Client,
    private config: MCPHealthMonitorConfig,
  ) {}

  start(): void {
    logger.info('[MCPHealthMonitor][start] Started', {
      userId: this.config.userId,
      intervalMinutes: this.config.intervalMinutes,
      services: Object.keys(this.config.mcpUrls),
      failureThreshold: this.config.failureThreshold,
    });
    // First tick immediately so the snapshot isn't empty.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.intervalMinutes * 60 * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async checkOne(name: string, url: string): Promise<ServiceHealth> {
    const start = Date.now();
    const prev = CACHED_STATE.get(name);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let healthy = false;
    let statusCode: number | null = null;
    let error: string | null = null;
    try {
      const res = await fetch(`${url}/health`, { signal: controller.signal });
      statusCode = res.status;
      healthy = res.ok;
      if (!res.ok) error = `http_${res.status}`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timeout);
    }

    const consecutive_failures = healthy ? 0 : (prev?.consecutive_failures ?? 0) + 1;
    const last_healthy_at = healthy
      ? new Date().toISOString()
      : prev?.last_healthy_at ?? null;

    return {
      name,
      url,
      healthy,
      status_code: statusCode,
      response_time_ms: Date.now() - start,
      error,
      consecutive_failures,
      last_healthy_at,
      last_checked_at: new Date().toISOString(),
    };
  }

  /**
   * Scan ll5_app_log for the last 15 minutes and compute error rate per service.
   * A tool call is considered an error when level="error" or the action is "error".
   * Uses a terms aggregation on service + sub-aggregation filtered by error level.
   */
  private async computeErrorRates(): Promise<MCPErrorRateSample[]> {
    try {
      const resp = await this.es.search({
        index: 'll5_app_log',
        size: 0,
        query: {
          range: { timestamp: { gte: 'now-15m' } },
        },
        aggs: {
          by_service: {
            terms: { field: 'service', size: 20 },
            aggs: {
              errors: {
                filter: { term: { level: 'error' } },
              },
            },
          },
        },
      });

      const buckets = (resp.aggregations as { by_service?: { buckets?: Array<{ key: string; doc_count: number; errors: { doc_count: number } }> } } | undefined)
        ?.by_service?.buckets ?? [];
      return buckets.map((b) => ({
        service: b.key,
        total_calls: b.doc_count,
        errors: b.errors.doc_count,
        error_rate: b.doc_count > 0 ? b.errors.doc_count / b.doc_count : 0,
      }));
    } catch (err) {
      logger.warn('[MCPHealthMonitor][errorRates] ES aggregation failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  private async alertStateChange(next: ServiceHealth, prev: ServiceHealth | undefined): Promise<void> {
    const wasHealthy = prev?.healthy ?? true;
    const isHealthy = next.healthy;

    // Only alert on crossings, and only after failureThreshold consecutive failures.
    // Cap at MAX_ALERTS_PER_EPISODE per service, reset on recovery.
    if (!isHealthy && next.consecutive_failures >= this.config.failureThreshold) {
      const count = this.alertCounts.get(next.name) ?? 0;
      if (count < MAX_ALERTS_PER_EPISODE) {
        this.alertCounts.set(next.name, count + 1);
        logger.error('[MCPHealthMonitor][alert] Service down', {
          service: next.name,
          url: next.url,
          error: next.error,
          consecutive_failures: next.consecutive_failures,
          alert_number: count + 1,
        });
        await sendFCMNotification(this.pool, this.config.userId, {
          title: 'LL5 service down',
          body: `${next.name} is failing: ${next.error ?? 'unhealthy'} (${next.consecutive_failures}× in a row, alert ${count + 1}/${MAX_ALERTS_PER_EPISODE})`,
          type: 'mcp_health',
          notification_level: 'critical',
          data: { service: next.name, error: next.error ?? '' },
        });
      }
    } else if (isHealthy && !wasHealthy) {
      this.alertCounts.delete(next.name);
      const downtimeSec = prev?.last_healthy_at
        ? Math.round((Date.now() - new Date(prev.last_healthy_at).getTime()) / 1000)
        : null;
      logger.info('[MCPHealthMonitor][alert] Service recovered', {
        service: next.name,
        downtime_seconds: downtimeSec,
      });
      await sendFCMNotification(this.pool, this.config.userId, {
        title: 'LL5 service recovered',
        body: `${next.name} is back${downtimeSec ? ` (${downtimeSec}s down)` : ''}`,
        type: 'mcp_health',
        notification_level: 'notify',
        data: { service: next.name },
      });
    }
  }

  private async tick(): Promise<void> {
    // 1. Concurrent /health probes for all services
    const entries = Object.entries(this.config.mcpUrls);
    const results = await Promise.all(entries.map(([name, url]) => this.checkOne(name, url)));

    for (const r of results) {
      const prev = CACHED_STATE.get(r.name);
      CACHED_STATE.set(r.name, r);
      await this.alertStateChange(r, prev);
    }

    // 2. Tool-call error rate sweep from ll5_app_log
    const errorRates = await this.computeErrorRates();
    for (const sample of errorRates) {
      if (sample.total_calls < this.config.errorRateMinSamples) continue;
      if (sample.error_rate < this.config.errorRateThreshold) continue;

      const errKey = `errors_${sample.service}`;
      const count = this.alertCounts.get(errKey) ?? 0;
      if (count >= MAX_ALERTS_PER_EPISODE) continue;
      this.alertCounts.set(errKey, count + 1);

      logger.error('[MCPHealthMonitor][toolErrors] Elevated tool error rate', {
        service: sample.service,
        errors: sample.errors,
        total: sample.total_calls,
        error_rate: sample.error_rate.toFixed(2),
        alert_number: count + 1,
      });

      await sendFCMNotification(this.pool, this.config.userId, {
        title: 'LL5 tool errors spiking',
        body: `${sample.service}: ${sample.errors}/${sample.total_calls} failed in 15 min (${Math.round(sample.error_rate * 100)}%, alert ${count + 1}/${MAX_ALERTS_PER_EPISODE})`,
        type: 'mcp_tool_errors',
        notification_level: 'alert',
        data: {
          service: sample.service,
          errors: String(sample.errors),
          total: String(sample.total_calls),
        },
      });
    }

    const unhealthy = results.filter((r) => !r.healthy).map((r) => r.name);
    if (unhealthy.length > 0) {
      logger.warn('[MCPHealthMonitor][tick] Unhealthy services', { unhealthy });
    } else {
      logger.debug('[MCPHealthMonitor][tick] All services healthy', { count: results.length });
    }
  }
}
