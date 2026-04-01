import crypto from 'node:crypto';
import path from 'node:path';
import { Router } from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import pg from 'pg';
import type { Pool } from 'pg';
import { logger } from './utils/logger.js';

const UPLOAD_DIR = process.env.NODE_ENV === 'production' ? '/app/uploads' : './uploads';

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
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
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

/**
 * Auth middleware for chat endpoints.
 * Replicates the same ll5 token validation used by MCP services.
 */
export function chatAuthMiddleware(authSecret: string) {
  return async (req: Request, res: Response, next: () => void): Promise<void> => {
    // Accept token from Authorization header or ?token= query param (for EventSource SSE)
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
    } catch {
      res.status(401).json({ error: 'Invalid token' });
    }
  };
}

/**
 * Create the /chat router with message queue endpoints.
 */
export function createChatRouter(pool: Pool, authSecret: string): Router {
  const router = Router();
  const auth = chatAuthMiddleware(authSecret);

  // ---------------------------------------------------------------------------
  // POST /chat/messages — channel pushes a message (inbound or outbound)
  // ---------------------------------------------------------------------------
  router.post('/messages', auth, async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const { channel, content, conversation_id, metadata, direction, role } = req.body as {
      channel?: string;
      content?: string;
      conversation_id?: string;
      metadata?: Record<string, unknown>;
      direction?: string;
      role?: string;
    };

    if (!channel || content == null) {
      res.status(400).json({ error: 'Missing required fields: channel, content' });
      return;
    }

    const validChannels = ['web', 'telegram', 'whatsapp', 'cli', 'android', 'system'];
    if (!validChannels.includes(channel)) {
      res.status(400).json({ error: `Invalid channel. Must be one of: ${validChannels.join(', ')}` });
      return;
    }

    const msgDirection = direction || 'inbound';
    const msgRole = role || 'user';
    const msgStatus = msgDirection === 'outbound' ? 'delivered' : 'pending';

    try {
      const result = await pool.query<{ id: string; conversation_id: string }>(
        `INSERT INTO chat_messages (user_id, conversation_id, channel, direction, role, content, status, metadata)
         VALUES ($1, COALESCE($2::uuid, gen_random_uuid()), $3, $4, $5, $6, $7, $8)
         RETURNING id, conversation_id`,
        [
          userId,
          conversation_id || null,
          channel,
          msgDirection,
          msgRole,
          content,
          msgStatus,
          JSON.stringify(metadata || {}),
        ],
      );

      const row = result.rows[0];
      res.status(201).json({ id: row.id, conversation_id: row.conversation_id });
    } catch (err) {
      logger.error('Failed to create chat message', {
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

      // Get the latest N messages (DESC for limit, then re-sort ASC for display order)
      const messagesResult = await pool.query(
        `SELECT * FROM (
           SELECT id, conversation_id, channel, direction, role, content, status, reply_to_id, metadata, created_at, updated_at
           FROM chat_messages WHERE ${where}
           ORDER BY created_at DESC
           LIMIT $${paramIdx}
         ) sub ORDER BY created_at ASC`,
        [...params, limit],
      );

      res.json({ messages: messagesResult.rows, total });
    } catch (err) {
      logger.error('Failed to fetch chat messages', {
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
        'SELECT * FROM chat_messages WHERE id = $1 AND user_id = $2',
        [req.params.id, userId],
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Message not found' });
        return;
      }
      res.json(result.rows[0]);
    } catch (err) {
      logger.error('Failed to fetch message', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /chat/pending — get unread inbound messages (for Claude to check)
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
        `SELECT id, conversation_id, channel, role, content, metadata, created_at
         FROM chat_messages WHERE ${conditions.join(' AND ')}
         ORDER BY created_at ASC`,
        params,
      );

      res.json({ messages: result.rows, total: result.rows.length });
    } catch (err) {
      logger.error('Failed to fetch pending messages', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ---------------------------------------------------------------------------
  // PATCH /chat/messages/:id — update message status
  // ---------------------------------------------------------------------------
  router.patch('/messages/:id', auth, async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const messageId = req.params.id;
    const { status } = req.body as { status?: string };

    const validStatuses = ['pending', 'processing', 'delivered', 'failed'];
    if (!status || !validStatuses.includes(status)) {
      res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
      return;
    }

    try {
      const result = await pool.query(
        `UPDATE chat_messages SET status = $1, updated_at = now()
         WHERE id = $2 AND user_id = $3
         RETURNING id, conversation_id, channel, direction, role, content, status, reply_to_id, metadata, created_at, updated_at`,
        [status, messageId, userId],
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Message not found' });
        return;
      }

      res.json(result.rows[0]);
    } catch (err) {
      logger.error('Failed to update chat message', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /chat/conversations — list conversations
  // ---------------------------------------------------------------------------
  router.get('/conversations', auth, async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const { channel, limit: limitStr } = req.query as { channel?: string; limit?: string };

    const limit = Math.min(parseInt(limitStr || '20', 10), 100);
    const channelFilter = channel ? 'AND m.channel = $2' : '';
    const params: unknown[] = channel ? [userId, channel, limit] : [userId, limit];
    const limitParam = channel ? '$3' : '$2';

    try {
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
    } catch (err) {
      logger.error('Failed to fetch conversations', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /chat/listen — SSE endpoint for real-time message notifications
  // Uses PG LISTEN/NOTIFY — no polling
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

    // Dedicated PG client for LISTEN (can't use pool — LISTEN is session-level)
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

      listener.on('notification', (msg) => {
        if (msg.channel !== 'chat_messages') return;
        try {
          const data = JSON.parse(msg.payload || '{}');
          // Filter to this user's messages only
          if (data.user_id && data.user_id !== userId) return;
          // Strip user_id before sending to client
          delete data.user_id;
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch { /* skip malformed */ }
      });

      listener.on('error', () => {
        res.end();
      });

      // Clean up on client disconnect
      req.on('close', () => {
        listener.end().catch(() => {});
      });

      // Keep-alive ping every 30s
      const keepAlive = setInterval(() => {
        res.write(': keepalive\n\n');
      }, 30000);

      req.on('close', () => {
        clearInterval(keepAlive);
      });

    } catch (err) {
      logger.error('SSE listen failed', {
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
  }, (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    const filename = req.file.filename;
    res.status(201).json({
      id: filename,
      url: `/uploads/${filename}`,
      filename: req.file.originalname,
    });
  });

  return router;
}
