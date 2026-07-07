import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { withSchedulerHealth } from '../utils/scheduler-health.js';
import { listReconcileWork } from '../reconcile.js';

/**
 * Reconciliation governor / observability tick (DECISION-025 B1/B2).
 *
 * A cheap, rare (default 15-min) scheduler that computes the three reconciliation
 * metrics and writes ONE doc per cycle per user to `ll5_reconcile_metrics`, for the
 * anomaly-monitor (a separate item, B3) to read. This class only WRITES the doc.
 *
 * Metrics (D4/D6):
 *  - missed_close_count       = the deterministic selector's candidate count. REUSES
 *                               `listReconcileWork` — never reimplemented here.
 *  - reconciliation_coverage  = (candidate loops with a query_im_messages grounding
 *                               call this cycle) / (candidate loops this cycle).
 *                               TOOL-CALL evidence, not the reviewed_at stamp. `null`
 *                               when there are 0 candidates (no divide-by-zero / NaN).
 *  - wrong_close_count        = message-linked loops CLOSED this cycle (status
 *                               'completed', completed_at in the window) whose thread
 *                               got ZERO query_im_messages grounding calls this cycle.
 *                               The fuzzy "a later inbound contradicts it" heuristic is
 *                               DROPPED by design — the zero-grounding signal stands alone.
 *
 * Grounding-call detection: a query_im_messages call carries its target thread in the
 * tool INPUT (`args.conversation_id`). `ll5_app_log` tool_call rows store only
 * name/duration/success (no args, no conversation_id) — so grounding-by-conversation is
 * read from the `ll5_audit_log` tool-call ledger (`kind:'tool_call'`), whose `args`
 * field holds the full JSON input (stored in _source, index:false → retrieved + parsed,
 * not term-filtered). This is the only index that carries the conversation_id.
 *
 * Security (F5): the emitted doc is COUNTS / IDS / TIMESTAMPS ONLY — never a message
 * body or free text. Strictly `user_id`-scoped on every PG and ES query. Best-effort:
 * every query is try/caught and `tick()` never throws.
 */

export const RECONCILE_METRICS_INDEX = 'll5_reconcile_metrics';
const AUDIT_LOG_INDEX = 'll5_audit_log';
const GROUNDING_TOOL = 'query_im_messages';
/** Cap on grounding-ledger docs pulled per tick. The window is small + rare, so this
 *  is generous; it bounds the (unindexed args → fetch+parse) cost. */
const GROUNDING_FETCH_CAP = 1000;

/**
 * The ES doc written to `ll5_reconcile_metrics` — the CONTRACT the anomaly-monitor (B3)
 * reads. Counts / ids / enums / timestamps ONLY (design security F5): no message body,
 * no free text ever appears here.
 */
export interface ReconcileMetricsDoc {
  /** Tenant scope. */
  user_id: string;
  /** ISO 8601 write time of this cycle's doc. */
  timestamp: string;
  /** Deterministic-selector candidate count (== candidate_count). */
  missed_close_count: number;
  /** Loops closed this cycle with zero grounding on their thread. */
  wrong_close_count: number;
  /** grounded-candidates / candidates in [0,1]; null when there are 0 candidates. */
  reconciliation_coverage: number | null;
  /** Candidate loops seen this cycle (denominator of coverage). */
  candidate_count: number;
  /** Cycle look-back span in minutes (how "this cycle" was bounded). */
  window_minutes: number;
}

interface ReconcileGovernorConfig {
  intervalMinutes: number;
  userId: string;
  /** Cycle look-back span. Defaults to `intervalMinutes` (one cycle). */
  windowMinutes?: number;
}

