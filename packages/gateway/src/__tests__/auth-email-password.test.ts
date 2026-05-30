import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';

// Use real bcryptjs so compare() reflects actual hash matching — the decoy /
// wrong-password discipline depends on real compare semantics.
const { createAuthRouter } = await import('../auth.js');
const bcrypt = (await import('bcryptjs')).default;

const AUTH_SECRET = 'test-secret-key-at-least-32-characters-long!!';
const DASHBOARD_URL = 'https://dash.example';

// Capture emails sent via the LogEmailSender by spying on the logger.
const { logger } = await import('../utils/logger.js');

function makeReq(body: Record<string, unknown>, query: Record<string, unknown> = {}): Request {
  return { headers: {}, query, body, params: {} } as unknown as Request;
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

function getHandler(router: ReturnType<typeof createAuthRouter>, method: string, path: string) {
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === path && l.route?.methods[method],
  );
  const handlers = layer.route.stack.map((s: any) => s.handle);
  return handlers[handlers.length - 1] as (req: Request, res: Response) => Promise<unknown>;
}

/** Build a pool whose query() dispatches based on the SQL text + params. */
function makeDispatchPool(handlers: Array<(sql: string, params: unknown[]) => { rows: unknown[] } | undefined>): {
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

describe('POST /auth/token — email + password login', () => {
  beforeEach(() => vi.clearAllMocks());

  it('issues a token on correct email + password (enabled user)', async () => {
    const passwordHash = await bcrypt.hash('correct horse', 12);
    const { pool, query } = makeDispatchPool([
      (sql) =>
        sql.includes('lower(email) = lower($1)')
          ? {
              rows: [{
                user_id: 'u-1', pin_hash: 'x', password_hash: passwordHash,
                name: null, token_ttl_days: 7, role: 'user', enabled: true,
                username: null, display_name: null,
              }],
            }
          : undefined,
    ]);
    const router = createAuthRouter(pool, AUTH_SECRET, DASHBOARD_URL);
    const handler = getHandler(router, 'post', '/token');

    const res = makeRes();
    await handler(makeReq({ email: 'a@b.com', password: 'correct horse' }), res);

    expect(res._status).toBe(200);
    const body = res._json as { token: string; user_id: string; expires_at: string };
    expect(body.user_id).toBe('u-1');
    expect(body.token.startsWith('ll5.')).toBe(true);
    // user_id scoping: the lookup is filtered by enabled=true and matches email
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/lower\(email\) = lower\(\$1\) AND enabled = true/),
      ['a@b.com'],
    );
  });

  it('rejects a wrong password with 401 (no token)', async () => {
    const passwordHash = await bcrypt.hash('correct horse', 12);
    const { pool } = makeDispatchPool([
      (sql) =>
        sql.includes('lower(email)')
          ? {
              rows: [{
                user_id: 'u-1', pin_hash: 'x', password_hash: passwordHash,
                name: null, token_ttl_days: 7, role: 'user', enabled: true,
                username: null, display_name: null,
              }],
            }
          : undefined,
    ]);
    const handler = getHandler(createAuthRouter(pool, AUTH_SECRET, DASHBOARD_URL), 'post', '/token');

    const res = makeRes();
    await handler(makeReq({ email: 'a@b.com', password: 'WRONG' }), res);

    expect(res._status).toBe(401);
    expect((res._json as { error: string }).error).toBe('Invalid credentials');
  });

  it('rejects a disabled user with 401 (query filters enabled=true → no row)', async () => {
    // enabled=true filter means a disabled user returns no row → decoy compare → 401.
    const { pool } = makeDispatchPool([() => ({ rows: [] })]);
    const handler = getHandler(createAuthRouter(pool, AUTH_SECRET, DASHBOARD_URL), 'post', '/token');

    const res = makeRes();
    await handler(makeReq({ email: 'disabled@b.com', password: 'whatever' }), res);

    expect(res._status).toBe(401);
    expect((res._json as { error: string }).error).toBe('Invalid credentials');
  });

  it('rejects a user with no password_hash set with 401', async () => {
    const { pool } = makeDispatchPool([
      (sql) =>
        sql.includes('lower(email)')
          ? {
              rows: [{
                user_id: 'u-1', pin_hash: 'x', password_hash: null,
                name: null, token_ttl_days: 7, role: 'user', enabled: true,
                username: null, display_name: null,
              }],
            }
          : undefined,
    ]);
    const handler = getHandler(createAuthRouter(pool, AUTH_SECRET, DASHBOARD_URL), 'post', '/token');

    const res = makeRes();
    await handler(makeReq({ email: 'a@b.com', password: 'anything' }), res);

    expect(res._status).toBe(401);
  });
});

