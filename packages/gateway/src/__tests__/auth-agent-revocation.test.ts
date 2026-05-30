import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { createAuthRouter } from '../auth.js';
import { generateToken } from '@ll5/shared';

const AUTH_SECRET = 'test-secret-key-at-least-32-characters-long!!';
const DASHBOARD_URL = 'https://dash.example';

function makeReq(headers: Record<string, unknown>): Request {
  return { headers, query: {}, body: {}, params: {} } as unknown as Request;
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

function makeDispatchPool(handlers: Array<(sql: string, params: unknown[]) => { rows: unknown[]; rowCount?: number } | undefined>): {
  pool: Pool;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    for (const h of handlers) {
      const out = h(sql, params);
      if (out) return out;
    }
    return { rows: [], rowCount: 0 };
  });
  return { pool: { query } as unknown as Pool, query };
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

describe('POST /auth/refresh — agent credential revocation', () => {
  it('denies a refresh for a revoked agent credential', async () => {
    const token = generateToken('user-a', AUTH_SECRET, 90, 'user');
    const { pool } = makeDispatchPool([
      (sql, params) =>
        sql.includes('SELECT revoked_at FROM agent_credentials') && params[0] === sha256(token)
          ? { rows: [{ revoked_at: '2026-05-30T00:00:00Z' }] }
          : undefined,
    ]);
    const router = createAuthRouter(pool, AUTH_SECRET, DASHBOARD_URL);
    const handler = getHandler(router, 'post', '/refresh');

    const res = makeRes();
    await handler(makeReq({ authorization: `Bearer ${token}` }), res);

    expect(res._status).toBe(401);
    expect((res._json as any).error).toMatch(/revoked/i);
  });

  it('stamps last_used_at and issues a new token for a live agent credential', async () => {
    const token = generateToken('user-a', AUTH_SECRET, 90, 'user');
    const { pool, query } = makeDispatchPool([
      (sql) =>
        sql.includes('SELECT revoked_at FROM agent_credentials')
          ? { rows: [{ revoked_at: null }] }
          : undefined,
      (sql) =>
        sql.includes('UPDATE agent_credentials SET last_used_at')
          ? { rows: [], rowCount: 1 }
          : undefined,
      (sql) =>
        sql.includes('FROM auth_users')
          ? { rows: [{ user_id: 'user-a', token_ttl_days: 90, role: 'user', enabled: true, username: null, display_name: null }] }
          : undefined,
    ]);
    const router = createAuthRouter(pool, AUTH_SECRET, DASHBOARD_URL);
    const handler = getHandler(router, 'post', '/refresh');

    const res = makeRes();
    await handler(makeReq({ authorization: `Bearer ${token}` }), res);

    expect(res._status).toBe(200);
    expect(typeof (res._json as any).token).toBe('string');
    // last_used_at was stamped with the presented token's hash.
    const updateCall = query.mock.calls.find((c) => String(c[0]).includes('UPDATE agent_credentials SET last_used_at'));
    expect(updateCall).toBeTruthy();
    expect(updateCall![1]).toEqual([sha256(token)]);
  });

  it('leaves a non-agent token unaffected (no matching credential row)', async () => {
    const token = generateToken('user-a', AUTH_SECRET, 7, 'user');
    const { pool } = makeDispatchPool([
      (sql) =>
        sql.includes('SELECT revoked_at FROM agent_credentials')
          ? { rows: [] } // no agent_credentials row → ordinary user token
          : undefined,
      (sql) =>
        sql.includes('FROM auth_users')
          ? { rows: [{ user_id: 'user-a', token_ttl_days: 7, role: 'user', enabled: true, username: null, display_name: null }] }
          : undefined,
    ]);
    const router = createAuthRouter(pool, AUTH_SECRET, DASHBOARD_URL);
    const handler = getHandler(router, 'post', '/refresh');

    const res = makeRes();
    await handler(makeReq({ authorization: `Bearer ${token}` }), res);

    expect(res._status).toBe(200);
    expect(typeof (res._json as any).token).toBe('string');
  });
});