export class ReconcileGovernorScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private pool: Pool,
    private es: Client,
    private config: ReconcileGovernorConfig,
  ) {}

  start(): void {
    logger.info('[ReconcileGovernor][start] Started', {
      userId: this.config.userId,
      intervalMinutes: this.config.intervalMinutes,
      windowMinutes: this.windowMinutes(),
    });
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.intervalMinutes * 60 * 1000);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private windowMinutes(): number {
    return this.config.windowMinutes ?? this.config.intervalMinutes;
  }

  /**
   * Set of conversation_ids (restricted to `interested`) that had >= 1 query_im_messages
   * grounding call in the window. Reads the audit-log tool-call ledger and parses each
   * row's JSON `args` for conversation_id (that field is unindexed → fetch + parse, not
   * a term query). Best-effort: any failure → empty set.
   */
  private async groundedConversationIds(interested: Set<string>, windowMinutes: number): Promise<Set<string>> {
    const grounded = new Set<string>();
    if (interested.size === 0) return grounded;
    try {
      const res = await this.es.search<{ args?: string }>({
        index: AUDIT_LOG_INDEX,
        size: GROUNDING_FETCH_CAP,
        _source: ['args'],
        query: {
          bool: {
            filter: [
              { term: { kind: 'tool_call' } },
              { term: { tool_name: GROUNDING_TOOL } },
              { term: { user_id: this.config.userId } },
              { range: { timestamp: { gte: `now-${windowMinutes}m` } } },
            ],
          },
        },
      });
      for (const hit of res.hits.hits ?? []) {
        const rawArgs = hit._source?.args;
        if (!rawArgs) continue;
        let convId: unknown;
        try {
          convId = (JSON.parse(rawArgs) as { conversation_id?: unknown })?.conversation_id;
        } catch {
          continue;
        }
        if (typeof convId === 'string' && interested.has(convId)) grounded.add(convId);
      }
    } catch (err) {
      logger.warn('[ReconcileGovernor] grounding query failed', { error: String(err) });
    }
    return grounded;
  }

  /** Message-linked loops CLOSED in the window (candidates for wrong_close). */
  private async closedLoops(windowMinutes: number): Promise<Array<{ id: string; conversation_id: string }>> {
    try {
      const r = await this.pool.query<{ id: string; conversation_id: string }>(
        `SELECT id, conversation_id
           FROM gtd_horizons
          WHERE user_id = $1 AND horizon = 0 AND status = 'completed'
            AND conversation_id IS NOT NULL
            AND completed_at >= now() - ($2 || ' minutes')::interval`,
        [this.config.userId, String(windowMinutes)],
      );
      return r.rows;
    } catch (err) {
      logger.warn('[ReconcileGovernor] closed-loops query failed', { error: String(err) });
      return [];
    }
  }

  private async compute(): Promise<void> {
    const userId = this.config.userId;
    const windowMinutes = this.windowMinutes();

    // 1) missed_close_count + candidates — REUSE the tested selector (best-effort: it
    //    returns empty on failure, never throws).
    const work = await listReconcileWork(this.pool, this.es, userId);
    const candidateConvIds = new Set(work.candidates.map((c) => c.conversation_id));

    // 2) close candidates: message-linked loops completed this cycle.
    const closed = await this.closedLoops(windowMinutes);
    const closedConvIds = new Set(closed.map((c) => c.conversation_id));

    // 3) one grounding query over the union of interested threads (cheap: single ES call).
    const interested = new Set<string>([...candidateConvIds, ...closedConvIds]);
    const grounded = await this.groundedConversationIds(interested, windowMinutes);

    // reconciliation_coverage — grounded candidates / candidates; null when 0 candidates.
    const candidateCount = work.candidates.length;
    let coverage: number | null = null;
    if (candidateCount > 0) {
      const groundedCandidates = work.candidates.filter((c) => grounded.has(c.conversation_id)).length;
      coverage = groundedCandidates / candidateCount;
    }

    // wrong_close_count — closed loops whose thread had ZERO grounding this cycle.
    const wrongCloseCount = closed.filter((c) => !grounded.has(c.conversation_id)).length;

    const doc: ReconcileMetricsDoc = {
      user_id: userId,
      timestamp: new Date().toISOString(),
      missed_close_count: work.missed_close_count,
      wrong_close_count: wrongCloseCount,
      reconciliation_coverage: coverage,
      candidate_count: candidateCount,
      window_minutes: windowMinutes,
    };

    try {
      await this.es.index({ index: RECONCILE_METRICS_INDEX, document: doc });
    } catch (err) {
      logger.warn('[ReconcileGovernor] metrics write failed', { error: String(err), userId });
    }
  }

  private async tick(): Promise<void> {
    try {
      await withSchedulerHealth('reconcile_governor', async () => {
        await this.compute();
      });
    } catch {
      // withSchedulerHealth already recorded + logged the failure; never throw out of tick.
    }
  }
}
