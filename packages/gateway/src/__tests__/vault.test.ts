import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';

vi.mock('@ll5/shared', async (orig) => {
  const actual = await orig<typeof import('@ll5/shared')>();
  return { ...actual, logAudit: vi.fn() };
});

vi.mock('../utils/alerting.js', () => ({
  raiseAlert: vi.fn(async () => undefined),
  clearAlert: vi.fn(async () => undefined),
}));

import { createVaultRouter } from '../vault.js';
import { raiseAlert, clearAlert } from '../utils/alerting.js';

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
  const pool = { query: vi.fn(run) } as unknown as Pool;
  return { pool, calls };
}

function getChain(router: ReturnType<typeof createVaultRouter>, method: string, path: string) {
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

const settingsRowMatcher = (sites: unknown): Matcher =>
  (sql) => /SELECT settings->'vault' AS vault FROM user_settings/.test(sql)
    ? { rows: [{ vault: { approved_sites: sites } }] }
    : undefined;

beforeEach(() => {
  vi.mocked(raiseAlert).mockClear();
  vi.mocked(clearAlert).mockClear();
});

describe('vault allowlist plane (DECISION-022)', () => {
  describe('GET /vault/approved-sites', () => {
    it("returns the caller's approved sites from user_settings.vault", async () => {
      const { pool, calls } = makePool([settingsRowMatcher(['example.com', 'school.co.il'])]);
      const router = createVaultRouter(pool, AUTH_SECRET);
      const run = getChain(router, 'get', '/vault/approved-sites');

      const req = makeReq({ headers: authHeader(userToken('u1')) });
      const res = makeRes();
      await run(req, res);

      expect(res._status).toBe(200);
      expect((res._json as any).approved_sites).toEqual(['example.com', 'school.co.il']);
      // Scoped to the caller.
      const lookup = calls.find((c) => /user_settings/.test(c[0]))!;
      expect(lookup[1]).toEqual(['u1']);
    });

    it('returns [] when no settings row / no vault key exists', async () => {
      const { pool } = makePool([]);
      const router = createVaultRouter(pool, AUTH_SECRET);
      const run = getChain(router, 'get', '/vault/approved-sites');
      const req = makeReq({ headers: authHeader(userToken('u1')) });
      const res = makeRes();
      await run(req, res);
      expect(res._status).toBe(200);
      expect((res._json as any).approved_sites).toEqual([]);
    });

    it('401s without a token', async () => {
      const { pool } = makePool([]);
      const router = createVaultRouter(pool, AUTH_SECRET);
      const run = getChain(router, 'get', '/vault/approved-sites');
      const req = makeReq();
      const res = makeRes();
      await run(req, res);
      expect(res._status).toBe(401);
    });
  });

  describe('PUT /vault/approved-sites', () => {
    it('replaces the list (normalized, deduped) and clears matching approval alerts', async () => {
      const { pool, calls } = makePool([]);
      const router = createVaultRouter(pool, AUTH_SECRET);
      const run = getChain(router, 'put', '/vault/approved-sites');

      const req = makeReq({
        headers: authHeader(userToken('u1')),
        body: { approved_sites: ['Example.com ', 'example.com', 'school.co.il'] },
      });
      const res = makeRes();
      await run(req, res);

      expect(res._status).toBe(200);
      expect((res._json as any).approved_sites).toEqual(['example.com', 'school.co.il']);

      const upsert = calls.find((c) => /INSERT INTO user_settings/.test(c[0]))!;
      expect(upsert[1][0]).toBe('u1');
      expect(JSON.parse(upsert[1][1] as string)).toEqual(['example.com', 'school.co.il']);
      // Approval alerts auto-resolve for every now-approved domain.
      expect(clearAlert).toHaveBeenCalledWith(pool, 'u1', 'vault.approval.example.com');
      expect(clearAlert).toHaveBeenCalledWith(pool, 'u1', 'vault.approval.school.co.il');
    });

    it('400s on a non-array body', async () => {
      const { pool } = makePool([]);
      const router = createVaultRouter(pool, AUTH_SECRET);
      const run = getChain(router, 'put', '/vault/approved-sites');
      const req = makeReq({ headers: authHeader(userToken('u1')), body: { approved_sites: 'example.com' } });
      const res = makeRes();
      await run(req, res);
      expect(res._status).toBe(400);
    });

    it('400s when an entry is not a non-empty string', async () => {
      const { pool } = makePool([]);
      const router = createVaultRouter(pool, AUTH_SECRET);
      const run = getChain(router, 'put', '/vault/approved-sites');
      const req = makeReq({ headers: authHeader(userToken('u1')), body: { approved_sites: ['ok.com', ''] } });
      const res = makeRes();
      await run(req, res);
      expect(res._status).toBe(400);
    });

    it('401s without a token', async () => {
      const { pool } = makePool([]);
      const router = createVaultRouter(pool, AUTH_SECRET);
      const run = getChain(router, 'put', '/vault/approved-sites');
      const req = makeReq({ body: { approved_sites: [] } });
      const res = makeRes();
      await run(req, res);
      expect(res._status).toBe(401);
    });
  });

  describe('POST /vault/approval-request', () => {
    it('raises a warning alert with the stable vault.approval.<domain> key', async () => {
      const { pool } = makePool([settingsRowMatcher([])]);
      const router = createVaultRouter(pool, AUTH_SECRET);
      const run = getChain(router, 'post', '/vault/approval-request');

      const req = makeReq({
        headers: authHeader(userToken('u1')),
        body: { domain: 'School.Example.com', site_name: 'School portal' },
      });
      const res = makeRes();
      await run(req, res);

      expect(res._status).toBe(200);
      expect((res._json as any).status).toBe('pending');
      expect((res._json as any).domain).toBe('school.example.com');
      expect(raiseAlert).toHaveBeenCalledTimes(1);
      const input = vi.mocked(raiseAlert).mock.calls[0][1];
      expect(input.key).toBe('vault.approval.school.example.com');
      expect(input.severity).toBe('warning');
      expect(input.userId).toBe('u1');
      expect(input.summary).toContain('School portal');
    });

    it('auto-resolves instead of alerting when the domain is already approved', async () => {
      const { pool } = makePool([settingsRowMatcher(['school.example.com'])]);
      const router = createVaultRouter(pool, AUTH_SECRET);
      const run = getChain(router, 'post', '/vault/approval-request');

      const req = makeReq({
        headers: authHeader(userToken('u1')),
        body: { domain: 'school.example.com' },
      });
      const res = makeRes();
      await run(req, res);

      expect(res._status).toBe(200);
      expect((res._json as any).status).toBe('already_approved');
      expect(raiseAlert).not.toHaveBeenCalled();
      expect(clearAlert).toHaveBeenCalledWith(pool, 'u1', 'vault.approval.school.example.com');
    });

    it('400s without a domain', async () => {
      const { pool } = makePool([]);
      const router = createVaultRouter(pool, AUTH_SECRET);
      const run = getChain(router, 'post', '/vault/approval-request');
      const req = makeReq({ headers: authHeader(userToken('u1')), body: {} });
      const res = makeRes();
      await run(req, res);
      expect(res._status).toBe(400);
    });

    it('401s without a token', async () => {
      const { pool } = makePool([]);
      const router = createVaultRouter(pool, AUTH_SECRET);
      const run = getChain(router, 'post', '/vault/approval-request');
      const req = makeReq({ body: { domain: 'x.com' } });
      const res = makeRes();
      await run(req, res);
      expect(res._status).toBe(401);
    });
  });
});
