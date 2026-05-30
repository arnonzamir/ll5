import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';

const { createInvitesRouter } = await import('../invites.js');

const AUTH_SECRET = 'test-secret-key-at-least-32-characters-long!!';
const DASHBOARD_URL = 'https://dash.example';

/** Generate a valid admin ll5 token. */
function adminToken(userId = 'admin-1', role = 'admin'): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = { uid: userId, role, iat: now, exp: now + 30 * 86400 };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', AUTH_SECRET).update(payloadB64).digest('hex').slice(0, 32);
  return `ll5.${payloadB64}.${signature}`;
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, query: {}, body: {}, params: {}, ...overrides } as unknown as Request;
}

function makeRes(): Response & { _status: number; _json: unknown } {
  const res: any = {
    _status: 200,
    _json: null,
    status(code: number) { this._status = code; return this; },
    json(data: unknown) { this._json = data; return this; },
  };
  return res;
}

/** Find a route handler (the last non-middleware handler in the layer). */
function getHandler(router: ReturnType<typeof createInvitesRouter>, method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === path && l.route?.methods[method],
  );
  if (!layer) throw new Error(`route not found: ${method} ${path}`);
  const handlers = layer.route.stack.map((s: any) => s.handle);
  return handlers[handlers.length - 1] as (req: Request, res: Response) => Promise<unknown>;
}

/** The handler WITH its admin middleware chain (for auth-gated routes). */
function getChain(router: ReturnType<typeof createInvitesRouter>, method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === path && l.route?.methods[method],
  );
  if (!layer) throw new Error(`route not found: ${method} ${path}`);
  const handlers = layer.route.stack.map((s: any) => s.handle);
  return async (req: Request, res: Response) => {
    for (let i = 0; i < handlers.length; i++) {
      let advanced = false;
      const next = () => { advanced = true; };
      await handlers[i](req, res, next);
      if (!advanced) return; // middleware short-circuited (e.g. 401/403)
    }
  };
}

function sha256(s: string) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function makePool(handlers: Array<(sql: string, params: unknown[]) => { rows: unknown[] } | undefined>): {
  pool: Pool;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    for (const h of handlers) {
      const out = h(sql, params);
      if (out) return out;
    }
    return { rows: [] };
  });
  return { pool: { query } as unknown as Pool, query };
}

/**
 * Pool for the transactional accept path: query() handles BEGIN/COMMIT/ROLLBACK
 * and connect() returns a client backed by the same dispatch table.
 */
function makeTxPool(handlers: Array<(sql: string, params: unknown[]) => { rows: unknown[] } | undefined>): {
  pool: Pool;
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(sql)) return { rows: [] };
    for (const h of handlers) {
      const out = h(sql, params);
      if (out) return out;
    }
    return { rows: [] };
  });
  const release = vi.fn();
  const client = { query, release };
  const pool = { connect: vi.fn().mockResolvedValue(client), query } as unknown as Pool;
  return { pool, query, release };
}

