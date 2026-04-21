import crypto from 'node:crypto';
import path from 'node:path';
import type { Client } from '@elastic/elasticsearch';
import { Router } from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import pg from 'pg';
import type { Pool, PoolClient } from 'pg';
import { logger } from './utils/logger.js';
import { sendFCMNotification } from './utils/fcm-sender.js';
import type { NotificationLevel } from './utils/fcm-sender.js';

const UPLOAD_DIR = process.env.NODE_ENV === 'production' ? '/app/uploads' : './uploads';

/** Conversations with archived_at < this window still accept inbound writes
 *  (rerouted to the current active). Prevents silent drops during the
 *  switch race when a client is mid-send while /new is being handled. */
const ARCHIVED_WRITE_GRACE_MS = 30_000;

/** Channels whose messages live in the unified LL5 conversation model.
 *  External messengers (WhatsApp/Telegram) keep their per-remote_jid
 *  conversations and are exempt from active-conversation routing.
 *  `system` is ephemeral (scheduler events, escalation notices,
 *  whatsapp-to-system conversions) — each event owns a fresh
 *  conversation_id and never surfaces in the user's chat thread, so it
 *  stays outside the unified model. Migration 023 scopes the DB
 *  counter-maintenance trigger to match. */
const UNIFIED_CHANNELS = new Set(['web', 'android', 'cli']);

const VALID_CHANNELS = ['web', 'telegram', 'whatsapp', 'cli', 'android', 'system'];
const VALID_REACTIONS = ['acknowledge', 'reject', 'agree', 'disagree', 'confused', 'thinking'];

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const userId = (req as AuthenticatedRequest).userId;
    const ext = path.extname(file.originalname).slice(1) || 'bin';
    const randomHex = crypto.randomBytes(4).toString('hex');
    cb(null, `${userId}_${Date.now()}_${randomHex}.${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${file.mimetype}. Allowed: ${allowed.join(', ')}`));
    }
  },
});

interface AuthenticatedRequest extends Request {
  userId: string;
}

export function chatAuthMiddleware(authSecret: string) {
  return async (req: Request, res: Response, next: () => void): Promise<void> => {
    const authHeader = req.headers.authorization;
    const queryToken = req.query.token as string | undefined;
    const rawToken = authHeader?.startsWith('Bearer ll5.')
      ? authHeader.slice(7)
      : queryToken?.startsWith('ll5.') ? queryToken : null;

    if (!rawToken) {
      res.status(401).json({ error: 'Missing or invalid authorization' });
      return;
    }

    try {
      const crypto = await import('node:crypto');
      const token = rawToken;
      const parts = token.split('.');
      if (parts.length !== 3 || parts[0] !== 'll5') {
        res.status(401).json({ error: 'Invalid token format' });
        return;
      }

      const [, payloadB64, signature] = parts;

      const expected = crypto.createHmac('sha256', authSecret)
        .update(payloadB64).digest('hex').slice(0, 32);

      if (signature.length !== 32) {
        res.status(401).json({ error: 'Invalid token' });
        return;
      }

      if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) {
        res.status(401).json({ error: 'Invalid token' });
        return;
      }

      const payload = JSON.parse(
        Buffer.from(payloadB64, 'base64url').toString(),
      ) as { uid: string; iat: number; exp: number };

      if (payload.exp < Date.now() / 1000) {
        res.status(401).json({ error: 'token_expired' });
        return;
      }

      (req as AuthenticatedRequest).userId = payload.uid;
      next();
    } catch (err) {
      logger.warn('[chat][authMiddleware] Token validation error', { error: err instanceof Error ? err.message : String(err) });
      res.status(401).json({ error: 'Invalid token' });
    }
  };
}

// ---------------------------------------------------------------------------
// Active conversation resolution for LL5-native channels.
// ---------------------------------------------------------------------------

/** Return the user's active LL5-native conversation id, creating one if none
 *  exists. Safe against the unique-partial-index race via a bounded retry
 *  loop: up to 3 attempts (read → insert → re-read on 23505). Under high
 *  concurrency with read-committed isolation, the loser of the race can
 *  still see zero rows on the first re-read (the winner's row hasn't
 *  COMMITted yet), so a few retries with a small backoff is the cheapest
 *  robust fix.
 *
 *  **Invariant**: this is the only sanctioned path to resolve or create an
 *  active LL5-native conversation. Do not INSERT into chat_conversations
 *  outside this helper — hand-rolled INSERTs will either race against the
 *  unique-partial-index or miss the "archived writes reroute" logic at the
 *  POST /messages layer. */
