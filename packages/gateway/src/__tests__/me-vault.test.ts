import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

vi.mock('../utils/system-message.js', () => ({
  insertSystemMessage: vi.fn(async () => 'msg-1'),
  createSchedulerEvent: vi.fn((scheduler: string) => ({
    scheduler, event_id: 'evt_test', fired_at: new Date().toISOString(),
  })),
}));

import { createVaultRouter } from '../vault.js';
import { clearAlert } from '../utils/alerting.js';
import { insertSystemMessage } from '../utils/system-message.js';

/**
 * Vault tenant plane (DECISION-022 tenant addendum): vault_tenants mapping
 * endpoints + /me/vault/* self-service lifecycle wrappers.
 */

const AUTH_SECRET = 'test-secret-key-at-least-32-characters-long!!';
const VAULT_MCP = 'http://vault-mcp:3000';

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

const tenantRowMatcher = (row: { org_id: string; collection_id: string | null; status: string } | null): Matcher =>
  (sql) => /FROM vault_tenants/.test(sql) ? { rows: row ? [row] : [] } : undefined;

const emailMatcher = (email: string | null): Matcher =>
  (sql) => /SELECT email FROM auth_users/.test(sql) ? { rows: email === null ? [] : [{ email }] } : undefined;

function fetchOk(body: unknown, status = 200) {
  return vi.fn(async () => ({ status, json: async () => body })) as unknown as typeof fetch;
}

describe('vault tenant mapping (vault_tenants)', () => {
  describe('GET /vault/tenant', () => {
    it("returns the CALLER's row (self-scoped)", async () => {
      const row = { org_id: 'org-A', collection_id: 'col-A', status: 'active' };
      const { pool, calls } = makePool([tenantRowMatcher(row)]);
      const router = createVaultRouter(pool, AUTH_SECRET);
      const run = getChain(router, 'get', '/vault/tenant');

      const res = makeRes();
      await run(makeReq({ headers: authHeader(userToken('u1')) }), res);

      expect(res._status).toBe(200);
      expect((res._json as any).tenant).toEqual(row);
      const lookup = calls.find((c) => /vault_tenants/.test(c[0]))!;
      expect(lookup[1]).toEqual(['u1']);
    });

    it('returns {tenant:null} when unmapped (the vault MCP then refuses)', async () => {
      const { pool } = makePool([tenantRowMatcher(null)]);
      const router = createVaultRouter(pool, AUTH_SECRET);
      const run = getChain(router, 'get', '/vault/tenant');
      const res = makeRes();
      await run(makeReq({ headers: authHeader(userToken('u1')) }), res);
      expect(res._status).toBe(200);
      expect((res._json as any).tenant).toBeNull();
    });

    it('401s without a token', async () => {
      const { pool } = makePool([]);
      const router = createVaultRouter(pool, AUTH_SECRET);
      const run = getChain(router, 'get', '/vault/tenant');
      const res = makeRes();
      await run(makeReq(), res);
      expect(res._status).toBe(401);
    });
  });

  describe('PUT /vault/tenant', () => {
    it('403s for plain user/agent tokens — only service tokens may write the mapping', async () => {
      const { pool, calls } = makePool([]);
      const router = createVaultRouter(pool, AUTH_SECRET);
      const run = getChain(router, 'put', '/vault/tenant');

      for (const role of ['user', 'agent', 'admin']) {
        const res = makeRes();
        await run(makeReq({
          headers: authHeader(userToken('u1', role)),
          body: { org_id: 'org-EVIL', collection_id: null, status: 'active' },
        }), res);
        expect(res._status).toBe(403);
      }
      expect(calls.filter((c) => /INSERT INTO vault_tenants/.test(c[0]))).toHaveLength(0);
    });

    it('upserts the caller row with a service token', async () => {
      const { pool, calls } = makePool([]);
      const router = createVaultRouter(pool, AUTH_SECRET);
      const run = getChain(router, 'put', '/vault/tenant');

      const res = makeRes();
      await run(makeReq({
        headers: authHeader(userToken('u1', 'service')),
        body: { org_id: 'org-A', collection_id: 'col-A', status: 'invited' },
      }), res);

      expect(res._status).toBe(200);
      const upsert = calls.find((c) => /INSERT INTO vault_tenants/.test(c[0]))!;
      expect(upsert[1]).toEqual(['u1', 'org-A', 'col-A', 'invited']);
    });

    it('400s on a bad status or missing org_id', async () => {
      const { pool } = makePool([]);
      const router = createVaultRouter(pool, AUTH_SECRET);
      const run = getChain(router, 'put', '/vault/tenant');

      for (const body of [
        { org_id: 'org-A', status: 'bogus' },
        { status: 'active' },
        { org_id: '', status: 'active' },
      ]) {
        const res = makeRes();
        await run(makeReq({ headers: authHeader(userToken('u1', 'service')), body }), res);
        expect(res._status).toBe(400);
      }
    });
  });
});

