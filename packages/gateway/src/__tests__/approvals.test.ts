import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';

vi.mock('@ll5/shared', async (orig) => {
  const actual = await orig<typeof import('@ll5/shared')>();
  return { ...actual, logAudit: vi.fn() };
});

import { createApprovalsRouter } from '../approvals.js';

const AUTH_SECRET = 'test-secret-key-at-least-32-characters-long!!';

/** Mint a valid ll5 token for a given user/role. */
function userToken(userId: string, role = 'user'): string {
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

type Matcher = (sql: string, params: unknown[]) => { rows: unknown[]; rowCount?: number } | undefined;

/** Pool whose query() and a single pooled client share the same matcher list.
 *  Records every (sql, params) the decide transaction issues. */
function makePool(matchers: Matcher[]): { pool: Pool; calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = [];
  const run = async (sql: string, params: unknown[] = []) => {
    calls.push([sql, params]);
    for (const m of matchers) {
      const out = m(sql, params);
      if (out) return out;
    }
    return { rows: [], rowCount: 0 };
  };
  const client = { query: vi.fn(run), release: vi.fn() };
  const pool = {
    query: vi.fn(run),
    connect: vi.fn(async () => client),
  } as unknown as Pool;
  return { pool, calls };
}

function getChain(router: ReturnType<typeof createApprovalsRouter>, method: string, path: string) {
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
      if (!advanced) return;
    }
  };
}

const authHeader = (token: string) => ({ authorization: `Bearer ${token}` });