describe('POST /auth/token — existing username/PIN path still works', () => {
  beforeEach(() => vi.clearAllMocks());

  it('issues a token for a valid username + PIN (no regression)', async () => {
    const pinHash = await bcrypt.hash('123456', 12);
    const { pool, query } = makeDispatchPool([
      (sql) =>
        sql.includes('user_id::text = $1 OR username = $1')
          ? {
              rows: [{
                user_id: 'u-2', pin_hash: pinHash, password_hash: null,
                name: 'Bob', token_ttl_days: 7, role: 'user', enabled: true,
                username: 'bob', display_name: 'Bob',
              }],
            }
          : undefined,
    ]);
    const handler = getHandler(createAuthRouter(pool, AUTH_SECRET, DASHBOARD_URL), 'post', '/token');

    const res = makeRes();
    await handler(makeReq({ username: 'bob', pin: '123456' }), res);

    expect(res._status).toBe(200);
    expect((res._json as { user_id: string }).user_id).toBe('u-2');
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/user_id::text = \$1 OR username = \$1/),
      ['bob'],
    );
  });

  it('rejects a wrong PIN with 401 (no regression)', async () => {
    const pinHash = await bcrypt.hash('123456', 12);
    const { pool } = makeDispatchPool([
      (sql) =>
        sql.includes('user_id::text')
          ? {
              rows: [{
                user_id: 'u-2', pin_hash: pinHash, password_hash: null,
                name: 'Bob', token_ttl_days: 7, role: 'user', enabled: true,
                username: 'bob', display_name: 'Bob',
              }],
            }
          : undefined,
    ]);
    const handler = getHandler(createAuthRouter(pool, AUTH_SECRET, DASHBOARD_URL), 'post', '/token');

    const res = makeRes();
    await handler(makeReq({ username: 'bob', pin: '999999' }), res);

    expect(res._status).toBe(401);
  });
});

describe('POST /auth/forgot + POST /auth/reset', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forgot always returns 200 and never leaks whether the email matched', async () => {
    const infoSpy = vi.spyOn(logger, 'info');
    // Matching user → inserts a reset token row.
    const inserted: unknown[][] = [];
    const { pool } = makeDispatchPool([
      (sql) => (sql.includes('FROM auth_users WHERE lower(email)') ? { rows: [{ user_id: 'u-1' }] } : undefined),
      (sql, params) => {
        if (sql.includes("INSERT INTO auth_tokens")) { inserted.push(params); return { rows: [] }; }
        return undefined;
      },
    ]);
    const handler = getHandler(createAuthRouter(pool, AUTH_SECRET, DASHBOARD_URL), 'post', '/forgot');

    const res = makeRes();
    await handler(makeReq({ email: 'a@b.com' }), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ ok: true });
    // a reset token row was inserted with kind password_reset
    expect(inserted.length).toBe(1);

    // Unknown email → still 200 {ok:true}.
    const { pool: pool2 } = makeDispatchPool([() => ({ rows: [] })]);
    const handler2 = getHandler(createAuthRouter(pool2, AUTH_SECRET, DASHBOARD_URL), 'post', '/forgot');
    const res2 = makeRes();
    await handler2(makeReq({ email: 'nobody@b.com' }), res2);
    expect(res2._status).toBe(200);
    expect(res2._json).toEqual({ ok: true });

    infoSpy.mockRestore();
  });

  it('reset sets the password, single-use: a used token is rejected', async () => {
    // First call: token valid (unused, unexpired) → 200. Second call: same token
    // now "used" → the SELECT returns no row → 400.
    let used = false;
    const updated: unknown[][] = [];
    const { pool } = makeDispatchPool([
      (sql) => {
        if (sql.includes('FROM auth_tokens')) {
          return used ? { rows: [] } : { rows: [{ user_id: 'u-1' }] };
        }
        return undefined;
      },
      (sql, params) => {
        if (sql.includes('UPDATE auth_users SET password_hash')) { updated.push(params); return { rows: [] }; }
        if (sql.includes('UPDATE auth_tokens SET used_at')) { used = true; return { rows: [] }; }
        return undefined;
      },
    ]);
    const handler = getHandler(createAuthRouter(pool, AUTH_SECRET, DASHBOARD_URL), 'post', '/reset');

    const res = makeRes();
    await handler(makeReq({ token: 'raw-token', password: 'newpass123' }), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ ok: true });
    expect(updated.length).toBe(1);
    expect(updated[0][1]).toBe('u-1'); // user_id scoping on the password update

    // Reuse the same token → rejected.
    const res2 = makeRes();
    await handler(makeReq({ token: 'raw-token', password: 'newpass123' }), res2);
    expect(res2._status).toBe(400);
  });

  it('reset rejects an expired/invalid token (no matching row) with 400', async () => {
    const { pool } = makeDispatchPool([
      (sql) => (sql.includes('FROM auth_tokens') ? { rows: [] } : undefined),
    ]);
    const handler = getHandler(createAuthRouter(pool, AUTH_SECRET, DASHBOARD_URL), 'post', '/reset');

    const res = makeRes();
    await handler(makeReq({ token: 'expired', password: 'newpass123' }), res);
    expect(res._status).toBe(400);
  });

  it('reset rejects a short password (<8) with 400', async () => {
    const { pool } = makeDispatchPool([]);
    const handler = getHandler(createAuthRouter(pool, AUTH_SECRET, DASHBOARD_URL), 'post', '/reset');

    const res = makeRes();
    await handler(makeReq({ token: 'x', password: 'short' }), res);
    expect(res._status).toBe(400);
  });
});