describe('/me/vault/* self-service wrappers', () => {
  describe('POST /me/vault/provision', () => {
    it("proxies to the vault MCP with the account's email and the caller's token", async () => {
      const fetchImpl = fetchOk({ status: 'invited', org_id: 'org-A', already_provisioned: false });
      const { pool } = makePool([emailMatcher('arnon@example.com')]);
      const router = createVaultRouter(pool, AUTH_SECRET, { vaultMcpUrl: VAULT_MCP, fetchImpl });
      const run = getChain(router, 'post', '/me/vault/provision');

      const res = makeRes();
      await run(makeReq({ headers: authHeader(userToken('u1')) }), res);

      expect(res._status).toBe(200);
      expect((res._json as any).status).toBe('invited');
      const [url, init] = (fetchImpl as any).mock.calls[0];
      expect(url).toBe(`${VAULT_MCP}/internal/tenant/provision`);
      expect(JSON.parse(init.body)).toEqual({ user_email: 'arnon@example.com' });
      expect(init.headers.Authorization).toMatch(/^Bearer ll5\./);
      // The minted token carries the CALLER's uid — the vault MCP self-scopes on it.
      const payload = JSON.parse(Buffer.from(init.headers.Authorization.split('.')[1], 'base64url').toString());
      expect(payload.uid).toBe('u1');
    });

    it('a body email overrides the account email', async () => {
      const fetchImpl = fetchOk({ status: 'invited' });
      const { pool } = makePool([emailMatcher('account@example.com')]);
      const router = createVaultRouter(pool, AUTH_SECRET, { vaultMcpUrl: VAULT_MCP, fetchImpl });
      const run = getChain(router, 'post', '/me/vault/provision');

      const res = makeRes();
      await run(makeReq({ headers: authHeader(userToken('u1')), body: { email: 'other@example.com' } }), res);
      const [, init] = (fetchImpl as any).mock.calls[0];
      expect(JSON.parse(init.body)).toEqual({ user_email: 'other@example.com' });
    });

    it('400s when the account has no email and none is supplied', async () => {
      const fetchImpl = fetchOk({});
      const { pool } = makePool([emailMatcher(null)]);
      const router = createVaultRouter(pool, AUTH_SECRET, { vaultMcpUrl: VAULT_MCP, fetchImpl });
      const run = getChain(router, 'post', '/me/vault/provision');
      const res = makeRes();
      await run(makeReq({ headers: authHeader(userToken('u1')) }), res);
      expect(res._status).toBe(400);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('502s when the vault MCP is unreachable', async () => {
      const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
      const { pool } = makePool([emailMatcher('arnon@example.com')]);
      const router = createVaultRouter(pool, AUTH_SECRET, { vaultMcpUrl: VAULT_MCP, fetchImpl });
      const run = getChain(router, 'post', '/me/vault/provision');
      const res = makeRes();
      await run(makeReq({ headers: authHeader(userToken('u1')) }), res);
      expect(res._status).toBe(502);
    });

    it('401s without a token', async () => {
      const { pool } = makePool([]);
      const router = createVaultRouter(pool, AUTH_SECRET, { vaultMcpUrl: VAULT_MCP, fetchImpl: fetchOk({}) });
      const run = getChain(router, 'post', '/me/vault/provision');
      const res = makeRes();
      await run(makeReq(), res);
      expect(res._status).toBe(401);
    });
  });

  describe('POST /me/vault/confirm', () => {
    it('proxies the confirm and relays the outcome', async () => {
      const fetchImpl = fetchOk({ membership_status: 'confirmed', message: 'ok' });
      const { pool } = makePool([]);
      const router = createVaultRouter(pool, AUTH_SECRET, { vaultMcpUrl: VAULT_MCP, fetchImpl });
      const run = getChain(router, 'post', '/me/vault/confirm');

      const res = makeRes();
      await run(makeReq({ headers: authHeader(userToken('u1')) }), res);
      expect(res._status).toBe(200);
      expect((res._json as any).membership_status).toBe('confirmed');
      const [url] = (fetchImpl as any).mock.calls[0];
      expect(url).toBe(`${VAULT_MCP}/internal/tenant/confirm`);
    });

    it('relays a 409 (invite not accepted yet / not provisioned)', async () => {
      const fetchImpl = fetchOk({ error: 'not provisioned' }, 409);
      const { pool } = makePool([]);
      const router = createVaultRouter(pool, AUTH_SECRET, { vaultMcpUrl: VAULT_MCP, fetchImpl });
      const run = getChain(router, 'post', '/me/vault/confirm');
      const res = makeRes();
      await run(makeReq({ headers: authHeader(userToken('u1')) }), res);
      expect(res._status).toBe(409);
    });
  });

  describe('GET /me/vault/status', () => {
    it('returns unprovisioned shape when no mapping exists', async () => {
      const fetchImpl = fetchOk({});
      const { pool } = makePool([tenantRowMatcher(null)]);
      const router = createVaultRouter(pool, AUTH_SECRET, { vaultMcpUrl: VAULT_MCP, fetchImpl });
      const run = getChain(router, 'get', '/me/vault/status');

      const res = makeRes();
      await run(makeReq({ headers: authHeader(userToken('u1')) }), res);
      expect(res._status).toBe(200);
      expect(res._json).toEqual({ status: 'unprovisioned', org_id: null, sites_count: null, approved_sites: [] });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('composes {status, org_id, sites_count, approved_sites} when provisioned', async () => {
      const fetchImpl = fetchOk({ provisioned: true, membership_status: 'active', sites_count: 4, approved_sites: [] });
      const { pool } = makePool([
        tenantRowMatcher({ org_id: 'org-A', collection_id: 'col-A', status: 'active' }),
        (sql) => /SELECT settings->'vault' AS vault FROM user_settings/.test(sql)
          ? { rows: [{ vault: { approved_sites: ['example.com'] } }] }
          : undefined,
      ]);
      const router = createVaultRouter(pool, AUTH_SECRET, { vaultMcpUrl: VAULT_MCP, fetchImpl });
      const run = getChain(router, 'get', '/me/vault/status');

      const res = makeRes();
      await run(makeReq({ headers: authHeader(userToken('u1')) }), res);
      expect(res._status).toBe(200);
      expect(res._json).toEqual({
        status: 'active',
        org_id: 'org-A',
        sites_count: 4,
        approved_sites: ['example.com'],
      });
    });

    it('degrades sites_count to null when the vault MCP is unreachable', async () => {
      const fetchImpl = vi.fn(async () => { throw new Error('down'); }) as unknown as typeof fetch;
      const { pool } = makePool([tenantRowMatcher({ org_id: 'org-A', collection_id: null, status: 'invited' })]);
      const router = createVaultRouter(pool, AUTH_SECRET, { vaultMcpUrl: VAULT_MCP, fetchImpl });
      const run = getChain(router, 'get', '/me/vault/status');

      const res = makeRes();
      await run(makeReq({ headers: authHeader(userToken('u1')) }), res);
      expect(res._status).toBe(200);
      expect((res._json as any).status).toBe('invited');
      expect((res._json as any).sites_count).toBeNull();
    });
  });
});

describe('POST /me/vault/approve-site — tray one-tap answer', () => {
  const settingsMatcher = (sites: unknown): Matcher =>
    (sql) => /SELECT settings->'vault' AS vault FROM user_settings/.test(sql)
      ? { rows: [{ vault: { approved_sites: sites } }] }
      : undefined;

  const runApproveSite = async (pool: Pool, body: unknown, token = userToken('u1')) => {
    vi.mocked(clearAlert).mockClear();
    vi.mocked(insertSystemMessage).mockClear();
    const router = createVaultRouter(pool, AUTH_SECRET);
    const run = getChain(router, 'post', '/me/vault/approve-site');
    const req = makeReq({ headers: authHeader(token), body: body as Record<string, unknown> });
    const res = makeRes();
    await run(req, res);
    return res;
  };

  it('approve: adds the domain to the allowlist (shared write path) and clears the alert', async () => {
    const { pool, calls } = makePool([settingsMatcher(['example.com'])]);
    const res = await runApproveSite(pool, { domain: ' NewBank.co.il ', decision: 'approve' });

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ status: 'approved', domain: 'newbank.co.il' });

    // Same user_settings upsert as PUT /vault/approved-sites — existing
    // entries preserved, new domain appended (normalized).
    const write = calls.find((c) => /INSERT INTO user_settings/.test(c[0]))!;
    expect(write[1][0]).toBe('u1');
    expect(JSON.parse(write[1][1] as string)).toEqual(['example.com', 'newbank.co.il']);

    expect(clearAlert).toHaveBeenCalledWith(expect.anything(), 'u1', 'vault.approval.newbank.co.il');
    expect(insertSystemMessage).not.toHaveBeenCalled();
  });

  it('approve is idempotent when the domain is already on the list', async () => {
    const { pool, calls } = makePool([settingsMatcher(['example.com'])]);
    const res = await runApproveSite(pool, { domain: 'example.com', decision: 'approve' });

    expect(res._status).toBe(200);
    const write = calls.find((c) => /INSERT INTO user_settings/.test(c[0]))!;
    expect(JSON.parse(write[1][1] as string)).toEqual(['example.com']);
  });

  it('deny: clears the alert, leaves the allowlist untouched, files the agent notice', async () => {
    const { pool, calls } = makePool([settingsMatcher(['example.com'])]);
    const res = await runApproveSite(pool, { domain: 'evil.com', decision: 'deny' });

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ status: 'denied', domain: 'evil.com' });

    expect(clearAlert).toHaveBeenCalledWith(expect.anything(), 'u1', 'vault.approval.evil.com');
    // Allowlist untouched — the site simply stays blocked.
    expect(calls.some((c) => /INSERT INTO user_settings/.test(c[0]))).toBe(false);
    // Agent notice so it doesn't re-request today.
    expect(insertSystemMessage).toHaveBeenCalledTimes(1);
    const noticeArgs = vi.mocked(insertSystemMessage).mock.calls[0];
    expect(noticeArgs[1]).toBe('u1');
    expect(noticeArgs[2]).toMatch(/\[Vault\] user denied site evil\.com — do not re-request today/);
  });

  it('400s on a missing domain or an unknown decision', async () => {
    const { pool } = makePool([]);
    expect((await runApproveSite(pool, { decision: 'approve' }))._status).toBe(400);
    expect((await runApproveSite(pool, { domain: 'x.com', decision: 'maybe' }))._status).toBe(400);
  });

  it('401s without a token', async () => {
    const { pool } = makePool([]);
    const router = createVaultRouter(pool, AUTH_SECRET);
    const run = getChain(router, 'post', '/me/vault/approve-site');
    const res = makeRes();
    await run(makeReq({ body: { domain: 'x.com', decision: 'approve' } }), res);
    expect(res._status).toBe(401);
  });
});

describe('migration 035_vault_tenants.sql', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.join(dir, '..', 'migrations', '035_vault_tenants.sql'), 'utf-8');

  it('creates vault_tenants with the status lifecycle constraint', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS vault_tenants');
    expect(sql).toContain('user_id       UUID PRIMARY KEY');
    expect(sql).toMatch(/CHECK \(status IN \('provisioning', 'invited', 'active'\)\)/);
  });

  it("seeds the existing admin org so today's setup keeps working (idempotently)", () => {
    expect(sql).toContain("'f08f46b3-0a9c-41ae-9e6a-294c697424e4'");
    expect(sql).toContain("'3ef6bab6-0055-4cf3-96af-070dae7707e1'");
    expect(sql).toMatch(/'active'/);
    expect(sql).toContain('ON CONFLICT (user_id) DO NOTHING');
  });
});