async function getOrCreateActiveConversation(
  client: PoolClient | Pool,
  userId: string,
): Promise<string> {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const existing = await client.query<{ conversation_id: string }>(
      `SELECT conversation_id FROM chat_conversations
       WHERE user_id = $1 AND archived_at IS NULL`,
      [userId],
    );
    if (existing.rows.length > 0) return existing.rows[0].conversation_id;

    try {
      const inserted = await client.query<{ conversation_id: string }>(
        `INSERT INTO chat_conversations (conversation_id, user_id, created_at, last_message_at, message_count)
         VALUES (gen_random_uuid(), $1, now(), now(), 0)
         RETURNING conversation_id`,
        [userId],
      );
      return inserted.rows[0].conversation_id;
    } catch (err) {
      // 23505 = unique_violation. A concurrent call won the race. Fall
      // through to the next attempt's SELECT — the winner's row may not
      // be COMMITted yet on the first retry, so small linear backoff.
      if (err && typeof err === 'object' && (err as { code?: string }).code === '23505') {
        if (attempt < MAX_ATTEMPTS - 1) {
          await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
          continue;
        }
      }
      throw err;
    }
  }
  throw new Error(`getOrCreateActiveConversation: exhausted ${MAX_ATTEMPTS} attempts for user ${userId}`);
}

/** Given a conversation id submitted by a client, decide what to do:
 *   - exists + active: use it as-is.
 *   - exists + archived <30s ago: accept but reroute to current active
 *     (returns the new id so caller can signal the reroute to the client).
 *   - exists + archived >30s ago: reject; caller returns 409.
 *   - does not exist: caller uses the id as-is (new conversation). */
async function resolveWriteTarget(
  client: PoolClient | Pool,
  userId: string,
  requestedId: string,
): Promise<
  | { kind: 'ok'; conversation_id: string }
  | { kind: 'rerouted'; conversation_id: string; original_id: string }
  | { kind: 'archived'; active_conversation_id: string | null }
> {
  const result = await client.query<{ archived_at: string | null; user_id: string }>(
    `SELECT user_id, archived_at FROM chat_conversations
     WHERE conversation_id = $1`,
    [requestedId],
  );

  if (result.rows.length === 0) {
    // Not a tracked conversation — might be a brand-new id or a
    // whatsapp/telegram one. Accept as-is; active-conversation logic
    // doesn't apply.
    return { kind: 'ok', conversation_id: requestedId };
  }

  const row = result.rows[0];
  if (row.user_id !== userId) {
    // Caller doesn't own this conversation; fall back to active.
    const active = await getOrCreateActiveConversation(client, userId);
    return { kind: 'rerouted', conversation_id: active, original_id: requestedId };
  }

  if (row.archived_at === null) {
    return { kind: 'ok', conversation_id: requestedId };
  }

  const archivedAt = new Date(row.archived_at).getTime();
  if (Date.now() - archivedAt <= ARCHIVED_WRITE_GRACE_MS) {
    const active = await getOrCreateActiveConversation(client, userId);
    return { kind: 'rerouted', conversation_id: active, original_id: requestedId };
  }

  const activeRes = await client.query<{ conversation_id: string }>(
    `SELECT conversation_id FROM chat_conversations
     WHERE user_id = $1 AND archived_at IS NULL`,
    [userId],
  );
  return {
    kind: 'archived',
    active_conversation_id: activeRes.rows[0]?.conversation_id ?? null,
  };
}

/**
 * Create the /chat router with message queue endpoints.
 */
