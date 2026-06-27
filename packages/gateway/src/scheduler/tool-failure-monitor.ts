import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { raiseAlert, clearAlert, type AlertSeverity } from '../utils/alerting.js';
import { withSchedulerHealth } from '../utils/scheduler-health.js';

interface ToolFailureMonitorConfig {
  intervalMinutes: number;
  userId: string;
  /** Look-back window for failure counting. Default 60. */
  windowMinutes: number;
  /** Min absolute failures in the window to consider alerting. Default 4. */
  minFailures: number;
  /** Min failure ratio (fails/total) to alert — so a high-traffic tool with a few
   *  stray errors doesn't trip; only a tool failing the *majority* of its calls does.
   *  Default 0.5. */
  minRatio: number;
}

/** Tools whose failure is delivery/perception-critical → escalate to `critical`. */
const CRITICAL_TOOLS = new Set([
  'reply', 'push_to_user', 'send_whatsapp', 'send_telegram', 'inspect_image',
]);

interface ToolStat {
  tool: string;
  total: number;
  fails: number;
  sampleError?: string;
}

/**
 * Tool-failure backstop (DECISION — agent self-healing). The deterministic net under
 * Hard Rule 14: independent of whether the agent notices, this watches `ll5_app_log`
 * for tools that are *failing repeatedly* and raises an alert (phone push + an [ALERT]
 * to the agent) the way the inspect_image breakage should have been caught within the
 * hour instead of two days. Covers the HTTP MCP tools AND the channel-MCP tools
 * (inspect_image, reply, …) now that the channel reports results via
 * POST /telemetry/tool-result.
 *
 * A tool alerts when it has >= minFailures in the window AND fails >= minRatio of its
 * calls — i.e. it's broken, not just occasionally flaky. Clears automatically when the
 * tool starts succeeding again.
 */
export class ToolFailureMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Alert keys currently raised, so we can clear the ones that recover. */
  private active = new Set<string>();

  constructor(
    private pool: Pool,
    private es: Client,
    private config: ToolFailureMonitorConfig,
  ) {}

  start(): void {
    logger.info('[ToolFailureMonitor][start] Started', {
      userId: this.config.userId,
      intervalMinutes: this.config.intervalMinutes,
      windowMinutes: this.config.windowMinutes,
      minFailures: this.config.minFailures,
      minRatio: this.config.minRatio,
    });
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.intervalMinutes * 60 * 1000);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Per-tool total + failure counts (+ a sample error) over the window. */
  private async toolStats(): Promise<ToolStat[]> {
    const res = await this.es.search({
      index: 'll5_app_log',
      size: 0,
      query: {
        bool: {
          filter: [
            { term: { action: 'tool_call' } },
            { term: { user_id: this.config.userId } },
            { range: { timestamp: { gte: `now-${this.config.windowMinutes}m` } } },
          ],
        },
      },
      aggs: {
        tools: {
          terms: { field: 'tool_name', size: 200 },
          aggs: {
            fails: {
              filter: { term: { success: false } },
              aggs: {
                sample: {
                  top_hits: { size: 1, _source: ['error_message'], sort: [{ timestamp: { order: 'desc' } }] },
                },
              },
            },
          },
        },
      },
    });

    const buckets =
      (res.aggregations as {
        tools?: {
          buckets?: Array<{
            key: string;
            doc_count: number;
            fails?: { doc_count?: number; sample?: { hits?: { hits?: Array<{ _source?: { error_message?: string } }> } } };
          }>;
        };
      })?.tools?.buckets ?? [];

    return buckets.map((b) => ({
      tool: b.key,
      total: b.doc_count,
      fails: b.fails?.doc_count ?? 0,
      sampleError: b.fails?.sample?.hits?.hits?.[0]?._source?.error_message,
    }));
  }

  private async check(): Promise<void> {
    const stats = await this.toolStats();
    const stillFailing = new Set<string>();

    for (const s of stats) {
      const ratio = s.total > 0 ? s.fails / s.total : 0;
      const broken = s.fails >= this.config.minFailures && ratio >= this.config.minRatio;
      const key = `tool.${s.tool}`;
      if (!broken) continue;

      stillFailing.add(key);
      const severity: AlertSeverity = CRITICAL_TOOLS.has(s.tool) ? 'critical' : 'warning';
      await raiseAlert(this.pool, {
        userId: this.config.userId,
        key,
        severity,
        summary: `Tool "${s.tool}" failing`,
        value: `${s.fails}/${s.total} calls failed in the last ${this.config.windowMinutes}m${s.sampleError ? ` — e.g. "${s.sampleError.slice(0, 100)}"` : ''}`,
        expected: 'tool succeeds',
        suggestion: `Likely a real breakage (backend/code/auth) OR the agent's own call drifted (Hard Rule 14). Check the agent transcript / the tool's MCP.`,
      });
      this.active.add(key);
    }

    // Recover: clear any previously-raised tool alert that is no longer failing.
    for (const key of [...this.active]) {
      if (!stillFailing.has(key)) {
        await clearAlert(this.pool, this.config.userId, key);
        this.active.delete(key);
      }
    }
  }

  private async tick(): Promise<void> {
    try {
      await withSchedulerHealth('tool_failure_monitor', async () => {
        await this.check();
      });
    } catch {
      // withSchedulerHealth already recorded + logged the failure.
    }
  }
}
