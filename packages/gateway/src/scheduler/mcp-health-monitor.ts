import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { generateToken } from '@ll5/shared';
import { logger } from '../utils/logger.js';
import { sendFCMNotification } from '../utils/fcm-sender.js';
import { withSchedulerHealth } from '../utils/scheduler-health.js';

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
  /** Number of tools reported by the MCP's tools/list call on this cycle.
   *  null = not probed (e.g. gateway entry has no MCP endpoint). */
  tool_count: number | null;
  /** Error from the tools/list probe (null = success or not probed). */
  tools_probe_error: string | null;
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
  /** Shared auth secret used to mint short-lived probe tokens for tools/list calls. */
  authSecret: string;
}

const CACHED_STATE: Map<string, ServiceHealth> = new Map();
const PROBE_TIMEOUT_MS = 5000;

/** Snapshot of the latest health state — used by /admin/health endpoint. */
export function getHealthSnapshot(): ServiceHealth[] {
  return [...CACHED_STATE.values()];
}

/**
 * Pings all MCPs and the gateway /health endpoint on an interval and reports
 * via audit log + FCM on state transitions (healthy ↔ unhealthy).
 *
 * Two checks per service per cycle:
 *   1. HTTP GET /health    — catches process-down / TLS / routing failures.
 *   2. MCP tools/list call — catches the "connected but cannot list tools"
 *      ghost mode (observed 2026-05-13 on awareness: /health 200 for 22h
 *      while Claude Code's tool picker reported the MCP as failed).
 *
 * A cycle counts as failed if EITHER probe fails or tool_count is 0.
 * Failure-tracking, FCM-critical, and recovery-notify logic is shared so we
 * don't bolt on a parallel alerter.
 *
 * Also sweeps `ll5_app_log` for elevated tool error rates per service — a
 * service that responds 200 on /health AND lists tools but whose tool calls
 * are erroring on the inside is still broken; that path is independent of
 * the per-service consecutive-failure escalation.
 *
 * Keyed by user_id so alerts respect notification-level routing, but the
 * checks themselves are user-independent.
 */
const MAX_ALERTS_PER_EPISODE = 2;

/** Services we should NOT probe via MCP tools/list — the gateway is a plain
 *  HTTP service and exposes /health but no /mcp endpoint. Anything not in
 *  this set is assumed to be a real MCP server. */
const NON_MCP_SERVICES = new Set(['gateway']);

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

  /**
   * MCP tools/list probe via streamable-HTTP, mirroring the approach used by
   * the channel bridge's `check_mcp_connectivity` (ll5-run/channel). The MCP
   * endpoint lives at `${url}/mcp` and accepts a Bearer token minted by the
   * same `generateToken` helper used by every other gateway → MCP call.
   *
   * Returns the tool count on success, or an error string on failure. Always
   * resolves within ~5s (PROBE_TIMEOUT_MS).
   */
  private async probeTools(url: string): Promise<{ tool_count: number; error: string | null }> {
    // Probe runs as the configured monitor user so the MCP's auth layer
    // accepts the token; the probe doesn't actually read user data.
    const token = generateToken(this.config.userId, this.config.authSecret, 1, 'user');
    const mcpUrl = `${url.replace(/\/$/, '')}/mcp`;

    let client: McpClient | null = null;
    try {
      const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      });
      client = new McpClient({ name: 'll5-gateway-health-probe', version: '0.1.0' }, { capabilities: {} });
      await Promise.race([
        client.connect(transport),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error(`tools_list_timeout_${PROBE_TIMEOUT_MS}ms`)), PROBE_TIMEOUT_MS),
        ),
      ]);
      const tools = await Promise.race([
        client.listTools(),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error(`tools_list_timeout_${PROBE_TIMEOUT_MS}ms`)), PROBE_TIMEOUT_MS),
        ),
      ]);
      return { tool_count: tools.tools?.length ?? 0, error: null };
    } catch (err) {
      return {
        tool_count: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      // Best-effort close; ignore errors so a stuck close can't poison the cycle.
      try { await client?.close(); } catch { /* noop */ }
    }
  }

  private async checkOne(name: string, url: string): Promise<ServiceHealth> {
    const start = Date.now();
    const prev = CACHED_STATE.get(name);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    let healthOk = false;
    let statusCode: number | null = null;
    let healthError: string | null = null;
    try {
      const res = await fetch(`${url}/health`, { signal: controller.signal });
      statusCode = res.status;
      healthOk = res.ok;
      if (!res.ok) healthError = `http_${res.status}`;
    } catch (err) {
      healthError = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timeout);
    }

    // Tools/list probe — skipped for non-MCP services (gateway).
    let tool_count: number | null = null;
    let tools_probe_error: string | null = null;
    if (!NON_MCP_SERVICES.has(name)) {
      const probe = await this.probeTools(url);
      tool_count = probe.tool_count;
      tools_probe_error = probe.error;
    }

    // Composite health: BOTH probes must pass (where applicable). A non-MCP
    // service is healthy iff /health is ok. An MCP service is healthy iff
    // /health is ok AND tools/list returned >0 tools.
    const toolsOk =
      NON_MCP_SERVICES.has(name) ||
      (tools_probe_error === null && (tool_count ?? 0) > 0);
    const healthy = healthOk && toolsOk;

    // Build a precise error string for FCM/log surfacing. Both probes can
    // fail in the same cycle, and the distinction matters for triage.
    let error: string | null = null;
    if (!healthy) {
      const parts: string[] = [];
      if (!healthOk) {
        parts.push(`/health ${healthError ?? 'failed'}`);
      } else {
        parts.push(`/health ok`);
      }
      if (!NON_MCP_SERVICES.has(name)) {
        if (tools_probe_error) {
          parts.push(`tools/list ${tools_probe_error}`);
        } else if ((tool_count ?? 0) === 0) {
          parts.push(`tools/list returned 0 tools`);
        } else {
          parts.push(`tools/list ok (${tool_count})`);
        }
      }
      error = parts.join(', ');
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
      tool_count,
      tools_probe_error,
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
          tool_count: next.tool_count,
          tools_probe_error: next.tools_probe_error,
          consecutive_failures: next.consecutive_failures,
          alert_number: count + 1,
        });
        await sendFCMNotification(this.pool, this.config.userId, {
          title: 'LL5 service down',
          body: `${next.name}: ${next.error ?? 'unhealthy'} (${next.consecutive_failures}× in a row, alert ${count + 1}/${MAX_ALERTS_PER_EPISODE})`,
          type: 'mcp_health',
          notification_level: 'critical',
          data: {
            service: next.name,
            error: next.error ?? '',
            tool_count: String(next.tool_count ?? ''),
            tools_probe_error: next.tools_probe_error ?? '',
          },
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
        tool_count: next.tool_count,
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
    try { await withSchedulerHealth('mcp_health_monitor', async () => {
    // 1. Concurrent /health + tools/list probes for all services
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

    const unhealthy = results.filter((r) => !r.healthy).map((r) => `${r.name}(${r.error ?? 'unknown'})`);
    if (unhealthy.length > 0) {
      logger.warn('[MCPHealthMonitor][tick] Unhealthy services', { unhealthy });
    } else {
      logger.debug('[MCPHealthMonitor][tick] All services healthy', {
        count: results.length,
        tools: results.map((r) => `${r.name}:${r.tool_count ?? 'n/a'}`).join(','),
      });
    }
    }); } catch { /* withSchedulerHealth already recorded + logged */ }
  }
}
