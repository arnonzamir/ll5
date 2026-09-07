import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import type { Client } from '@elastic/elasticsearch';
import { chatAuthMiddleware } from './chat.js';
import { logger } from './utils/logger.js';

type AuthenticatedRequest = Request & { userId: string };
import {
  foldReadState, normalizeEvents, reduceDeliveryEvents, seenAgeText, unseenCount,
} from './utils/delivery-seen.js';
import type { UnseenCandidate } from './utils/delivery-seen.js';
import { aggregateDeliveryStats } from './utils/delivery-stats.js';
import type { StatsRow } from './utils/delivery-stats.js';
import { composeActivity, decodeCursor, encodeCursor } from './utils/activity-rail.js';
import type { ChatRowDoc, DeliveryDoc, JournalDoc, MomentDoc, TurnCostDoc } from './utils/activity-rail.js';

/**
 * Delivery contract routes, Phases 2-4 (DECISION-034):
 *
 *   POST /me/delivery-events   the app's seen signals → user_read_state + message_delivery columns
 *   GET  /me/seen-state        { chat_seen_up_to, unseen_count, open_asks } (also folded into GET /me/delivery-mode)
 *   GET  /me/delivery-stats    bucket × modality outcome counts for the nightly policy pass
 *   GET  /me/activity          the activity rail (one entry per handled proactive trigger)
 */

const isMissingRelation = (err: unknown): boolean => {
  const code = (err as { code?: string } | null)?.code;
  return code === '42P01' || code === '42703';
};

/** Rows without a read position are counted over this window only. */
const UNSEEN_LOOKBACK_DAYS = 7;

export interface SeenState {
  chat_seen_up_to: string | null;
  seen_age: string | null;
  unseen_count: number;
  open_asks: number;
}