describe('admin invites — create / list / revoke', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects non-admin token with 403 on POST /admin/invites', async () => {
    const { pool } = makePool([]);
    const router = createInvitesRouter(pool, AUTH_SECRET, DASHBOARD_URL);
    const chain = getChain(router, 'post', '/admin/invites');

    const res = makeRes();
    await chain(makeReq({
      headers: { authorization: `Bearer ${adminToken('u', 'user')}` },
      body: { email: 'x@y.com' },
    }), res);

    expect(res._status).toBe(403);
  });

  it('creates an invite and returns accept_url (no token_hash leaked)', async () => {
    const inserted: unknown[][] = [];
    const { pool } = makePool([
      (sql, params) => {
        if (sql.includes('INSERT INTO invites')) {
          inserted.push(params);
          return { rows: [{ id: 'inv-1', email: 'x@y.com', role: 'user', expires_at: '2026-06-06T00:00:00Z' }] };
        }
        return undefined;
      },
    ]);
    const router = createInvitesRouter(pool, AUTH_SECRET, DASHBOARD_URL);
    const handler = getHandler(router, 'post', '/admin/invites');

    const res = makeRes();
    await handler(makeReq({
      headers: { authorization: `Bearer ${adminToken()}` },
      body: { email: 'x@y.com' },
      // adminUserId is set by requireAdmin; emulate it for the bare handler
      ...({ adminUserId: 'admin-1' } as object),
    }), res);

    expect(res._status).toBe(201);
    const body = res._json as { invite: any; accept_url: string };
    expect(body.invite).toEqual({
      id: 'inv-1', email: 'x@y.com', role: 'user', expires_at: '2026-06-06T00:00:00Z',
    });
    expect(body.accept_url).toMatch(/^https:\/\/dash\.example\/accept-invite\?token=[0-9a-f]{64}$/);
    expect(JSON.stringify(body)).not.toContain('token_hash');
    // invited_by recorded from the admin uid
    expect(inserted[0][2]).toBe('admin-1');
  });

  it('lists invites without token_hash', async () => {
    const { pool } = makePool([
      (sql) => sql.includes('FROM invites') ? { rows: [{ id: 'inv-1', email: 'x@y.com', role: 'user', pending: true }] } : undefined,
    ]);
    const router = createInvitesRouter(pool, AUTH_SECRET, DASHBOARD_URL);
    const handler = getHandler(router, 'get', '/admin/invites');

    const res = makeRes();
    await handler(makeReq({ headers: { authorization: `Bearer ${adminToken()}` } }), res);

    expect(res._status).toBe(200);
    expect(JSON.stringify(res._json)).not.toContain('token_hash');
    expect((res._json as { invites: unknown[] }).invites.length).toBe(1);
  });

  it('revokes (deletes) an invite by id', async () => {
    const { pool, query } = makePool([
      (sql) => sql.includes('DELETE FROM invites') ? { rows: [{ id: 'inv-1' }] } : undefined,
    ]);
    const router = createInvitesRouter(pool, AUTH_SECRET, DASHBOARD_URL);
    const handler = getHandler(router, 'delete', '/admin/invites/:id');

    const res = makeRes();
    await handler(makeReq({ headers: { authorization: `Bearer ${adminToken()}` }, params: { id: 'inv-1' } }), res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ deleted: true });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM invites'), ['inv-1']);
  });

  it('revoke returns 404 when invite missing', async () => {
    const { pool } = makePool([(sql) => sql.includes('DELETE FROM invites') ? { rows: [] } : undefined]);
    const router = createInvitesRouter(pool, AUTH_SECRET, DASHBOARD_URL);
    const handler = getHandler(router, 'delete', '/admin/invites/:id');

    const res = makeRes();
    await handler(makeReq({ headers: { authorization: `Bearer ${adminToken()}` }, params: { id: 'nope' } }), res);
    expect(res._status).toBe(404);
  });
});

describe('public invite validate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns valid:true + email for a good token', async () => {
    const raw = 'good-token';
    const { pool, query } = makePool([
      (sql, params) =>
        sql.includes('FROM invites') && params[0] === sha256(raw)
          ? { rows: [{ email: 'x@y.com' }] }
          : undefined,
    ]);
    const router = createInvitesRouter(pool, AUTH_SECRET, DASHBOARD_URL);
    const handler = getHandler(router, 'get', '/invites/validate');

    const res = makeRes();
    await handler(makeReq({ query: { token: raw } }), res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ valid: true, email: 'x@y.com' });
    // stored & looked up by sha256, never the raw token
    expect(query).toHaveBeenCalledWith(expect.stringContaining('token_hash = $1'), [sha256(raw)]);
  });

  it('returns valid:false for an unknown/expired/accepted token', async () => {
    const { pool } = makePool([(sql) => sql.includes('FROM invites') ? { rows: [] } : undefined]);
    const router = createInvitesRouter(pool, AUTH_SECRET, DASHBOARD_URL);
    const handler = getHandler(router, 'get', '/invites/validate');

    const res = makeRes();
    await handler(makeReq({ query: { token: 'bad' } }), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ valid: false });
  });
});

