import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { chatAuthMiddleware, createChatRouter } from '../chat.js';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AUTH_SECRET = 'test-secret-key-for-testing';

/** Generate a valid ll5 token for testing. */
function generateTestToken(
  userId: string,
  ttlDays = 30,
  overrides: Partial<{ iat: number; exp: number }> = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    uid: userId,
    role: 'user',
    iat: overrides.iat ?? now,
    exp: overrides.exp ?? now + ttlDays * 86400,
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', AUTH_SECRET)
    .update(payloadB64)
    .digest('hex')
    .slice(0, 32);

  return `ll5.${payloadB64}.${signature}`;
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    query: {},
    body: {},
    params: {},
    ...overrides,
  } as unknown as Request;
}

function makeRes(): Response & { _status: number; _json: unknown } {
  const res = {
    _status: 200,
    _json: null as unknown,
    status(code: number) {
      this._status = code;
      return this;
    },
    json(data: unknown) {
      this._json = data;
      return this;
    },
  } as unknown as Response & { _status: number; _json: unknown };
  return res;
}

function makePgPool(queryResult: { rows: Record<string, unknown>[]; rowCount?: number } = { rows: [] }): Pool {
  return {
    query: vi.fn().mockResolvedValue(queryResult),
  } as unknown as Pool;
}

// ---------------------------------------------------------------------------
// chatAuthMiddleware tests
// ---------------------------------------------------------------------------

describe('chatAuthMiddleware', () => {
  let middleware: ReturnType<typeof chatAuthMiddleware>;

  beforeEach(() => {
    middleware = chatAuthMiddleware(AUTH_SECRET);
  });

  // -----------------------------------------------------------------------
  // Token parsing
  // -----------------------------------------------------------------------
  describe('token parsing', () => {
    it('accepts valid Bearer token in Authorization header', async () => {
      const token = generateTestToken('user-1');
      const req = makeReq({
        headers: { authorization: `Bearer ${token}` },
      });
      const res = makeRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect((req as unknown as { userId: string }).userId).toBe('user-1');
    });

    it('accepts valid token as query parameter', async () => {
      const token = generateTestToken('user-2');
      const req = makeReq({
        query: { token },
      });
      const res = makeRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect((req as unknown as { userId: string }).userId).toBe('user-2');
    });

    it('rejects request with no token', async () => {
      const req = makeReq();
      const res = makeRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
    });

    it('rejects non-ll5 Bearer token', async () => {
      const req = makeReq({
        headers: { authorization: 'Bearer some-other-token' },
      });
      const res = makeRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
    });

    it('rejects token with wrong format (wrong number of parts)', async () => {
      const req = makeReq({
        headers: { authorization: 'Bearer ll5.onlyonepart' },
      });
      const res = makeRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
    });
  });

  // -----------------------------------------------------------------------
  // Signature validation
  // -----------------------------------------------------------------------
  describe('signature validation', () => {
    it('rejects token with wrong signature', async () => {
      const token = generateTestToken('user-1');
      // Tamper with the signature (replace last char)
      const parts = token.split('.');
      const lastChar = parts[2].slice(-1);
      parts[2] = parts[2].slice(0, -1) + (lastChar === 'a' ? 'b' : 'a');
      const tamperedToken = parts.join('.');

      const req = makeReq({
        headers: { authorization: `Bearer ${tamperedToken}` },
      });
      const res = makeRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
    });

    it('rejects token with wrong signature length', async () => {
      const payload = Buffer.from(JSON.stringify({
        uid: 'user-1', role: 'user', iat: 0, exp: 99999999999,
      })).toString('base64url');

      const req = makeReq({
        headers: { authorization: `Bearer ll5.${payload}.tooshort` },
      });
      const res = makeRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
    });
  });

  // -----------------------------------------------------------------------
  // Token expiry
  // -----------------------------------------------------------------------
  describe('token expiry', () => {
    it('rejects expired token', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = generateTestToken('user-1', 30, {
        iat: now - 86400 * 60,
        exp: now - 86400, // expired 1 day ago
      });
      const req = makeReq({
        headers: { authorization: `Bearer ${token}` },
      });
      const res = makeRes();
      const next = vi.fn();

      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(401);
      expect((res._json as { error: string }).error).toBe('token_expired');
    });
  });
});