export async function readSeenState(pool: Pool, userId: string, now = new Date()): Promise<SeenState> {
  let seenUpTo: string | null = null;
  try {
    const r = await pool.query<{ chat_seen_up_to: Date | null }>(`SELECT chat_seen_up_to FROM user_read_state WHERE user_id = $1`, [userId]);
    seenUpTo = r.rows[0]?.chat_seen_up_to ? new Date(r.rows[0].chat_seen_up_to).toISOString() : null;
  } catch (err) {
    if (!isMissingRelation(err)) throw err;
  }
  const since = seenUpTo ?? new Date(now.getTime() - UNSEEN_LOOKBACK_DAYS * 86_400_000).toISOString();
  const rows = await pool.query<UnseenCandidate>(
    `SELECT role, direction, created_at, metadata FROM chat_messages
      WHERE user_id = $1 AND role = 'assistant' AND direction = 'outbound' AND created_at > $2
        AND (metadata ? 'class' OR metadata ? 'notification_level')`,
    [userId, since],
  );
  let openAsks = 0;
  try {
    const a = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM tray_items
        WHERE user_id = $1 AND kind = 'ask' AND (status = 'open' OR (status = 'acknowledged' AND ack_required = true))`,
      [userId],
    );
    openAsks = parseInt(a.rows[0]?.n ?? '0', 10);
  } catch (err) {
    if (!isMissingRelation(err)) throw err;
  }
  return { chat_seen_up_to: seenUpTo, seen_age: seenAgeText(seenUpTo, now), unseen_count: unseenCount(rows.rows, seenUpTo), open_asks: openAsks };
}

export function createDeliveryRouter(pool: Pool, esClient: Client | undefined, authSecret: string): Router {
  const router = Router();
  const auth = chatAuthMiddleware(authSecret);

  // -------------------------------------------------------------------------
  // POST /me/delivery-events
  // -------------------------------------------------------------------------
  router.post('/me/delivery-events', auth, async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const body = (req.body ?? {}) as { events?: unknown };
    if (!Array.isArray(body.events)) {
      res.status(400).json({ error: 'events must be an array' });
      return;
    }
    const now = new Date();
    const { events, rejected } = normalizeEvents(body.events, now);
    try {
      // 1. read position — monotonic
      const seenUpTo = foldReadState(null, events);
      if (seenUpTo) {
        await pool.query(
          `INSERT INTO user_read_state (user_id, chat_seen_up_to, updated_at) VALUES ($1, $2, now())
           ON CONFLICT (user_id) DO UPDATE
             SET chat_seen_up_to = GREATEST(user_read_state.chat_seen_up_to, EXCLUDED.chat_seen_up_to), updated_at = now()`,
          [userId, seenUpTo],
        );
        // seen_at derivation: the read position passing a delivered message.
        await pool.query(
          `UPDATE message_delivery SET seen_at = $2
            WHERE user_id = $1 AND seen_at IS NULL AND created_at <= $2`,
          [userId, seenUpTo],
        );
      }
      // 2. per-delivery marks — first wins (COALESCE), feedback last wins
      for (const u of reduceDeliveryEvents(events)) {
        const where = u.target.delivery_id ? 'id = $2' : u.target.message_id ? 'message_id = $2' : 'tray_item_id = $2';
        const id = u.target.delivery_id ?? u.target.message_id ?? u.target.tray_item_id;
        await pool.query(
          `UPDATE message_delivery
              SET shown_at = COALESCE(shown_at, $3),
                  opened_at = COALESCE(opened_at, $4),
                  seen_at = COALESCE(seen_at, $5),
                  dismissed_at = COALESCE(dismissed_at, $6),
                  feedback = COALESCE($7, feedback)
            WHERE user_id = $1 AND ${where}`,
          [userId, id, u.shown_at ?? null, u.opened_at ?? null, u.seen_at ?? null, u.dismissed_at ?? null, u.feedback ?? null],
        );
      }
      res.status(202).json({ accepted: events.length, rejected });
    } catch (err) {
      if (isMissingRelation(err)) {
        logger.warn('[delivery][events] tables not ready (migration 050 pending) — events dropped', { userId });
        res.status(202).json({ accepted: 0, rejected: rejected + events.length, note: 'migration pending' });
        return;
      }
      logger.error('[delivery][events] failed', { userId, error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // -------------------------------------------------------------------------
  // GET /me/seen-state
  // -------------------------------------------------------------------------
  router.get('/me/seen-state', auth, async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    try {
      res.json(await readSeenState(pool, userId));
    } catch (err) {
      logger.error('[delivery][seenState] failed', { userId, error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // -------------------------------------------------------------------------
  // GET /me/delivery-stats?days=14
  // -------------------------------------------------------------------------
  router.get('/me/delivery-stats', auth, async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const daysRaw = parseInt(String((req.query as { days?: string }).days ?? '14'), 10);
    const days = Number.isFinite(daysRaw) ? Math.min(90, Math.max(1, daysRaw)) : 14;
    try {
      const r = await pool.query<StatsRow>(
        `SELECT class, stakes, due_at, created_at, delivery_mode, modality, status, seen_at, acknowledged_at, done_at,
                dismissed_at, feedback, explored, policy_bucket
           FROM message_delivery
          WHERE user_id = $1 AND created_at > now() - ($2 || ' days')::interval`,
        [userId, String(days)],
      );
      res.json({ days, buckets: aggregateDeliveryStats(r.rows) });
    } catch (err) {
      if (isMissingRelation(err)) { res.json({ days, buckets: [] }); return; }
      logger.error('[delivery][stats] failed', { userId, error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // -------------------------------------------------------------------------
  // GET /me/activity?since=&limit=&cursor=
  // -------------------------------------------------------------------------
  router.get('/me/activity', auth, async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const q = req.query as { since?: string; limit?: string; cursor?: string };
    const limitRaw = parseInt(q.limit ?? '50', 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, limitRaw)) : 50;
    const now = new Date();
    const since = q.since && Number.isFinite(Date.parse(q.since)) ? new Date(q.since).toISOString() : new Date(now.getTime() - 3 * 86_400_000).toISOString();
    const before = decodeCursor(q.cursor) ?? now.toISOString();
    if (Date.parse(before) <= Date.parse(since)) { res.json({ entries: [], next_cursor: null }); return; }

    try {
      // Rows in the window, plus the trigger rows referenced by trigger_id (fetched below).
      const chat = await pool.query<ChatRowDoc>(
        `SELECT id, role, channel, content, metadata, created_at FROM chat_messages
          WHERE user_id = $1 AND created_at >= $2 AND created_at < $3
            AND (metadata->>'rail' = 'true' OR (role = 'assistant' AND metadata ? 'class'))
          ORDER BY created_at DESC LIMIT $4`,
        [userId, since, before, limit * 8],
      );
      const [moments, journal, costs] = esClient
        ? await Promise.all([
          searchEs<MomentDoc>(esClient, 'll5_eval_moments', userId, 'timestamp', since, before, limit * 2),
          searchEs<JournalDoc>(esClient, 'll5_agent_journal', userId, 'created_at', since, before, limit * 4),
          searchEs<TurnCostDoc>(esClient, 'll5_turn_costs', userId, 'timestamp', since, before, limit * 4),
        ])
        : [[], [], []];

      const triggerIds = new Set<string>();
      for (const r of chat.rows) { const t = r.metadata?.trigger_id; if (typeof t === 'string') triggerIds.add(t); }
      for (const m of moments) { if (m.trigger_id) triggerIds.add(m.trigger_id); if (m.produced_message_id) triggerIds.add(m.produced_message_id); }
      const known = new Set(chat.rows.map((r) => r.id));
      const missing = [...triggerIds].filter((id) => !known.has(id) && /^[0-9a-f-]{36}$/i.test(id));
      const triggers = missing.length > 0
        ? await pool.query<ChatRowDoc>(`SELECT id, role, channel, content, metadata, created_at FROM chat_messages WHERE user_id = $1 AND id = ANY($2::uuid[])`, [userId, missing])
        : { rows: [] as ChatRowDoc[] };

      let deliveries: DeliveryDoc[] = [];
      try {
        const d = await pool.query<DeliveryDoc>(
          `SELECT message_id, tray_item_id, class, created_at FROM message_delivery WHERE user_id = $1 AND created_at >= $2 AND created_at < $3`,
          [userId, since, before],
        );
        deliveries = d.rows;
      } catch (err) {
        if (!isMissingRelation(err)) throw err;
      }

      const all = composeActivity({ moments, chatRows: [...chat.rows, ...triggers.rows], journal, deliveries, costs })
        .filter((e) => Date.parse(e.at) < Date.parse(before));
      const entries = all.slice(0, limit);
      const last = entries[entries.length - 1];
      res.json({ entries, next_cursor: all.length > limit && last ? encodeCursor(last.at) : null });
    } catch (err) {
      logger.error('[delivery][activity] failed', { userId, error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

async function searchEs<T extends { id: string }>(
  es: Client, index: string, userId: string, tsField: string, since: string, before: string, size: number,
): Promise<T[]> {
  try {
    const r = await es.search<Omit<T, 'id'>>({
      index, size,
      sort: [{ [tsField]: { order: 'desc' } }],
      query: { bool: { filter: [{ term: { user_id: userId } }, { range: { [tsField]: { gte: since, lt: before } } }] } },
    });
    return (r.hits?.hits ?? []).map((h) => ({ id: h._id, ...(h._source as object) }) as T);
  } catch (err) {
    logger.debug('[delivery][activity] ES source unavailable', { index, error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}