describe('public invite accept', () => {
  beforeEach(() => vi.clearAllMocks());

  function happyHandlers(opts: { dupUsername?: boolean } = {}) {
    const calls: { sql: string; params: unknown[] }[] = [];
    const handlers = [
      (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes('FROM invites') && sql.includes('FOR UPDATE')) {
          return { rows: [{ id: 'inv-1', email: 'x@y.com', role: 'user' }] };
        }
        if (sql.includes('SELECT user_id FROM auth_users WHERE username')) {
          return { rows: opts.dupUsername ? [{ user_id: 'someone' }] : [] };
        }
        if (sql.includes('INSERT INTO auth_users')) {
          return { rows: [{ token_ttl_days: 7 }] };
        }
        return undefined;
      },
    ];
    return { handlers, calls };
  }

  it('happy path: creates the user (email_verified + onboarding seed) and consumes the invite', async () => {
    const { handlers, calls } = happyHandlers();
    const { pool } = makeTxPool(handlers);
    const router = createInvitesRouter(pool, AUTH_SECRET, DASHBOARD_URL);
    const handler = getHandler(router, 'post', '/invites/accept');

    const res = makeRes();
    await handler(makeReq({ body: { token: 'raw', password: 'password123', display_name: 'X', username: 'newx' } }), res);

    expect(res._status).toBe(201);
    const body = res._json as { token: string; user_id: string };
    expect(body.token.startsWith('ll5.')).toBe(true);
    expect(typeof body.user_id).toBe('string');

    const userInsert = calls.find((c) => c.sql.includes('INSERT INTO auth_users'));
    expect(userInsert).toBeDefined();
    // email_verified=true is hard-coded in the INSERT SQL; email + role threaded through
    expect(userInsert!.sql).toMatch(/email_verified[\s\S]*true/);
    expect(userInsert!.params).toContain('x@y.com'); // email from invite
    expect(userInsert!.params).toContain('user');    // role from invite
    expect(userInsert!.params).toContain('newx');    // username

    // onboarding seed mirrors admin.ts createUser
    const settingsInsert = calls.find((c) => c.sql.includes('INSERT INTO user_settings'));
    expect(settingsInsert).toBeDefined();
    expect(settingsInsert!.params[1]).toContain('"onboarding"');
    expect(settingsInsert!.params[1]).toContain('"completed":false');

    // invite consumed
    const accept = calls.find((c) => c.sql.includes('UPDATE invites SET accepted_at'));
    expect(accept).toBeDefined();
    expect(accept!.params).toEqual(['inv-1']);
  });

  it('rejects an invalid/expired/already-accepted invite with 400 (and does not create a user)', async () => {
    const calls: { sql: string }[] = [];
    const { pool } = makeTxPool([
      (sql) => {
        calls.push({ sql });
        if (sql.includes('FROM invites') && sql.includes('FOR UPDATE')) return { rows: [] };
        return undefined;
      },
    ]);
    const router = createInvitesRouter(pool, AUTH_SECRET, DASHBOARD_URL);
    const handler = getHandler(router, 'post', '/invites/accept');

    const res = makeRes();
    await handler(makeReq({ body: { token: 'bad', password: 'password123' } }), res);

    expect(res._status).toBe(400);
    expect(calls.some((c) => c.sql.includes('INSERT INTO auth_users'))).toBe(false);
  });

  it('rejects a duplicate username with 409 and rolls back (invite untouched)', async () => {
    const { handlers, calls } = happyHandlers({ dupUsername: true });
    const { pool } = makeTxPool(handlers);
    const router = createInvitesRouter(pool, AUTH_SECRET, DASHBOARD_URL);
    const handler = getHandler(router, 'post', '/invites/accept');

    const res = makeRes();
    await handler(makeReq({ body: { token: 'raw', password: 'password123', username: 'taken' } }), res);

    expect(res._status).toBe(409);
    expect(calls.some((c) => c.sql.includes('INSERT INTO auth_users'))).toBe(false);
    expect(calls.some((c) => c.sql.includes('UPDATE invites SET accepted_at'))).toBe(false);
  });

  it('rejects a short password (<8) with 400 before touching the DB', async () => {
    const { pool, query } = makeTxPool([]);
    const router = createInvitesRouter(pool, AUTH_SECRET, DASHBOARD_URL);
    const handler = getHandler(router, 'post', '/invites/accept');

    const res = makeRes();
    await handler(makeReq({ body: { token: 'raw', password: 'short' } }), res);

    expect(res._status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});