// ---------------------------------------------------------------------------
// createChatRouter — endpoint logic
// ---------------------------------------------------------------------------

describe('createChatRouter', () => {
  let pool: Pool;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // POST /chat/messages — message creation
  // -----------------------------------------------------------------------
  describe('POST /messages', () => {
    it('rejects missing required fields', async () => {
      pool = makePgPool();
      const router = createChatRouter(pool, AUTH_SECRET);

      // Find the POST /messages handler
      const route = router.stack.find(
        (layer: { route?: { path: string; methods: { post?: boolean } } }) =>
          layer.route?.path === '/messages' && layer.route?.methods.post,
      );
      expect(route).toBeTruthy();

      // Simulate the handler (skip auth — test the handler directly)
      const handlers = route.route.stack
        .map((s: { handle: Function }) => s.handle)
        .filter((h: Function) => h.length <= 3); // non-auth handlers

      const req = makeReq({
        body: { channel: 'web' /* missing content */ },
      }) as unknown as Request & { userId: string };
      req.userId = 'user-1';
      const res = makeRes();

      // Call the POST handler (last non-auth handler)
      const handler = handlers[handlers.length - 1];
      await handler(req, res);

      expect(res._status).toBe(400);
      expect((res._json as { error: string }).error).toMatch(/Missing required field/);
    });

    it('rejects invalid channel', async () => {
      pool = makePgPool();
      const router = createChatRouter(pool, AUTH_SECRET);

      const route = router.stack.find(
        (layer: { route?: { path: string; methods: { post?: boolean } } }) =>
          layer.route?.path === '/messages' && layer.route?.methods.post,
      );

      const handlers = route.route.stack
        .map((s: { handle: Function }) => s.handle)
        .filter((h: Function) => h.length <= 3);

      const req = makeReq({
        body: { channel: 'smoke_signal', content: 'hello' },
      }) as unknown as Request & { userId: string };
      req.userId = 'user-1';
      const res = makeRes();

      const handler = handlers[handlers.length - 1];
      await handler(req, res);

      expect(res._status).toBe(400);
      expect((res._json as { error: string }).error).toContain('Invalid channel');
    });

    it('creates message successfully with valid inputs', async () => {
      pool = makePgPool({
        rows: [{ id: 'msg-123', conversation_id: 'conv-456' }],
      });
      const router = createChatRouter(pool, AUTH_SECRET);

      const route = router.stack.find(
        (layer: { route?: { path: string; methods: { post?: boolean } } }) =>
          layer.route?.path === '/messages' && layer.route?.methods.post,
      );

      const handlers = route.route.stack
        .map((s: { handle: Function }) => s.handle)
        .filter((h: Function) => h.length <= 3);

      const req = makeReq({
        body: { channel: 'web', content: 'Hello from test' },
      }) as unknown as Request & { userId: string };
      req.userId = 'user-1';
      const res = makeRes();

      const handler = handlers[handlers.length - 1];
      await handler(req, res);

      expect(res._status).toBe(201);
      expect((res._json as { id: string }).id).toBe('msg-123');
      expect((res._json as { conversation_id: string }).conversation_id).toBe('conv-456');

      // Verify PG query was called
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO chat_messages'),
        expect.arrayContaining(['user-1', null, 'web', 'inbound', 'user', 'Hello from test']),
      );
    });

    it('sets direction=outbound and status=delivered for outbound messages', async () => {
      pool = makePgPool({
        rows: [{ id: 'msg-out', conversation_id: 'conv-out' }],
      });
      const router = createChatRouter(pool, AUTH_SECRET);

      const route = router.stack.find(
        (layer: { route?: { path: string; methods: { post?: boolean } } }) =>
          layer.route?.path === '/messages' && layer.route?.methods.post,
      );

      const handlers = route.route.stack
        .map((s: { handle: Function }) => s.handle)
        .filter((h: Function) => h.length <= 3);

      const req = makeReq({
        body: { channel: 'web', content: 'Response', direction: 'outbound', role: 'assistant' },
      }) as unknown as Request & { userId: string };
      req.userId = 'user-1';
      const res = makeRes();

      const handler = handlers[handlers.length - 1];
      await handler(req, res);

      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO chat_messages'),
        expect.arrayContaining(['outbound', 'assistant', 'Response', 'delivered']),
      );
    });

    it('accepts all valid channel types', async () => {
      const validChannels = ['web', 'telegram', 'whatsapp', 'cli', 'android', 'system'];
      pool = makePgPool({ rows: [{ id: 'msg-1', conversation_id: 'conv-1' }] });
      const router = createChatRouter(pool, AUTH_SECRET);

      const route = router.stack.find(
        (layer: { route?: { path: string; methods: { post?: boolean } } }) =>
          layer.route?.path === '/messages' && layer.route?.methods.post,
      );
      const handlers = route.route.stack
        .map((s: { handle: Function }) => s.handle)
        .filter((h: Function) => h.length <= 3);

      for (const channel of validChannels) {
        const req = makeReq({
          body: { channel, content: 'test' },
        }) as unknown as Request & { userId: string };
        req.userId = 'user-1';
        const res = makeRes();

        const handler = handlers[handlers.length - 1];
        await handler(req, res);

        expect(res._status).toBe(201);
      }
    });
  });

  // -----------------------------------------------------------------------
  // GET /chat/messages — latest-N query logic
  // -----------------------------------------------------------------------
  describe('GET /messages', () => {
    it('queries with user_id filter and default limit', async () => {
      pool = makePgPool({ rows: [{ count: '5' }] });
      // The GET handler does two queries: COUNT then SELECT
      vi.mocked(pool.query)
        .mockResolvedValueOnce({ rows: [{ count: '5' }] } as never)
        .mockResolvedValueOnce({ rows: [{ id: 'msg-1', content: 'hi' }] } as never);

      const router = createChatRouter(pool, AUTH_SECRET);

      const route = router.stack.find(
        (layer: { route?: { path: string; methods: { get?: boolean } } }) =>
          layer.route?.path === '/messages' && layer.route?.methods.get,
      );

      const handlers = route.route.stack
        .map((s: { handle: Function }) => s.handle)
        .filter((h: Function) => h.length <= 3);

      const req = makeReq({
        query: {},
      }) as unknown as Request & { userId: string };
      req.userId = 'user-1';
      const res = makeRes();

      const handler = handlers[handlers.length - 1];
      await handler(req, res);

      expect(res._status).toBe(200);
      const json = res._json as { messages: unknown[]; total: number };
      expect(json.total).toBe(5);
      expect(json.messages).toHaveLength(1);
    });

    it('applies conversation_id and channel filters', async () => {
      vi.mocked(pool.query)
        .mockResolvedValueOnce({ rows: [{ count: '0' }] } as never)
        .mockResolvedValueOnce({ rows: [] } as never);

      const router = createChatRouter(pool, AUTH_SECRET);

      const route = router.stack.find(
        (layer: { route?: { path: string; methods: { get?: boolean } } }) =>
          layer.route?.path === '/messages' && layer.route?.methods.get,
      );

      const handlers = route.route.stack
        .map((s: { handle: Function }) => s.handle)
        .filter((h: Function) => h.length <= 3);

      const req = makeReq({
        query: { conversation_id: 'conv-1', channel: 'web' },
      }) as unknown as Request & { userId: string };
      req.userId = 'user-1';
      const res = makeRes();

      const handler = handlers[handlers.length - 1];
      await handler(req, res);

      // Check that the query includes conversation_id and channel params
      const calls = vi.mocked(pool.query).mock.calls;
      const countParams = calls[0][1] as unknown[];
      expect(countParams).toContain('user-1');
      expect(countParams).toContain('conv-1');
      expect(countParams).toContain('web');
    });

    it('respects limit parameter capped at 500', async () => {
      vi.mocked(pool.query)
        .mockResolvedValueOnce({ rows: [{ count: '0' }] } as never)
        .mockResolvedValueOnce({ rows: [] } as never);

      const router = createChatRouter(pool, AUTH_SECRET);

      const route = router.stack.find(
        (layer: { route?: { path: string; methods: { get?: boolean } } }) =>
          layer.route?.path === '/messages' && layer.route?.methods.get,
      );

      const handlers = route.route.stack
        .map((s: { handle: Function }) => s.handle)
        .filter((h: Function) => h.length <= 3);

      const req = makeReq({
        query: { limit: '9999' },
      }) as unknown as Request & { userId: string };
      req.userId = 'user-1';
      const res = makeRes();

      const handler = handlers[handlers.length - 1];
      await handler(req, res);

      // The second query should use 500 as the limit
      const selectParams = vi.mocked(pool.query).mock.calls[1][1] as unknown[];
      expect(selectParams[selectParams.length - 1]).toBe(500);
    });
  });

  // -----------------------------------------------------------------------
  // PATCH /chat/messages/:id — status update
  // -----------------------------------------------------------------------
  describe('PATCH /messages/:id', () => {
    it('rejects invalid status', async () => {
      pool = makePgPool();
      const router = createChatRouter(pool, AUTH_SECRET);

      const route = router.stack.find(
        (layer: { route?: { path: string; methods: { patch?: boolean } } }) =>
          layer.route?.path === '/messages/:id' && layer.route?.methods.patch,
      );

      const handlers = route.route.stack
        .map((s: { handle: Function }) => s.handle)
        .filter((h: Function) => h.length <= 3);

      const req = makeReq({
        params: { id: 'msg-1' },
        body: { status: 'invalid_status' },
      }) as unknown as Request & { userId: string };
      req.userId = 'user-1';
      const res = makeRes();

      const handler = handlers[handlers.length - 1];
      await handler(req, res);

      expect(res._status).toBe(400);
      expect((res._json as { error: string }).error).toContain('Invalid status');
    });

    it('accepts valid status values', async () => {
      const validStatuses = ['pending', 'processing', 'delivered', 'failed'];

      for (const status of validStatuses) {
        pool = makePgPool({
          rows: [{ id: 'msg-1', status }],
        });
        const router = createChatRouter(pool, AUTH_SECRET);

        const route = router.stack.find(
          (layer: { route?: { path: string; methods: { patch?: boolean } } }) =>
            layer.route?.path === '/messages/:id' && layer.route?.methods.patch,
        );

        const handlers = route.route.stack
          .map((s: { handle: Function }) => s.handle)
          .filter((h: Function) => h.length <= 3);

        const req = makeReq({
          params: { id: 'msg-1' },
          body: { status },
        }) as unknown as Request & { userId: string };
        req.userId = 'user-1';
        const res = makeRes();

        const handler = handlers[handlers.length - 1];
        await handler(req, res);

        expect(res._status).toBe(200);
      }
    });

    it('returns 404 for non-existent message', async () => {
      pool = makePgPool({ rows: [] });
      const router = createChatRouter(pool, AUTH_SECRET);

      const route = router.stack.find(
        (layer: { route?: { path: string; methods: { patch?: boolean } } }) =>
          layer.route?.path === '/messages/:id' && layer.route?.methods.patch,
      );

      const handlers = route.route.stack
        .map((s: { handle: Function }) => s.handle)
        .filter((h: Function) => h.length <= 3);

      const req = makeReq({
        params: { id: 'nonexistent' },
        body: { status: 'delivered' },
      }) as unknown as Request & { userId: string };
      req.userId = 'user-1';
      const res = makeRes();

      const handler = handlers[handlers.length - 1];
      await handler(req, res);

      expect(res._status).toBe(404);
    });
  });
});