export function createChatRouter(pool: Pool, authSecret: string, esClient?: Client): Router {
  const router = Router();
  const auth = chatAuthMiddleware(authSecret);

  // ---------------------------------------------------------------------------
  // POST /chat/messages — create message (inbound or outbound, incl. reactions)
  // ---------------------------------------------------------------------------
  router.post('/messages', auth, async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const {
      channel,
      content,
      conversation_id,
      metadata,
      direction,
      role,
      notification_level,
      reply_to_id,
      reaction,
      display_compact,
    } = req.body as {
      channel?: string;
      content?: string | null;
      conversation_id?: string;
      metadata?: Record<string, unknown>;
      direction?: string;
      role?: string;
      notification_level?: NotificationLevel;
      reply_to_id?: string;
      reaction?: string;
      display_compact?: boolean;
    };

    if (!channel) {
      res.status(400).json({ error: 'Missing required field: channel' });
      return;
    }
    if (!VALID_CHANNELS.includes(channel)) {
      res.status(400).json({ error: `Invalid channel. Must be one of: ${VALID_CHANNELS.join(', ')}` });
      return;
    }

    const isReaction = reaction != null;
    if (isReaction) {
      if (!VALID_REACTIONS.includes(reaction)) {
        res.status(400).json({ error: `Invalid reaction. Must be one of: ${VALID_REACTIONS.join(', ')}` });
        return;
      }
      if (!reply_to_id) {
        res.status(400).json({ error: 'reaction requires reply_to_id' });
        return;
      }
      if (content != null && content !== '') {
        res.status(400).json({ error: 'reaction rows must not have content' });
        return;
      }
    } else if (content == null) {
      res.status(400).json({ error: 'Missing required field: content (or provide reaction)' });
      return;
    }

    const msgDirection = direction || 'inbound';
    const msgRole = role || 'user';
    const msgStatus = msgDirection === 'outbound' ? 'delivered' : 'pending';

    try {
      // Resolve conversation target for LL5-native channels.
      let targetConvId = conversation_id || null;
      let rerouted: { from: string; to: string } | null = null;

      if (UNIFIED_CHANNELS.has(channel)) {
        if (targetConvId) {
          const decision = await resolveWriteTarget(pool, userId, targetConvId);
          if (decision.kind === 'archived') {
            res.status(409).json({
              error: 'conversation_archived',
              code: 'conversation_archived',
              active_conversation_id: decision.active_conversation_id,
            });
            return;
          }
          if (decision.kind === 'rerouted') {
            targetConvId = decision.conversation_id;
            rerouted = { from: decision.original_id, to: decision.conversation_id };
          } else {
            targetConvId = decision.conversation_id;
          }
        } else {
          // No id supplied → active conversation.
          targetConvId = await getOrCreateActiveConversation(pool, userId);
        }
      }

      const result = await pool.query<{ id: string; conversation_id: string }>(
        `INSERT INTO chat_messages
           (user_id, conversation_id, channel, direction, role, content, status,
            metadata, reply_to_id, reaction, display_compact)
         VALUES ($1, COALESCE($2::uuid, gen_random_uuid()), $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id, conversation_id`,
        [
          userId,
          targetConvId,
          channel,
          msgDirection,
          msgRole,
          isReaction ? null : content,
          msgStatus,
          JSON.stringify(metadata || {}),
          reply_to_id || null,
          reaction || null,
          display_compact === true,
        ],
      );

      const row = result.rows[0];
      const body: Record<string, unknown> = { id: row.id, conversation_id: row.conversation_id };
      if (rerouted) body.rerouted_from = rerouted.from;
      res.status(201).json(body);

      if (notification_level && msgDirection === 'outbound' && !isReaction) {
        const bodyText = content ?? '';
        const truncBody = bodyText.length > 200 ? bodyText.slice(0, 200) + '...' : bodyText;
        sendFCMNotification(pool, userId, {
          title: 'LL5',
          body: truncBody,
          type: 'agent_push',
          notification_level,
        }).catch((err) => {
          logger.warn('[chat][createMessage] FCM send failed', { error: err instanceof Error ? err.message : String(err) });
        });
      }
    } catch (err) {
      logger.error('[chat][createMessage] Failed to create chat message', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /chat/messages — pull messages for a conversation or channel
  // ---------------------------------------------------------------------------
  router.get('/messages', auth, async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const { conversation_id, channel, status, since, limit: limitStr } = req.query as {
      conversation_id?: string;
      channel?: string;
      status?: string;
      since?: string;
      limit?: string;
    };

    const limit = Math.min(parseInt(limitStr || '100', 10), 500);
    const conditions: string[] = ['user_id = $1'];
    const params: unknown[] = [userId];
    let paramIdx = 2;

    if (conversation_id) {
      conditions.push(`conversation_id = $${paramIdx++}`);
      params.push(conversation_id);
    }
    if (channel) {
      conditions.push(`channel = $${paramIdx++}`);
      params.push(channel);
    }
    if (status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(status);
    }
    if (since) {
      conditions.push(`created_at > $${paramIdx++}`);
      params.push(since);
    }

    try {
      const where = conditions.join(' AND ');
      const countResult = await pool.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM chat_messages WHERE ${where}`,
        params,
      );
      const total = parseInt(countResult.rows[0].count, 10);

      const messagesResult = await pool.query(
        `SELECT * FROM (
           SELECT id, conversation_id, channel, direction, role, content, status,
                  reply_to_id, reaction, display_compact, metadata, created_at, updated_at
           FROM chat_messages WHERE ${where}
           ORDER BY created_at DESC
           LIMIT $${paramIdx}
         ) sub ORDER BY created_at ASC`,
        [...params, limit],
      );

      res.json({ messages: messagesResult.rows, total });
    } catch (err) {
      logger.error('[chat][fetchMessages] Failed to fetch chat messages', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /chat/messages/:id — get a single message by ID
  // ---------------------------------------------------------------------------
  router.get('/messages/:id', auth, async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    try {
      const result = await pool.query(
        `SELECT id, conversation_id, channel, direction, role, content, status,
                reply_to_id, reaction, display_compact, metadata, created_at, updated_at
           FROM chat_messages WHERE id = $1 AND user_id = $2`,
        [req.params.id, userId],
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Message not found' });
        return;
      }
      res.json(result.rows[0]);
    } catch (err) {
      logger.error('[chat][fetchMessage] Failed to fetch message', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /chat/pending — get unread inbound messages
  // ---------------------------------------------------------------------------
  router.get('/pending', auth, async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const { channel } = req.query as { channel?: string };

    const conditions = ['user_id = $1', "direction = 'inbound'", "status = 'pending'"];
    const params: unknown[] = [userId];

    if (channel) {
      conditions.push('channel = $2');
      params.push(channel);
    }

    try {
      const result = await pool.query(
        `SELECT id, conversation_id, channel, role, content, reaction, reply_to_id,
                display_compact, metadata, created_at
         FROM chat_messages WHERE ${conditions.join(' AND ')}
         ORDER BY created_at ASC`,
        params,
      );

      res.json({ messages: result.rows, total: result.rows.length });
    } catch (err) {
      logger.error('[chat][fetchPending] Failed to fetch pending messages', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ---------------------------------------------------------------------------
  // PATCH /chat/messages/:id — update status or set a reaction
  // ---------------------------------------------------------------------------
  router.patch('/messages/:id', auth, async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const messageId = req.params.id;
    const { status, reaction } = req.body as { status?: string; reaction?: string | null };

    // Two modes: status update (legacy) or react-to-message (new).
    // Reacting is modeled as inserting a new reaction row targeting this
    // message, not mutating the message itself. The PATCH just validates
    // the target and delegates.
    if (reaction !== undefined) {
      if (reaction !== null && !VALID_REACTIONS.includes(reaction)) {
        res.status(400).json({ error: `Invalid reaction. Must be one of: ${VALID_REACTIONS.join(', ')}` });
        return;
      }

      try {
        const target = await pool.query<{ channel: string; conversation_id: string }>(
          'SELECT channel, conversation_id FROM chat_messages WHERE id = $1 AND user_id = $2',
          [messageId, userId],
        );
        if (target.rows.length === 0) {
          res.status(404).json({ error: 'Message not found' });
          return;
        }

        if (reaction === null) {
          // Remove current user's reaction to this message (if any).
          await pool.query(
            `DELETE FROM chat_messages
               WHERE user_id = $1 AND reply_to_id = $2
                 AND reaction IS NOT NULL AND role = 'user'`,
            [userId, messageId],
          );
          res.json({ removed: true });
          return;
        }

        // Upsert semantics: one reaction per (user, target_message).
        // Delete existing reaction rows from this user, then insert.
        await pool.query(
          `DELETE FROM chat_messages
             WHERE user_id = $1 AND reply_to_id = $2
               AND reaction IS NOT NULL AND role = 'user'`,
          [userId, messageId],
        );

        const insert = await pool.query<{ id: string }>(
          `INSERT INTO chat_messages
             (user_id, conversation_id, channel, direction, role, content, status, reply_to_id, reaction)
           VALUES ($1, $2, $3, 'inbound', 'user', NULL, 'delivered', $4, $5)
           RETURNING id`,
          [userId, target.rows[0].conversation_id, target.rows[0].channel, messageId, reaction],
        );
        res.status(201).json({ id: insert.rows[0].id, reaction });
        return;
      } catch (err) {
        logger.error('[chat][react] Failed to set reaction', {
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: 'Internal server error' });
        return;
      }
    }

    const validStatuses = ['pending', 'processing', 'delivered', 'failed'];
    if (!status || !validStatuses.includes(status)) {
      res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
      return;
    }

    try {
      const result = await pool.query(
        `UPDATE chat_messages SET status = $1, updated_at = now()
         WHERE id = $2 AND user_id = $3
         RETURNING id, conversation_id, channel, direction, role, content, status,
                   reply_to_id, reaction, display_compact, metadata, created_at, updated_at`,
        [status, messageId, userId],
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Message not found' });
        return;
      }

      res.json(result.rows[0]);
    } catch (err) {
      logger.error('[chat][updateMessage] Failed to update chat message', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /chat/conversations/new — archive active + open fresh
  // ---------------------------------------------------------------------------
  router.post('/conversations/new', auth, async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const { summary, title } = req.body as { summary?: string; title?: string };

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Archive existing active (if any) with NOW() — archival time stays
      // truthful, so later debugging isn't lying about when it happened.
      const priorRes = await client.query<{ conversation_id: string }>(
        `UPDATE chat_conversations
            SET archived_at = now(),
                summary     = COALESCE($2, summary)
          WHERE user_id = $1 AND archived_at IS NULL
          RETURNING conversation_id`,
        [userId, summary ?? null],
      );
      const priorId = priorRes.rows[0]?.conversation_id ?? null;

      // Insert new active. The unique partial index (archived_at IS NULL)
      // guarantees only one active per user.
      const newRes = await client.query<{ conversation_id: string; created_at: string }>(
        `INSERT INTO chat_conversations
           (conversation_id, user_id, title, created_at, last_message_at, message_count)
         VALUES (gen_random_uuid(), $1, $2, now(), now(), 0)
         RETURNING conversation_id, created_at`,
        [userId, title ?? null],
      );

      await client.query('COMMIT');

      res.status(201).json({
        conversation_id: newRes.rows[0].conversation_id,
        prior_id: priorId,
        prior_summary: summary ?? null,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => { /* noop */ });
      logger.error('[chat][newConversation] Failed to create conversation', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  });

  // ---------------------------------------------------------------------------
  // GET /chat/conversations — list conversations
  // Active LL5-native first, then archived; optionally filter by channel.
  // Legacy callers (channel=web/android) still get per-channel grouping for
  // backwards compat during rollout — those go through the chat_messages
  // aggregation path. Default (no channel) returns chat_conversations.
  // ---------------------------------------------------------------------------
  router.get('/conversations', auth, async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const { channel, limit: limitStr, include_archived } = req.query as {
      channel?: string;
      limit?: string;
      include_archived?: string;
    };
    const limit = Math.min(parseInt(limitStr || '50', 10), 200);

    try {
      if (channel) {
        // Legacy shape — aggregate directly from chat_messages.
        const channelFilter = 'AND m.channel = $2';
        const params: unknown[] = [userId, channel, limit];
        const limitParam = '$3';

        const result = await pool.query(
          `SELECT
             m.conversation_id,
             m.channel,
             MAX(m.created_at) as last_message_at,
             COUNT(*) as message_count,
             COUNT(*) FILTER (WHERE m.direction = 'inbound' AND m.status = 'pending') as unread_count,
             (SELECT content FROM chat_messages sub
              WHERE sub.conversation_id = m.conversation_id AND sub.user_id = $1
              ORDER BY sub.created_at DESC LIMIT 1) as last_message
           FROM chat_messages m
           WHERE m.user_id = $1 ${channelFilter}
           GROUP BY m.conversation_id, m.channel
           ORDER BY MAX(m.created_at) DESC
           LIMIT ${limitParam}`,
          params,
        );

        res.json({ conversations: result.rows, total: result.rows.length });
        return;
      }

      const archivedCond = include_archived === 'false' ? 'AND archived_at IS NULL' : '';
      const result = await pool.query(
        `SELECT
           conversation_id,
           title,
           summary,
           created_at,
           archived_at,
           last_message_at,
           message_count,
           (SELECT content FROM chat_messages sub
              WHERE sub.conversation_id = c.conversation_id AND sub.user_id = $1
                AND sub.content IS NOT NULL
              ORDER BY sub.created_at DESC LIMIT 1) as last_message,
           (SELECT COUNT(*) FROM chat_messages sub
              WHERE sub.conversation_id = c.conversation_id AND sub.user_id = $1
                AND sub.direction = 'inbound' AND sub.status = 'pending') as unread_count
         FROM chat_conversations c
         WHERE user_id = $1 ${archivedCond}
         ORDER BY (archived_at IS NULL) DESC, last_message_at DESC NULLS LAST
         LIMIT $2`,
        [userId, limit],
      );

      res.json({ conversations: result.rows, total: result.rows.length });
    } catch (err) {
      logger.error('[chat][fetchConversations] Failed to fetch conversations', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /chat/conversations/active — current active LL5-native conversation
  // ---------------------------------------------------------------------------
  router.get('/conversations/active', auth, async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    try {
      const id = await getOrCreateActiveConversation(pool, userId);
      const row = await pool.query(
        `SELECT conversation_id, title, summary, created_at, last_message_at, message_count
           FROM chat_conversations WHERE conversation_id = $1`,
        [id],
      );
      res.json(row.rows[0] ?? { conversation_id: id });
    } catch (err) {
      logger.error('[chat][activeConversation] Failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /chat/conversations/search?q=...
  // ES-backed full-text search with ILIKE fallback if ES is unavailable.
  // ---------------------------------------------------------------------------
  router.get('/conversations/search', auth, async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const q = (req.query.q as string | undefined)?.trim();
    const limit = Math.min(parseInt((req.query.limit as string) || '20', 10), 50);

    if (!q || q.length < 2) {
      res.status(400).json({ error: 'q (query) required, min 2 chars' });
      return;
    }

    // Try ES first.
    if (esClient) {
      try {
        const esRes = await esClient.search({
          index: 'll5_chat_messages',
          size: limit * 3,
          query: {
            bool: {
              filter: [{ term: { user_id: userId } }],
              must: [{ match: { content: { query: q, operator: 'and' } } }],
            },
          },
          sort: [{ created_at: 'desc' }],
          highlight: {
            fields: { content: { number_of_fragments: 1, fragment_size: 160 } },
          },
        });

        type Hit = {
          _source: { conversation_id: string; content: string; created_at: string };
          highlight?: { content?: string[] };
        };
        const hits = (esRes.hits.hits as unknown as Hit[]) || [];
        const byConv = new Map<string, {
          conversation_id: string;
          snippet: string;
          matched_at: string;
        }>();
        for (const h of hits) {
          if (byConv.has(h._source.conversation_id)) continue;
          byConv.set(h._source.conversation_id, {
            conversation_id: h._source.conversation_id,
            snippet: h.highlight?.content?.[0] ?? (h._source.content ?? '').slice(0, 160),
            matched_at: h._source.created_at,
          });
          if (byConv.size >= limit) break;
        }

        if (byConv.size === 0) {
          res.json({ results: [], backend: 'es' });
          return;
        }

        // Enrich with conversation metadata from PG.
        const ids = Array.from(byConv.keys());
        const meta = await pool.query(
          `SELECT conversation_id, title, summary, archived_at, last_message_at, message_count
             FROM chat_conversations WHERE user_id = $1 AND conversation_id = ANY($2::uuid[])`,
          [userId, ids],
        );
        const metaById = new Map(meta.rows.map((r: { conversation_id: string }) => [r.conversation_id, r]));

        const results = ids.map((id) => ({
          ...byConv.get(id)!,
          ...(metaById.get(id) || {}),
        }));

        res.json({ results, backend: 'es' });
        return;
      } catch (err) {
        logger.warn('[chat][search] ES search failed, falling back to ILIKE', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ILIKE fallback — scoped to the last 500 conversations for this user.
    try {
      const fallback = await pool.query(
        `WITH recent AS (
           SELECT conversation_id FROM chat_conversations
            WHERE user_id = $1 ORDER BY last_message_at DESC NULLS LAST LIMIT 500
         )
         SELECT DISTINCT ON (m.conversation_id)
           m.conversation_id,
           LEFT(m.content, 160) AS snippet,
           m.created_at AS matched_at,
           c.title,
           c.summary,
           c.archived_at,
           c.last_message_at,
           c.message_count
         FROM chat_messages m
         JOIN recent r USING (conversation_id)
         JOIN chat_conversations c USING (conversation_id)
         WHERE m.user_id = $1
           AND m.content ILIKE '%' || $2 || '%'
         ORDER BY m.conversation_id, m.created_at DESC
         LIMIT $3`,
        [userId, q, limit],
      );
      res.json({ results: fallback.rows, backend: 'ilike' });
    } catch (err) {
      logger.error('[chat][search] Fallback search failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /chat/conversations/:id — metadata + first page of messages
  // ---------------------------------------------------------------------------
  router.get('/conversations/:id', auth, async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const convId = req.params.id;
    try {
      const conv = await pool.query(
        `SELECT conversation_id, title, summary, created_at, archived_at,
                last_message_at, message_count
           FROM chat_conversations
          WHERE conversation_id = $1 AND user_id = $2`,
        [convId, userId],
      );
      if (conv.rows.length === 0) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }

      const messages = await pool.query(
        `SELECT id, conversation_id, channel, direction, role, content, status,
                reply_to_id, reaction, display_compact, metadata, created_at, updated_at
           FROM chat_messages
          WHERE conversation_id = $1 AND user_id = $2
          ORDER BY created_at ASC
          LIMIT 200`,
        [convId, userId],
      );

      res.json({ conversation: conv.rows[0], messages: messages.rows });
    } catch (err) {
      logger.error('[chat][fetchConversation] Failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /chat/listen — SSE: chat_messages + chat_conversations NOTIFY channels
  // ---------------------------------------------------------------------------
  router.get('/listen', auth, async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('data: {"type":"connected"}\n\n');

    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      res.write('data: {"type":"error","message":"No database connection"}\n\n');
      res.end();
      return;
    }

    const listener = new pg.Client({ connectionString });

    try {
      await listener.connect();
      await listener.query('LISTEN chat_messages');
      await listener.query('LISTEN chat_conversations');

      listener.on('notification', (msg) => {
        try {
          const data = JSON.parse(msg.payload || '{}');
          if (data.user_id && data.user_id !== userId) return;
          delete data.user_id;
          if (msg.channel === 'chat_conversations') {
            data.type = data.event === 'archived' ? 'conversation_archived' : 'conversation_created';
          }
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch (err) {
          logger.warn('[chat][listen] Malformed NOTIFY payload', { error: err instanceof Error ? err.message : String(err) });
        }
      });

      listener.on('error', () => {
        res.end();
      });

      req.on('close', () => {
        listener.end().catch((err: unknown) => {
          logger.debug('[chat][listen] PG listener cleanup error', { error: err instanceof Error ? err.message : String(err) });
        });
      });

      const keepAlive = setInterval(() => {
        res.write(': keepalive\n\n');
      }, 30000);

      req.on('close', () => {
        clearInterval(keepAlive);
      });

    } catch (err) {
      logger.error('[chat][listen] SSE listen failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.write(`data: {"type":"error","message":"Connection failed"}\n\n`);
      res.end();
    }
  });

  // ---------------------------------------------------------------------------
  // POST /chat/upload — upload an image file
  // ---------------------------------------------------------------------------
  router.post('/upload', auth, (req: Request, res: Response, next: () => void) => {
    upload.single('file')(req, res, (err: unknown) => {
      if (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({ error: 'File too large. Maximum size is 10MB.' });
          return;
        }
        res.status(400).json({ error: message });
        return;
      }
      next();
    });
  }, async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    const filename = req.file.filename;

    if (esClient) {
      try {
        await esClient.index({
          index: 'll5_media',
          document: {
            user_id: (req as AuthenticatedRequest).userId,
            url: `/uploads/${filename}`,
            mime_type: req.file.mimetype,
            filename: req.file.originalname,
            size_bytes: req.file.size,
            source: 'chat',
            created_at: new Date().toISOString(),
          },
        });
      } catch (err) {
        logger.warn('[chat][upload] Failed to register media in ES', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    res.status(201).json({
      id: filename,
      url: `/uploads/${filename}`,
      filename: req.file.originalname,
    });
  });

  return router;
}
