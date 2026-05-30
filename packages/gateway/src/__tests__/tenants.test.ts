import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { createTenantsRouter } from '../tenants.js';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';

const AUTH_SECRET = 'test-tenant-secret-key-for-testing';

function generateTestToken(userId: string, role = 'superadmin', ttlDays = 30): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = { uid: userId, role, iat: now, exp: now + ttlDays * 86400 };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', AUTH_SECRET)
    .update(payloadB64)
    .digest('hex')
    .slice(0, 32);
  return `ll5.${payloadB64}.${signature}`;
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, query: {}, body: {}, params: {}, ...overrides } as unknown as Request;
}

function makeRes(): Response & { _status: number; _json: unknown } {
  const res = {
    _status: 200,
    _json: null as unknown,
    status(code: number) { this._status = code; return this; },
    json(data: unknown) { this._json = data; return this; },
  } as unknown as Response & { _status: number; _json: unknown };
  return res;
}

function makePgPool(queryResult: { rows: Record<string, unknown>[] } = { rows: [] }): Pool {
  return { query: vi.fn().mockResolvedValue(queryResult) } as unknown as Pool;
}

/** Find the LAST handler on a route (the real handler, after middleware). */
function findHandler(
  router: ReturnType<typeof createTenantsRouter>,
  method: string,
  path: string,
): Function | null {
  const layer = router.stack.find(
    (l: { route?: { path: string; methods: Record<string, boolean> } }) =>
      l.route?.path === path && l.route?.methods[method],
  );
  if (!layer) return null;
  const handlers = layer.route.stack
    .map((s: { handle: Function }) => s.handle)
    .filter((h: Function) => h.length <= 3);
  return handlers[handlers.length - 1] ?? null;
}

/** Find the FIRST handler (the superadmin middleware) on a route. */
function findMiddleware(
  router: ReturnType<typeof createTenantsRouter>,
  method: string,
  path: string,
): Function | null {
  const layer = router.stack.find(
    (l: { route?: { path: string; methods: Record<string, boolean> } }) =>
      l.route?.path === path && l.route?.methods[method],
  );
  if (!layer) return null;
  return layer.route.stack[0]?.handle ?? null;
}

const ENRICHED_ROW = {
  user_id: 'tenant-1',
  email: 'a@example.com',
  username: 'alice',
  display_name: 'Alice',
  role: 'user',
  enabled: true,
  created_at: '2026-01-01T00:00:00Z',
  onboarding: { completed: false, steps: { profile: true } },
  chan_google: true,
  chan_whatsapp: false,
  chan_health: true,
  last_active_at: '2026-05-01T00:00:00Z',
};