describe('approvals plane — authority (permission) gate', () => {
  describe('GET /approvals/pending', () => {
    it("returns the caller's pending, non-expired requests", async () => {
      const row = {
        id: 'req-1', platform: 'whatsapp', conversation_id: '123@g.us',
        display_name: 'Sunbit', current_permission: 'input', requested_permission: 'agent',
        created_at: '2026-06-22T00:00:00Z',
      };
      const { pool } = makePool([
        (sql) => /SELECT[\s\S]*FROM permission_change_requests[\s\S]*status = 'pending'/.test(sql) ? { rows: [row] } : undefined,
      ]);
      const router = createApprovalsRouter(pool, AUTH_SECRET);
      const run = getChain(router, 'get', '/approvals/pending');

      const req = makeReq({ headers: authHeader(userToken('u1')) });
      const res = makeRes();
      await run(req, res);

      expect(res._status).toBe(200);
      expect((res._json as any).pending).toEqual([row]);
    });

    it('401s without a token', async () => {
      const { pool } = makePool([]);
      const router = createApprovalsRouter(pool, AUTH_SECRET);
      const run = getChain(router, 'get', '/approvals/pending');
      const req = makeReq();
      const res = makeRes();
      await run(req, res);
      expect(res._status).toBe(401);
    });
  });

  describe('POST /approvals/:id/decide', () => {
    const pendingRow = {
      id: 'req-1', platform: 'whatsapp', conversation_id: '123@g.us',
      target_type: 'group', target_id: '123@g.us', display_name: 'Sunbit',
      current_permission: 'input', requested_permission: 'agent',
      status: 'pending', expired: false,
    };

    it('approve → upserts contact_settings.permission and marks applied', async () => {
      const { pool, calls } = makePool([
        (sql) => /FOR UPDATE/.test(sql) ? { rows: [pendingRow] } : undefined,
        (sql) => /INSERT INTO contact_settings/.test(sql)
          ? { rows: [{ target_type: 'group', target_id: '123@g.us', display_name: 'Sunbit', permission: 'agent' }] }
          : undefined,
      ]);
      const router = createApprovalsRouter(pool, AUTH_SECRET);
      const run = getChain(router, 'post', '/approvals/:id/decide');

      const req = makeReq({ headers: authHeader(userToken('u1')), params: { id: 'req-1' }, body: { decision: 'approve' } });
      const res = makeRes();
      await run(req, res);

      expect(res._status).toBe(200);
      expect((res._json as any).status).toBe('applied');
      expect((res._json as any).applied.permission).toBe('agent');

      const sqls = calls.map((c) => c[0]).join('\n');
      expect(sqls).toMatch(/INSERT INTO contact_settings/);
      expect(sqls).toMatch(/SET permission = EXCLUDED.permission|permission = EXCLUDED.permission/);
      expect(sqls).toMatch(/SET status = 'applied'/);
      // The upsert was scoped to the caller's user_id.
      const csCall = calls.find((c) => /INSERT INTO contact_settings/.test(c[0]))!;
      expect(csCall[1][0]).toBe('u1');
      expect(csCall[1][3]).toBe('agent'); // requested_permission
    });

    it('reject → marks rejected and never writes contact_settings', async () => {
      const { pool, calls } = makePool([
        (sql) => /FOR UPDATE/.test(sql) ? { rows: [pendingRow] } : undefined,
      ]);
      const router = createApprovalsRouter(pool, AUTH_SECRET);
      const run = getChain(router, 'post', '/approvals/:id/decide');

      const req = makeReq({ headers: authHeader(userToken('u1')), params: { id: 'req-1' }, body: { decision: 'reject' } });
      const res = makeRes();
      await run(req, res);

      expect(res._status).toBe(200);
      expect((res._json as any).status).toBe('rejected');

      const sqls = calls.map((c) => c[0]).join('\n');
      expect(sqls).toMatch(/SET status = 'rejected'/);
      expect(sqls).not.toMatch(/INSERT INTO contact_settings/);
    });

    it('is user-scoped — a foreign/missing request is 404 (no disclosure)', async () => {
      // The scoped SELECT (id + user_id) finds nothing.
      const { pool, calls } = makePool([
        (sql) => /FOR UPDATE/.test(sql) ? { rows: [] } : undefined,
      ]);
      const router = createApprovalsRouter(pool, AUTH_SECRET);
      const run = getChain(router, 'post', '/approvals/:id/decide');

      const req = makeReq({ headers: authHeader(userToken('attacker')), params: { id: 'req-1' }, body: { decision: 'approve' } });
      const res = makeRes();
      await run(req, res);

      expect(res._status).toBe(404);
      // The lookup was scoped to the caller.
      const lookup = calls.find((c) => /FOR UPDATE/.test(c[0]))!;
      expect(lookup[1]).toEqual(['req-1', 'attacker']);
      expect(calls.map((c) => c[0]).join('\n')).not.toMatch(/INSERT INTO contact_settings/);
    });

    it('rejects deciding a non-pending request (already applied)', async () => {
      const { pool } = makePool([
        (sql) => /FOR UPDATE/.test(sql) ? { rows: [{ ...pendingRow, status: 'applied' }] } : undefined,
      ]);
      const router = createApprovalsRouter(pool, AUTH_SECRET);
      const run = getChain(router, 'post', '/approvals/:id/decide');

      const req = makeReq({ headers: authHeader(userToken('u1')), params: { id: 'req-1' }, body: { decision: 'approve' } });
      const res = makeRes();
      await run(req, res);

      expect(res._status).toBe(409);
      expect((res._json as any).status).toBe('applied');
    });

    it('rejects deciding an expired request and marks it expired', async () => {
      const { pool, calls } = makePool([
        (sql) => /FOR UPDATE/.test(sql) ? { rows: [{ ...pendingRow, expired: true }] } : undefined,
      ]);
      const router = createApprovalsRouter(pool, AUTH_SECRET);
      const run = getChain(router, 'post', '/approvals/:id/decide');

      const req = makeReq({ headers: authHeader(userToken('u1')), params: { id: 'req-1' }, body: { decision: 'approve' } });
      const res = makeRes();
      await run(req, res);

      expect(res._status).toBe(409);
      expect((res._json as any).status).toBe('expired');
      const sqls = calls.map((c) => c[0]).join('\n');
      expect(sqls).toMatch(/SET status = 'expired'/);
      expect(sqls).not.toMatch(/INSERT INTO contact_settings/);
    });

    it('400s on an invalid decision', async () => {
      const { pool } = makePool([]);
      const router = createApprovalsRouter(pool, AUTH_SECRET);
      const run = getChain(router, 'post', '/approvals/:id/decide');
      const req = makeReq({ headers: authHeader(userToken('u1')), params: { id: 'req-1' }, body: { decision: 'maybe' } });
      const res = makeRes();
      await run(req, res);
      expect(res._status).toBe(400);
    });
  });
});
