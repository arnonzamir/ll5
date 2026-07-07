import { z } from 'zod';
import type { Pool } from 'pg';
import type { Client } from '@elastic/elasticsearch';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logger } from '../utils/logger.js';

/**
 * Reconciliation governor + mutation gate (DECISION-025 D4/D5/D6), ported
 * faithfully from the ALREADY-TESTED gateway originals
 * (packages/gateway/src/reconcile.ts + reconcile-gate.ts) so the off-agent
 * reconcile worker can call them through the GTD MCP tool surface.
 *
 * The worker's tool surface is the security boundary: only read + the
 * tracking-state mutations (close / advance / keep_open, routed through the
 * deterministic gate) are exposed. There is NO send / pay / delete / arbitrary
 * write here — those are simply not operations these functions expose.
 *
 * Everything is strictly `user_id`-scoped; the selector is best-effort
 * (never throws). Parity with the gateway versions is the acceptance bar.
 */

// ---------------------------------------------------------------------------
// Selector (mirror of gateway/src/reconcile.ts)
// ---------------------------------------------------------------------------

export interface LoopRow {
  id: string;
  title: string;
  waiting_for: string | null;
  conversation_id: string;
  stakes: string;
  due_date: string | null;
  reviewed_at: string | null;
  created_at: string;
}

export interface ReconcileCandidate extends LoopRow {
  last_inbound_at: string;
}

export interface ReconcileWork {
  candidates: ReconcileCandidate[];
  missed_close_count: number;
}

/**
 * The DETERMINISTIC missed-close selector. A loop is a candidate iff its linked
 * conversation has an inbound (from_me=false) NEWER than `reviewed_at` (or, if
 * never reviewed, newer than `created_at`). Only message-linked, active
 * horizon-0 loops are seen. Strictly `user_id`-scoped; best-effort (never
 * throws). If `es` is null/undefined (ELASTICSEARCH_URL unset), degrades to an
 * empty result.
 */
export async function listReconcileWork(
  pool: Pool,
  es: Client | null | undefined,
  userId: string,
): Promise<ReconcileWork> {
  // 1) message-linked, active horizon-0 loops (Postgres).
  const loops = await pool
    .query<LoopRow>(
      `SELECT id, title, waiting_for, conversation_id, stakes, due_date, reviewed_at, created_at
         FROM gtd_horizons
        WHERE user_id = $1 AND horizon = 0 AND status = 'active'
          AND conversation_id IS NOT NULL`,
      [userId],
    )
    .then((r) => r.rows)
    .catch((err) => {
      logger.warn('[listReconcileWork] loops query failed', { error: String(err) });
      return [] as LoopRow[];
    });

  if (loops.length === 0) return { candidates: [], missed_close_count: 0 };

  // No awareness ES client (ELASTICSEARCH_URL unset) → can't determine inbound
  // recency; degrade to empty, best-effort (never crash).
  if (!es) {
    logger.warn('[listReconcileWork] no ES client — degrading to empty result');
    return { candidates: [], missed_close_count: 0 };
  }

  const convIds = [...new Set(loops.map((l) => l.conversation_id))];

  // 2) latest inbound timestamp per conversation (awareness ES). `.keyword` on
  //    conversation_id — the analyzed text field can't be term-filtered/aggregated.
  const lastByConv = new Map<string, string>();
  try {
    const res = await es.search<{ timestamp: string }>({
      index: 'll5_awareness_messages',
      size: 0,
      query: {
        bool: {
          filter: [
            { term: { user_id: userId } },
            { term: { from_me: false } },
            { terms: { 'conversation_id.keyword': convIds } },
          ],
        },
      },
      aggs: {
        by_conv: {
          terms: { field: 'conversation_id.keyword', size: convIds.length },
          aggs: { last: { max: { field: 'timestamp' } } },
        },
      },
    });
    const buckets =
      (res.aggregations?.by_conv as { buckets?: Array<{ key: string; last: { value_as_string?: string } }> })?.buckets ?? [];
    for (const b of buckets) {
      if (b.last?.value_as_string) lastByConv.set(b.key, b.last.value_as_string);
    }
  } catch (err) {
    logger.warn('[listReconcileWork] inbound aggregation failed', { error: String(err) });
    return { candidates: [], missed_close_count: 0 };
  }

  // 3) candidate = last inbound newer than reviewed_at (or created_at).
  const candidates: ReconcileCandidate[] = [];
  for (const l of loops) {
    const last = lastByConv.get(l.conversation_id);
    if (!last) continue;
    const since = l.reviewed_at ?? l.created_at;
    if (new Date(last).getTime() > new Date(since).getTime()) {
      candidates.push({ ...l, last_inbound_at: last });
    }
  }

  return { candidates, missed_close_count: candidates.length };
}

// ---------------------------------------------------------------------------
// Mutation gate (mirror of gateway/src/reconcile-gate.ts)
// ---------------------------------------------------------------------------

export type ReconcileAction = 'close' | 'advance' | 'keep_open';
export type ReconcileResult = 'closed' | 'reviewed' | 'needs_confirm' | 'not_found';

/**
 * Apply a signal-driven reconciliation to one loop, atomically. Returns:
 *  - 'closed'        — a low-stakes loop was completed + stamped.
 *  - 'needs_confirm' — a consequential loop was advanced (stamped reviewed) and
 *                      must be surfaced for the user's one-tap confirm; NOT closed.
 *  - 'reviewed'      — advance / keep-open: stamped reviewed, left active.
 *  - 'not_found'     — no such active loop for this user.
 *
 * Stakes routing is deterministic on the DB stamp (never a per-close judgment):
 * a `consequential` loop is NEVER autonomously closed; a `low` loop may
 * auto-close. The close/advance + `reviewed_at` stamp are one transaction.
 * Every statement is `user_id`-scoped.
 */