describe('createTenantsRouter — superadmin gating', () => {
  beforeEach(() => vi.clearAllMocks());

  it('allows a superadmin through to GET /admin/tenants', () => {
    const router = createTenantsRouter(makePgPool(), AUTH_SECRET);
    const mw = findMiddleware(router, 'get', '/admin/tenants');
    const req = makeReq({ headers: { authorization: `Bearer ${generateTestToken('s1', 'superadmin')}` } });
    const res = makeRes();
    const next = vi.fn();

    mw!(req, res, next);

    expect(next).toHaveBeenCalled();
    expect((req as unknown as { adminRole: string }).adminRole).toBe('superadmin');
  });

  it('403s a plain admin on GET /admin/tenants', () => {
    const router = createTenantsRouter(makePgPool(), AUTH_SECRET);
    const mw = findMiddleware(router, 'get', '/admin/tenants');
    const req = makeReq({ headers: { authorization: `Bearer ${generateTestToken('a1', 'admin')}` } });
    const res = makeRes();
    const next = vi.fn();

    mw!(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
  });

  it('403s a regular user on GET /admin/tenants/:id', () => {
    const router = createTenantsRouter(makePgPool(), AUTH_SECRET);
    const mw = findMiddleware(router, 'get', '/admin/tenants/:id');
    const req = makeReq({ headers: { authorization: `Bearer ${generateTestToken('u1', 'user')}` } });
    const res = makeRes();
    const next = vi.fn();

    mw!(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
  });
});

describe('GET /admin/tenants — enriched list', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the enriched console shape with derived onboarding + channels', async () => {
    const pool = makePgPool({ rows: [ENRICHED_ROW] });
    const router = createTenantsRouter(pool, AUTH_SECRET);
    const handler = findHandler(router, 'get', '/admin/tenants');

    const res = makeRes();
    await handler!(makeReq(), res);

    expect(res._status).toBe(200);
    const { tenants } = res._json as { tenants: Record<string, unknown>[] };
    expect(tenants).toHaveLength(1);
    const t = tenants[0];
    expect(t).toMatchObject({
      user_id: 'tenant-1',
      email: 'a@example.com',
      username: 'alice',
      display_name: 'Alice',
      role: 'user',
      enabled: true,
      created_at: '2026-01-01T00:00:00Z',
      last_active_at: '2026-05-01T00:00:00Z',
    });
    expect(t.onboarding).toEqual({ completed: false, steps: { profile: true } });
    expect(t.channels).toEqual({ google: true, whatsapp: false, health: true });
  });

  it('never leaks secrets/hashes in the response', async () => {
    const pool = makePgPool({ rows: [ENRICHED_ROW] });
    const router = createTenantsRouter(pool, AUTH_SECRET);
    const handler = findHandler(router, 'get', '/admin/tenants');

    const res = makeRes();
    await handler!(makeReq(), res);

    const serialized = JSON.stringify(res._json);
    expect(serialized).not.toMatch(/pin_hash|password_hash|ciphertext|api_key|token_hash/i);

    // The SELECT must not reference any secret column either.
    const sql = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).not.toMatch(/pin_hash|password_hash|ciphertext|api_key|token_hash/i);
  });

  it('derives channels=false and onboarding defaults when rows are empty/null', async () => {
    const pool = makePgPool({
      rows: [{
        user_id: 'tenant-2',
        email: null,
        username: null,
        display_name: null,
        role: 'user',
        enabled: false,
        created_at: '2026-02-01T00:00:00Z',
        onboarding: null,
        chan_google: false,
        chan_whatsapp: false,
        chan_health: false,
        last_active_at: null,
      }],
    });
    const router = createTenantsRouter(pool, AUTH_SECRET);
    const handler = findHandler(router, 'get', '/admin/tenants');

    const res = makeRes();
    await handler!(makeReq(), res);

    const { tenants } = res._json as { tenants: Record<string, unknown>[] };
    expect(tenants[0].onboarding).toEqual({ completed: false, steps: {} });
    expect(tenants[0].channels).toEqual({ google: false, whatsapp: false, health: false });
    expect(tenants[0].last_active_at).toBeNull();
  });

  it('only counts a connected WhatsApp account (status filter in SQL)', async () => {
    const pool = makePgPool({ rows: [ENRICHED_ROW] });
    const router = createTenantsRouter(pool, AUTH_SECRET);
    const handler = findHandler(router, 'get', '/admin/tenants');

    await handler!(makeReq(), makeRes());

    const sql = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(sql).toMatch(/messaging_whatsapp_accounts[\s\S]*status\s*=\s*'connected'/);
  });
});

describe('GET /admin/tenants/:id', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns one enriched tenant and scopes the query by user_id', async () => {
    const pool = makePgPool({ rows: [ENRICHED_ROW] });
    const router = createTenantsRouter(pool, AUTH_SECRET);
    const handler = findHandler(router, 'get', '/admin/tenants/:id');

    const res = makeRes();
    await handler!(makeReq({ params: { id: 'tenant-1' } }), res);

    expect(res._status).toBe(200);
    const { tenant } = res._json as { tenant: Record<string, unknown> };
    expect(tenant.user_id).toBe('tenant-1');
    expect(tenant.channels).toEqual({ google: true, whatsapp: false, health: true });

    // Scoping: the lookup parameterizes on the requested id.
    const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toMatch(/WHERE\s+au\.user_id\s*=\s*\$1/);
    expect(call[1]).toEqual(['tenant-1']);
  });

  it('404s when the tenant does not exist', async () => {
    const pool = makePgPool({ rows: [] });
    const router = createTenantsRouter(pool, AUTH_SECRET);
    const handler = findHandler(router, 'get', '/admin/tenants/:id');

    const res = makeRes();
    await handler!(makeReq({ params: { id: 'missing' } }), res);

    expect(res._status).toBe(404);
  });
});
