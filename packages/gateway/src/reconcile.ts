import type { Pool } from 'pg';
import type { Client } from '@elastic/elasticsearch';
import { logger } from './utils/logger.js';

/**
 * Reconciliation governor — the DETERMINISTIC selector (DECISION-025 D4).
 *
 * `listReconcileWork` is the reconciliation analogue of `list_narrative_work`:
 * an EXACT-match (never fuzzy) query that returns the message-linked open loops
 * a new inbound may have resolved, plus the `missed_close_count` metric. The
 * off-agent reconcile worker consumes the candidate list; anomaly-monitor reads
 * the count. The LLM never decides WHAT to reconcile — only judges an item.
 *
 * A loop is a **missed-close candidate** iff its linked conversation has an
 * inbound (from_me=false) NEWER than `reviewed_at` (or, if never reviewed,
 * newer than the loop's `created_at`). Because `reviewed_at` advances only on a
 * grounded reconcile action, a loop the worker read-and-kept-open is not a
 * candidate — so the count settles to 0 once the worker has reviewed the last
 * inbound (the at-least-once-until-reviewed guarantee).
 *
 * Honest scope: only loops with a linked `conversation_id` are seen here
 * (free-text / non-message / different-person loops are outside this metric by
 * design). Strictly `user_id`-scoped; best-effort (never throws).
 */

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

export async function listReconcileWork(pool: Pool, es: Client, userId: string): Promise<ReconcileWork> {
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
