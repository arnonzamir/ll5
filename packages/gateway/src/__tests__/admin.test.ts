import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { createAdminRouter, requireAdmin } from '../admin.js';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Mock bcryptjs — avoid slow hashing in tests
// ---------------------------------------------------------------------------
vi.mock('bcryptjs', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('$2a$12$mockhash'),
    compare: vi.fn().mockResolvedValue(true),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AUTH_SECRET = 'test-admin-secret-key-for-testing';

/** Generate a valid ll5 token for testing. */
function generateTestToken(
  userId: string,
  role = 'admin',
  ttlDays = 30,
  overrides: Partial<{ iat: number; exp: number }> = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    uid: userId,
    role,
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

function makePgPool(
  queryResult: { rows: Record<string, unknown>[]; rowCount?: number } = { rows: [] },
): Pool {
  return {
    query: vi.fn().mockResolvedValue(queryResult),
  } as unknown as Pool;
}

/** Find a route handler on the router, skipping the admin middleware. */
function findHandler(
  router: ReturnType<typeof createAdminRouter>,
  method: string,
  path: string,
): Function | null {
  const layer = router.stack.find(
    (l: { route?: { path: string; methods: Record<string, boolean> } }) =>
      l.route?.path === path && l.route?.methods[method],
  );
  if (!layer) return null;

  // Get all non-middleware handlers (skip the admin auth middleware)
  const handlers = layer.route.stack
    .map((s: { handle: Function }) => s.handle)
    .filter((h: Function) => h.length <= 3); // non-error handlers

  return handlers[handlers.length - 1] ?? null;
}

// ---------------------------------------------------------------------------
// requireAdmin middleware
// ---------------------------------------------------------------------------

describe('requireAdmin', () => {
  let middleware: ReturnType<typeof requireAdmin>;

  beforeEach(() => {
    middleware = requireAdmin(AUTH_SECRET);
  });

  it('rejects requests with no token (401)', () => {
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
  });

  it('rejects non-admin tokens (403)', () => {
    const token = generateTestToken('user-1', 'user');
    const req = makeReq({
      headers: { authorization: `Bearer ${token}` },
    });
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    expect((res._json as { error: string }).error).toBe('Admin access required');
  });

  it('accepts admin tokens and calls next()', () => {
    const token = generateTestToken('admin-1', 'admin');
    const req = makeReq({
      headers: { authorization: `Bearer ${token}` },
    });
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect((req as unknown as { adminUserId: string }).adminUserId).toBe('admin-1');
  });

  it('accepts token via query parameter', () => {
    const token = generateTestToken('admin-1', 'admin');
    const req = makeReq({
      query: { token },
    });
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('rejects expired token (401)', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = generateTestToken('admin-1', 'admin', 30, {
      iat: now - 86400 * 60,
      exp: now - 86400, // expired
    });
    const req = makeReq({
      headers: { authorization: `Bearer ${token}` },
    });
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
    expect((res._json as { error: string }).error).toBe('token_expired');
  });

  it('rejects tampered signature (401)', () => {
    const token = generateTestToken('admin-1', 'admin');
    const parts = token.split('.');
    const lastChar = parts[2].slice(-1);
    parts[2] = parts[2].slice(0, -1) + (lastChar === 'a' ? 'b' : 'a');
    const tampered = parts.join('.');

    const req = makeReq({
      headers: { authorization: `Bearer ${tampered}` },
    });
    const res = makeRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Admin CRUD endpoints (tested by calling route handlers directly)
// ---------------------------------------------------------------------------

describe('createAdminRouter', () => {
  let pool: Pool;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // POST /users — user creation
  // -----------------------------------------------------------------------
  describe('POST /users', () => {
    it('rejects missing required fields', async () => {
      pool = makePgPool();
      const router = createAdminRouter(pool, AUTH_SECRET);
      const handler = findHandler(router, 'post', '/users');
      expect(handler).toBeTruthy();

      const req = makeReq({
        body: { username: 'test' /* missing display_name and pin */ },
      });
      const res = makeRes();

      await handler!(req, res);

      expect(res._status).toBe(400);
      expect((res._json as { error: string }).error).toContain('required');
    });

    it('creates user with UUID and hashed PIN', async () => {
      const mockQuery = vi.fn()
        // First call: check duplicate username
        .mockResolvedValueOnce({ rows: [] })
        // Second call: INSERT user
        .mockResolvedValueOnce({
          rows: [{
            user_id: 'generated-uuid',
            username: 'testuser',
            display_name: 'Test User',
            role: 'user',
            enabled: true,
          }],
        })
        // Third call: INSERT user_settings (onboarding)
        .mockResolvedValueOnce({ rows: [] });

      pool = { query: mockQuery } as unknown as Pool;
      const router = createAdminRouter(pool, AUTH_SECRET);
      const handler = findHandler(router, 'post', '/users');

      const req = makeReq({
        body: { username: 'testuser', display_name: 'Test User', pin: '987654' },
      });
      const res = makeRes();

      await handler!(req, res);

      expect(res._status).toBe(201);

      // Verify INSERT was called with UUID, username, display_name, hashed pin, role
      const insertCall = mockQuery.mock.calls[1];
      const insertParams = insertCall[1] as unknown[];
      // First param is UUID (should be valid format)
      expect(insertParams[0]).toMatch(/^[0-9a-f-]{36}$/);
      // Second param is username
      expect(insertParams[1]).toBe('testuser');
      // Third param is display_name
      expect(insertParams[2]).toBe('Test User');
      // Fourth param is the bcrypt hash (mocked)
      expect(insertParams[3]).toBe('$2a$12$mockhash');
      // Fifth param is role
      expect(insertParams[4]).toBe('user');
    });

    it('rejects duplicate username', async () => {
      const mockQuery = vi.fn()
        .mockResolvedValueOnce({ rows: [{ user_id: 'existing-id' }] }); // duplicate found

      pool = { query: mockQuery } as unknown as Pool;
      const router = createAdminRouter(pool, AUTH_SECRET);
      const handler = findHandler(router, 'post', '/users');

      const req = makeReq({
        body: { username: 'taken', display_name: 'Test', pin: '987654' },
      });
      const res = makeRes();

      await handler!(req, res);

      expect(res._status).toBe(409);
      expect((res._json as { error: string }).error).toContain('already taken');
    });
  });

  // -----------------------------------------------------------------------
  // PIN validation
  // -----------------------------------------------------------------------
  describe('PIN validation', () => {
    it('rejects PIN shorter than 6 characters', async () => {
      pool = makePgPool();
      const router = createAdminRouter(pool, AUTH_SECRET);
      const handler = findHandler(router, 'post', '/users');

      const req = makeReq({
        body: { username: 'test', display_name: 'Test', pin: '123' },
      });
      const res = makeRes();

      await handler!(req, res);

      expect(res._status).toBe(400);
      expect((res._json as { error: string }).error).toContain('at least 6');
    });

    it('rejects common blocked PINs', async () => {
      pool = makePgPool();
      const router = createAdminRouter(pool, AUTH_SECRET);
      const handler = findHandler(router, 'post', '/users');

      const blockedPins = ['123456', '654321', '111111', '000000'];
      for (const pin of blockedPins) {
        const req = makeReq({
          body: { username: 'test', display_name: 'Test', pin },
        });
        const res = makeRes();

        await handler!(req, res);

        expect(res._status).toBe(400);
        expect((res._json as { error: string }).error).toContain('too common');
      }
    });

    it('accepts valid PIN', async () => {
      const mockQuery = vi.fn()
        .mockResolvedValueOnce({ rows: [] }) // no duplicate
        .mockResolvedValueOnce({ rows: [{ user_id: 'new-id', username: 'test' }] }) // insert
        .mockResolvedValueOnce({ rows: [] }); // user_settings

      pool = { query: mockQuery } as unknown as Pool;
      const router = createAdminRouter(pool, AUTH_SECRET);
      const handler = findHandler(router, 'post', '/users');

      const req = makeReq({
        body: { username: 'test', display_name: 'Test', pin: '987654' },
      });
      const res = makeRes();

      await handler!(req, res);

      expect(res._status).toBe(201);
    });

    it('rejects weak PIN on pin reset endpoint', async () => {
      pool = makePgPool();
      const router = createAdminRouter(pool, AUTH_SECRET);
      const handler = findHandler(router, 'post', '/users/:id/pin');

      const req = makeReq({
        params: { id: 'user-1' },
        body: { pin: '1234' },
      });
      const res = makeRes();

      await handler!(req, res);

      expect(res._status).toBe(400);
    });
  });

  // -----------------------------------------------------------------------
  // GET /users — user listing
  // -----------------------------------------------------------------------
  describe('GET /users', () => {
    it('returns users without pin_hash', async () => {
      pool = makePgPool({
        rows: [
          {
            user_id: 'user-1',
            username: 'alice',
            display_name: 'Alice',
            role: 'admin',
            enabled: true,
            created_at: '2026-01-01',
            updated_at: '2026-01-01',
          },
          {
            user_id: 'user-2',
            username: 'bob',
            display_name: 'Bob',
            role: 'user',
            enabled: true,
            created_at: '2026-01-02',
            updated_at: '2026-01-02',
          },
        ],
      });
      const router = createAdminRouter(pool, AUTH_SECRET);
      const handler = findHandler(router, 'get', '/users');

      const req = makeReq();
      const res = makeRes();

      await handler!(req, res);

      expect(res._status).toBe(200);
      const json = res._json as { users: Record<string, unknown>[] };
      expect(json.users).toHaveLength(2);
      expect(json.users[0].user_id).toBe('user-1');
      expect(json.users[0].username).toBe('alice');
      // The SELECT query explicitly excludes pin_hash via USER_SELECT_FIELDS
      // Verify the query string used in pool.query
      const queryStr = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(queryStr).toContain('user_id');
      expect(queryStr).toContain('username');
      expect(queryStr).not.toContain('pin_hash');
    });
  });

  // -----------------------------------------------------------------------
  // DELETE /users/:id — soft delete
  // -----------------------------------------------------------------------
  describe('DELETE /users/:id', () => {
    it('sets enabled=false (soft delete)', async () => {
      pool = makePgPool({ rows: [{ user_id: 'user-1' }] });
      const router = createAdminRouter(pool, AUTH_SECRET);
      const handler = findHandler(router, 'delete', '/users/:id');

      const req = makeReq({ params: { id: 'user-1' } });
      const res = makeRes();

      await handler!(req, res);

      expect(res._status).toBe(200);
      expect((res._json as { deleted: boolean }).deleted).toBe(true);

      // Verify UPDATE query sets enabled = false
      const queryStr = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(queryStr).toContain('enabled = false');
    });

    it('returns 404 for non-existent user', async () => {
      pool = makePgPool({ rows: [] });
      const router = createAdminRouter(pool, AUTH_SECRET);
      const handler = findHandler(router, 'delete', '/users/:id');

      const req = makeReq({ params: { id: 'nonexistent' } });
      const res = makeRes();

      await handler!(req, res);

      expect(res._status).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // POST /users/:id/pin — PIN reset
  // -----------------------------------------------------------------------
  describe('POST /users/:id/pin', () => {
    it('resets PIN successfully', async () => {
      pool = makePgPool({ rows: [{ user_id: 'user-1' }] });
      const router = createAdminRouter(pool, AUTH_SECRET);
      const handler = findHandler(router, 'post', '/users/:id/pin');

      const req = makeReq({
        params: { id: 'user-1' },
        body: { pin: '998877' },
      });
      const res = makeRes();

      await handler!(req, res);

      expect(res._status).toBe(200);
      expect((res._json as { updated: boolean }).updated).toBe(true);

      // Verify hashed PIN was passed to query
      const queryParams = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
      expect(queryParams[0]).toBe('$2a$12$mockhash');
    });

    it('rejects missing PIN', async () => {
      pool = makePgPool();
      const router = createAdminRouter(pool, AUTH_SECRET);
      const handler = findHandler(router, 'post', '/users/:id/pin');

      const req = makeReq({
        params: { id: 'user-1' },
        body: {},
      });
      const res = makeRes();

      await handler!(req, res);

      expect(res._status).toBe(400);
      expect((res._json as { error: string }).error).toContain('required');
    });
  });

  // -----------------------------------------------------------------------
  // PATCH /users/:id — update user
  // -----------------------------------------------------------------------
  describe('PATCH /users/:id', () => {
    it('rejects when no fields provided', async () => {
      pool = makePgPool();
      const router = createAdminRouter(pool, AUTH_SECRET);
      const handler = findHandler(router, 'patch', '/users/:id');

      const req = makeReq({ params: { id: 'user-1' }, body: {} });
      const res = makeRes();

      await handler!(req, res);

      expect(res._status).toBe(400);
      expect((res._json as { error: string }).error).toContain('No fields');
    });

    it('rejects invalid role', async () => {
      pool = makePgPool();
      const router = createAdminRouter(pool, AUTH_SECRET);
      const handler = findHandler(router, 'patch', '/users/:id');

      const req = makeReq({
        params: { id: 'user-1' },
        body: { role: 'superadmin' },
      });
      const res = makeRes();

      await handler!(req, res);

      expect(res._status).toBe(400);
      expect((res._json as { error: string }).error).toContain('Invalid role');
    });

    it('updates user fields', async () => {
      pool = makePgPool({
        rows: [{
          user_id: 'user-1',
          username: 'updated',
          display_name: 'Updated User',
          role: 'admin',
          enabled: true,
        }],
      });
      const router = createAdminRouter(pool, AUTH_SECRET);
      const handler = findHandler(router, 'patch', '/users/:id');

      const req = makeReq({
        params: { id: 'user-1' },
        body: { display_name: 'Updated User' },
      });
      const res = makeRes();

      await handler!(req, res);

      expect(res._status).toBe(200);
      const json = res._json as Record<string, unknown>;
      expect(json.display_name).toBe('Updated User');
    });
  });

  // -----------------------------------------------------------------------
  // Role validation in user creation
  // -----------------------------------------------------------------------
  describe('role validation', () => {
    it('rejects invalid role on creation', async () => {
      pool = makePgPool();
      const router = createAdminRouter(pool, AUTH_SECRET);
      const handler = findHandler(router, 'post', '/users');

      const req = makeReq({
        body: { username: 'test', display_name: 'Test', pin: '987654', role: 'superadmin' },
      });
      const res = makeRes();

      await handler!(req, res);

      expect(res._status).toBe(400);
      expect((res._json as { error: string }).error).toContain('Invalid role');
    });

    it('accepts valid roles (user, admin, child)', async () => {
      const validRoles = ['user', 'admin', 'child'];
      for (const role of validRoles) {
        const mockQuery = vi.fn()
          .mockResolvedValueOnce({ rows: [] }) // no duplicate
          .mockResolvedValueOnce({ rows: [{ user_id: 'new', username: 'test', role }] })
          .mockResolvedValueOnce({ rows: [] }); // user_settings

        pool = { query: mockQuery } as unknown as Pool;
        const router = createAdminRouter(pool, AUTH_SECRET);
        const handler = findHandler(router, 'post', '/users');

        const req = makeReq({
          body: { username: `test-${role}`, display_name: 'Test', pin: '987654', role },
        });
        const res = makeRes();

        await handler!(req, res);

        expect(res._status).toBe(201);
      }
    });
  });
});