export async function applyReconcile(
  pool: Pool,
  userId: string,
  loopId: string,
  action: ReconcileAction,
): Promise<ReconcileResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query<{ stakes: string }>(
      `SELECT stakes FROM gtd_horizons
        WHERE id = $1 AND user_id = $2 AND horizon = 0 AND status = 'active'
        FOR UPDATE`,
      [loopId, userId],
    );
    if (cur.rowCount === 0) {
      await client.query('ROLLBACK');
      return 'not_found';
    }
    // FAIL-SAFE: only the explicit `low` value auto-closes. Any other value
    // (unexpected tier, casing, whitespace, or a future stakes level) is treated
    // as consequential → human-confirm, never an autonomous close on a possibly
    // forged signal. (The column also DEFAULTs + CHECKs to {low,consequential},
    // but the gate must not depend on that to fail safe.)
    const lowStakes = cur.rows[0].stakes === 'low';

    // A consequential (or any non-`low`) loop is never autonomously closed:
    // downgrade close→advance, stamp reviewed, and flag for confirm. Only a
    // low-stakes close proceeds.
    if (action === 'close' && lowStakes) {
      await client.query(
        `UPDATE gtd_horizons
            SET status = 'completed', completed_at = now(), reviewed_at = now(), updated_at = now()
          WHERE id = $1 AND user_id = $2`,
        [loopId, userId],
      );
      await client.query('COMMIT');
      return 'closed';
    }

    // advance / keep_open, OR a consequential "close" that becomes advance+confirm:
    // stamp reviewed_at (the grounded review happened), leave the loop active. A
    // consequential close ALSO raises `pending_confirm` in the SAME statement — the
    // gateway governor scans that flag and enqueues the one-tap confirm card (the
    // surfacing half of D5), so the advance + the "needs confirm" marker are atomic
    // (a crash can't advance without flagging). advance/keep_open never flag.
    const needsConfirm = action === 'close';
    await client.query(
      `UPDATE gtd_horizons
          SET reviewed_at = now(), updated_at = now()${needsConfirm ? ', pending_confirm = true' : ''}
        WHERE id = $1 AND user_id = $2`,
      [loopId, userId],
    );
    await client.query('COMMIT');
    return needsConfirm ? 'needs_confirm' : 'reviewed';
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    logger.error('[applyReconcile] failed — rolled back', { loopId, action, error: String(err) });
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Commit a consequential close AFTER the user has confirmed it (one-tap). Still
 * the worker/gateway is the sole writer — no second writer is introduced.
 * Atomic; user-scoped. NOT exposed as a worker tool (the human-confirm path is
 * gateway-side / A3); ported for parity + future use.
 */
export async function confirmReconcileClose(pool: Pool, userId: string, loopId: string): Promise<ReconcileResult> {
  const res = await pool.query(
    `UPDATE gtd_horizons
        SET status = 'completed', completed_at = now(), reviewed_at = now(), updated_at = now()
      WHERE id = $1 AND user_id = $2 AND horizon = 0 AND status = 'active'`,
    [loopId, userId],
  );
  return (res.rowCount ?? 0) > 0 ? 'closed' : 'not_found';
}

/**
 * Blast-radius circuit-breaker (D4, security HIGH-3). Given the count of closes
 * a single worker tick intends, decide whether to proceed or halt-and-surface.
 * Pure/deterministic so it's trivially testable and can't be prompt-bypassed.
 */
export const MAX_CLOSES_PER_TICK = 10;
export function withinCloseCap(closesThisTick: number): boolean {
  return closesThisTick <= MAX_CLOSES_PER_TICK;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Register the two off-agent reconcile-worker tools. Tenant (`userId`) ALWAYS
 * comes from `getUserId()` (request context) — never from a tool param — so a
 * cross-tenant param cannot escape the caller's scope.
 */
export function registerReconcileTools(
  server: McpServer,
  pool: Pool,
  esClient: Client | null | undefined,
  getUserId: () => string,
): void {
  server.tool(
    'list_reconcile_work',
    'DETERMINISTIC reconciliation selector (read-only). Returns the message-linked open loops a new inbound may have resolved (candidates) plus missed_close_count. The tenant is taken from the request context — no arguments. Best-effort: never throws.',
    {},
    async () => {
      const userId = getUserId();
      const work = await listReconcileWork(pool, esClient, userId).catch((err) => {
        // Belt-and-suspenders: the selector is already best-effort, but the tool
        // MUST never throw out of the worker's read path.
        logger.warn('[list_reconcile_work] degraded to empty', { error: String(err) });
        return { candidates: [], missed_close_count: 0 } as ReconcileWork;
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(work, null, 2) }] };
    },
  );

  server.tool(
    'reconcile_loop',
    "Apply a signal-driven reconciliation to ONE open loop through the deterministic mutation gate. Stakes routing: a 'consequential' loop is NEVER autonomously closed (close → needs_confirm, stamped reviewed, left active); a 'low' loop may auto-close. advance/keep_open stamp reviewed only. Returns { result: 'closed'|'reviewed'|'needs_confirm'|'not_found' }. Tenant comes from request context.",
    {
      loop_id: z.string().describe('The open loop (horizon-0) id to reconcile.'),
      action: z.enum(['close', 'advance', 'keep_open']).describe('The grounded reconcile action.'),
    },
    async (params) => {
      const userId = getUserId();
      const result = await applyReconcile(pool, userId, params.loop_id, params.action);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ result }, null, 2) }] };
    },
  );
}
