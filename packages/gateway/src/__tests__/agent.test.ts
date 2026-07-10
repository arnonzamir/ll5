import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { createAgentRouter } from '../agent.js';
import { decryptSecret } from '../utils/encryption.js';
import { OrchestratorNotConfiguredError } from '../utils/orchestrator.js';

const AUTH_SECRET = 'test-secret-key-at-least-32-characters-long!!';
const ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
const MCP_BASE_DOMAIN = 'example.test';

/** Mint a valid ll5 token for a given user/role (matches generateToken format). */
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

function makePool(matchers: Matcher[]): { pool: Pool; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    for (const m of matchers) {
      const out = m(sql, params);
      if (out) return out;
    }
    return { rows: [], rowCount: 0 };
  });
  return { pool: { query } as unknown as Pool, query };
}

/** Run the full handler chain (middleware + handler) for a route. */
function getChain(router: ReturnType<typeof createAgentRouter>, method: string, path: string) {
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

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe('agent connection plane', () => {
  describe('POST /me/agent/connection', () => {
    it('mints a token, returns mcp_config with all 6 servers + Bearer header, stores only the hash', async () => {
      const inserted: { user_id: string; name: string; token_hash: string }[] = [];
      const { pool, query } = makePool([
        (sql, params) => {
          if (sql.includes('INSERT INTO agent_credentials')) {
            inserted.push({ user_id: params[0] as string, name: params[1] as string, token_hash: params[2] as string });
            return { rows: [{ id: 'cred-1', created_at: '2026-05-30T00:00:00Z' }] };
          }
          return undefined;
        },
      ]);
      const router = createAgentRouter(pool, AUTH_SECRET, ENCRYPTION_KEY, MCP_BASE_DOMAIN);
      const chain = getChain(router, 'post', '/me/agent/connection');

      const req = makeReq({ headers: authHeader(userToken('user-a', 'admin')), body: { name: 'my-laptop' } });
      const res = makeRes();
      await chain(req, res);

      expect(res._status).toBe(201);
      const body = res._json as any;
      expect(body.credential_id).toBe('cred-1');
      expect(body.name).toBe('my-laptop');
      expect(typeof body.token).toBe('string');
      expect(body.token.startsWith('ll5.')).toBe(true);

      // mcp_config: 6 servers, all https://mcp-*.<domain>/mcp + Bearer header.
      const servers = body.mcp_config.mcpServers;
      const keys = Object.keys(servers).sort();
      expect(keys).toEqual(
        ['ll5-awareness', 'll5-calendar', 'll5-gtd', 'll5-health', 'll5-knowledge', 'll5-messaging'],
      );
      for (const k of keys) {
        expect(servers[k].type).toBe('http');
        expect(servers[k].url).toMatch(new RegExp(`^https://mcp-[a-z]+\\.${MCP_BASE_DOMAIN}/mcp$`));
        expect(servers[k].headers.Authorization).toBe(`Bearer ${body.token}`);
      }
      // calendar → mcp-google specifically.
      expect(servers['ll5-calendar'].url).toBe(`https://mcp-google.${MCP_BASE_DOMAIN}/mcp`);

      // Stored value is sha256(token), NOT the raw token.
      const expectedHash = crypto.createHash('sha256').update(body.token).digest('hex');
      expect(inserted[0].token_hash).toBe(expectedHash);
      expect(inserted[0].token_hash).not.toBe(body.token);
      expect(inserted[0].user_id).toBe('user-a');
    });

    it('rejects an unauthenticated caller', async () => {
      const { pool } = makePool([]);
      const router = createAgentRouter(pool, AUTH_SECRET, ENCRYPTION_KEY, MCP_BASE_DOMAIN);
      const chain = getChain(router, 'post', '/me/agent/connection');
      const req = makeReq({ body: {} });
      const res = makeRes();
      await chain(req, res);
      expect(res._status).toBe(401);
    });
  });

  describe('GET /me/agent/credentials', () => {
    it('lists scoped to the caller and never returns token_hash', async () => {
      const { pool, query } = makePool([
        (sql, params) => {
          if (sql.includes('FROM agent_credentials') && sql.includes('SELECT')) {
            return {
              rows: [{ id: 'c1', name: 'agent', last_used_at: null, revoked_at: null, created_at: 'x' }],
            };
          }
          return undefined;
        },
      ]);
      const router = createAgentRouter(pool, AUTH_SECRET, ENCRYPTION_KEY, MCP_BASE_DOMAIN);
      const chain = getChain(router, 'get', '/me/agent/credentials');
      const req = makeReq({ headers: authHeader(userToken('user-a')) });
      const res = makeRes();
      await chain(req, res);

      expect(res._status).toBe(200);
      const body = res._json as any;
      expect(body.credentials).toHaveLength(1);
      expect(JSON.stringify(body)).not.toContain('token_hash');
      // Query was scoped by user_id = $1 with the caller's id.
      const selectCall = query.mock.calls.find((c) => String(c[0]).includes('FROM agent_credentials'));
      expect(String(selectCall![0])).toMatch(/WHERE user_id = \$1/);
      expect(selectCall![1]).toEqual(['user-a']);
    });
  });

  describe('DELETE /me/agent/credentials/:id', () => {
    it('revokes a credential scoped to the caller', async () => {
      const { pool, query } = makePool([
        (sql) => (sql.includes('UPDATE agent_credentials') ? { rows: [{ id: 'c1' }], rowCount: 1 } : undefined),
      ]);
      const router = createAgentRouter(pool, AUTH_SECRET, ENCRYPTION_KEY, MCP_BASE_DOMAIN);
      const chain = getChain(router, 'delete', '/me/agent/credentials/:id');
      const req = makeReq({ headers: authHeader(userToken('user-a')), params: { id: 'c1' } });
      const res = makeRes();
      await chain(req, res);

      expect(res._status).toBe(200);
      expect((res._json as any).revoked).toBe(true);
      const call = query.mock.calls.find((c) => String(c[0]).includes('UPDATE agent_credentials'));
      expect(String(call![0])).toMatch(/WHERE id = \$1 AND user_id = \$2/);
      expect(call![1]).toEqual(['c1', 'user-a']);
    });

    it('returns 404 for a cross-user delete (not theirs)', async () => {
      // Scoped UPDATE matches no rows → rowCount 0.
      const { pool } = makePool([
        (sql) => (sql.includes('UPDATE agent_credentials') ? { rows: [], rowCount: 0 } : undefined),
      ]);
      const router = createAgentRouter(pool, AUTH_SECRET, ENCRYPTION_KEY, MCP_BASE_DOMAIN);
      const chain = getChain(router, 'delete', '/me/agent/credentials/:id');
      const req = makeReq({ headers: authHeader(userToken('user-b')), params: { id: 'belongs-to-a' } });
      const res = makeRes();
      await chain(req, res);
      expect(res._status).toBe(404);
    });
  });

  describe('PUT /me/agent/llm-credential', () => {
    it('rejects a non-Anthropic key (bad prefix)', async () => {
      const { pool, query } = makePool([]);
      const router = createAgentRouter(pool, AUTH_SECRET, ENCRYPTION_KEY, MCP_BASE_DOMAIN);
      const chain = getChain(router, 'put', '/me/agent/llm-credential');
      const req = makeReq({ headers: authHeader(userToken('user-a')), body: { api_key: 'sk-not-anthropic-1234567890' } });
      const res = makeRes();
      await chain(req, res);
      expect(res._status).toBe(400);
      // Nothing was written.
      expect(query).not.toHaveBeenCalled();
    });

    it('encrypts the key (ciphertext != plaintext), stores last4, never returns the key', async () => {
      const stored: { ciphertext: string; last4: string } = { ciphertext: '', last4: '' };
      const { pool } = makePool([
        (sql, params) => {
          if (sql.includes('INSERT INTO agent_llm_credentials')) {
            stored.ciphertext = params[1] as string;
            stored.last4 = params[2] as string;
            return { rows: [], rowCount: 1 };
          }
          return undefined;
        },
      ]);
      const router = createAgentRouter(pool, AUTH_SECRET, ENCRYPTION_KEY, MCP_BASE_DOMAIN);
      const chain = getChain(router, 'put', '/me/agent/llm-credential');
      const apiKey = 'sk-ant-api03-ABCDEFGHIJ1234567890';
      const req = makeReq({ headers: authHeader(userToken('user-a')), body: { api_key: apiKey } });
      const res = makeRes();
      await chain(req, res);

      expect(res._status).toBe(200);
      const body = res._json as any;
      expect(body).toMatchObject({ configured: true, kind: 'api_key', last4: '7890', provider: 'anthropic' });
      // The raw key is never echoed back.
      expect(JSON.stringify(body)).not.toContain(apiKey);
      // Stored ciphertext is encrypted (not the plaintext) and decrypts back.
      expect(stored.ciphertext).not.toContain(apiKey);
      expect(decryptSecret(stored.ciphertext, ENCRYPTION_KEY)).toBe(apiKey);
      expect(stored.last4).toBe('7890');
    });

    it('accepts an opencode key + model and stores provider/model', async () => {
      const stored: { provider?: string; model?: string } = {};
      const { pool } = makePool([
        (sql, params) => {
          if (sql.includes('INSERT INTO agent_llm_credentials')) {
            stored.provider = params[3] as string;
            stored.model = params[4] as string;
            return { rows: [], rowCount: 1 };
          }
          return undefined;
        },
      ]);
      const router = createAgentRouter(pool, AUTH_SECRET, ENCRYPTION_KEY, MCP_BASE_DOMAIN);
      const chain = getChain(router, 'put', '/me/agent/llm-credential');
      const req = makeReq({
        headers: authHeader(userToken('user-a')),
        body: { api_key: 'zen-live-key-abcdef123456', provider: 'opencode', model: 'deepseek-v4-flash-free' },
      });
      const res = makeRes();
      await chain(req, res);
      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({ configured: true, provider: 'opencode', model: 'deepseek-v4-flash-free' });
      expect(stored.provider).toBe('opencode');
      expect(stored.model).toBe('deepseek-v4-flash-free');
    });

    it('rejects a model not in the provider catalog', async () => {
      const { pool, query } = makePool([]);
      const router = createAgentRouter(pool, AUTH_SECRET, ENCRYPTION_KEY, MCP_BASE_DOMAIN);
      const chain = getChain(router, 'put', '/me/agent/llm-credential');
      const req = makeReq({
        headers: authHeader(userToken('user-a')),
        body: { api_key: 'zen-live-key-abcdef123456', provider: 'opencode', model: 'gpt-9-ultra' },
      });
      const res = makeRes();
      await chain(req, res);
      expect(res._status).toBe(400);
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('GET /me/agent/llm-credential', () => {
    it('returns configured:false when none stored', async () => {
      const { pool } = makePool([
        (sql) => (sql.includes('FROM agent_llm_credentials') ? { rows: [] } : undefined),
      ]);
      const router = createAgentRouter(pool, AUTH_SECRET, ENCRYPTION_KEY, MCP_BASE_DOMAIN);
      const chain = getChain(router, 'get', '/me/agent/llm-credential');
      const req = makeReq({ headers: authHeader(userToken('user-a')) });
      const res = makeRes();
      await chain(req, res);
      expect(res._json).toEqual({ configured: false });
    });

    it('returns status only (kind + last4), never the secret', async () => {
      const { pool } = makePool([
        (sql) => (sql.includes('FROM agent_llm_credentials')
          ? { rows: [{ kind: 'api_key', last4: '7890', provider: 'opencode', model: 'deepseek-v4-flash-free', base_url: null }] }
          : undefined),
      ]);
      const router = createAgentRouter(pool, AUTH_SECRET, ENCRYPTION_KEY, MCP_BASE_DOMAIN);
      const chain = getChain(router, 'get', '/me/agent/llm-credential');
      const req = makeReq({ headers: authHeader(userToken('user-a')) });
      const res = makeRes();
      await chain(req, res);
      expect(res._json).toEqual({ configured: true, kind: 'api_key', last4: '7890', provider: 'opencode', model: 'deepseek-v4-flash-free', base_url: null });
    });
  });

  describe('DELETE /me/agent/llm-credential', () => {
    it('clears the stored credential', async () => {
      const { pool, query } = makePool([
        (sql) => (sql.includes('DELETE FROM agent_llm_credentials') ? { rows: [], rowCount: 1 } : undefined),
      ]);
      const router = createAgentRouter(pool, AUTH_SECRET, ENCRYPTION_KEY, MCP_BASE_DOMAIN);
      const chain = getChain(router, 'delete', '/me/agent/llm-credential');
      const req = makeReq({ headers: authHeader(userToken('user-a')) });
      const res = makeRes();
      await chain(req, res);
      expect(res._json).toEqual({ configured: false });
      const call = query.mock.calls.find((c) => String(c[0]).includes('DELETE FROM agent_llm_credentials'));
      expect(call![1]).toEqual(['user-a']);
    });
  });

  // -------------------------------------------------------------------------
  // P4/P5: runtime control + lifecycle
  // -------------------------------------------------------------------------
  /** A mock orchestrator client recording calls + returning a canned runtime. */
  function makeOrchestrator(runtime: Record<string, unknown> = { status: 'running' }) {
    return {
      provision: vi.fn(async (_u: string, _t: string) => runtime),
      stop: vi.fn(async (_u: string) => ({ status: 'stopped' })),
      status: vi.fn(async (_u: string) => runtime),
    };
  }

  describe('POST /me/agent/provision', () => {
    it('400s when no llm-credential is configured (orchestrator NOT called)', async () => {
      const orch = makeOrchestrator();
      const { pool } = makePool([
        (sql) => (sql.includes('FROM agent_llm_credentials') ? { rows: [] } : undefined),
      ]);
      const router = createAgentRouter(pool, AUTH_SECRET, ENCRYPTION_KEY, MCP_BASE_DOMAIN, orch);
      const chain = getChain(router, 'post', '/me/agent/provision');
      const req = makeReq({ headers: authHeader(userToken('user-a')) });
      const res = makeRes();
      await chain(req, res);

      expect(res._status).toBe(400);
      expect((res._json as any).error).toContain('LLM API key');
      expect(orch.provision).not.toHaveBeenCalled();
    });

    it('mints a token, calls the orchestrator, and upserts the runtime as running', async () => {
      const orch = makeOrchestrator({ status: 'running', container_id: 'c-1', host: 'agent-host-1' });
      let mintedHash = '';
      let upserted: unknown[] = [];
      const { pool, query } = makePool([
        (sql) => (sql.includes('FROM agent_llm_credentials') ? { rows: [{ '?column?': 1 }] } : undefined),
        (sql, params) => {
          if (sql.includes('INSERT INTO agent_credentials')) {
            mintedHash = params[2] as string;
            return { rows: [{ id: 'cred-9', created_at: 'x' }] };
          }
          return undefined;
        },
        (sql, params) => {
          if (sql.includes('INSERT INTO agent_runtimes')) {
            upserted = params;
            return { rows: [], rowCount: 1 };
          }
          return undefined;
        },
      ]);
      const router = createAgentRouter(pool, AUTH_SECRET, ENCRYPTION_KEY, MCP_BASE_DOMAIN, orch);
      const chain = getChain(router, 'post', '/me/agent/provision');
      const req = makeReq({ headers: authHeader(userToken('user-a', 'admin')) });
      const res = makeRes();
      await chain(req, res);

      expect(res._status).toBe(200);
      expect((res._json as any).runtime).toEqual({
        status: 'running', container_id: 'c-1', host: 'agent-host-1', last_seen_at: null, last_error: null,
      });
      // orchestrator was handed the freshly-minted token (not its hash).
      expect(orch.provision).toHaveBeenCalledTimes(1);
      const [uid, token] = orch.provision.mock.calls[0];
      expect(uid).toBe('user-a');
      expect(crypto.createHash('sha256').update(token).digest('hex')).toBe(mintedHash);
      // upsert recorded status running, scoped to the caller.
      expect(upserted[0]).toBe('user-a');
      expect(upserted[3]).toBe('running');
      // The llm-credential check was scoped to the caller.
      const credCall = query.mock.calls.find((c) => String(c[0]).includes('FROM agent_llm_credentials'));
      expect(credCall![1]).toEqual(['user-a']);
    });

    it('503s with a clear message when the orchestrator is not configured', async () => {
      const orch = {
        provision: vi.fn(async () => { throw new OrchestratorNotConfiguredError(); }),
        stop: vi.fn(),
        status: vi.fn(),
      };
      const { pool } = makePool([
        (sql) => (sql.includes('FROM agent_llm_credentials') ? { rows: [{ x: 1 }] } : undefined),
        (sql) => (sql.includes('INSERT INTO agent_credentials') ? { rows: [{ id: 'c', created_at: 'x' }] } : undefined),
      ]);
      const router = createAgentRouter(pool, AUTH_SECRET, ENCRYPTION_KEY, MCP_BASE_DOMAIN, orch as any);
      const chain = getChain(router, 'post', '/me/agent/provision');
      const req = makeReq({ headers: authHeader(userToken('user-a')) });
      const res = makeRes();
      await chain(req, res);
      expect(res._status).toBe(503);
    });
  });

  describe('POST /me/agent/stop', () => {
    it('calls the orchestrator and marks the runtime stopped', async () => {
      const orch = makeOrchestrator();
      let upserted: unknown[] = [];
      const { pool } = makePool([
        (sql, params) => {
          if (sql.includes('INSERT INTO agent_runtimes')) { upserted = params; return { rows: [], rowCount: 1 }; }
          return undefined;
        },
      ]);
      const router = createAgentRouter(pool, AUTH_SECRET, ENCRYPTION_KEY, MCP_BASE_DOMAIN, orch);
      const chain = getChain(router, 'post', '/me/agent/stop');
      const req = makeReq({ headers: authHeader(userToken('user-a')) });
      const res = makeRes();
      await chain(req, res);

      expect(res._status).toBe(200);
      expect((res._json as any).runtime.status).toBe('stopped');
      expect(orch.stop).toHaveBeenCalledWith('user-a');
      expect(upserted[0]).toBe('user-a');
      expect(upserted[3]).toBe('stopped');
    });
  });

  describe('GET /me/agent/runtime', () => {
    it('returns the caller row scoped by user_id', async () => {
      const { pool, query } = makePool([
        (sql) => (sql.includes('FROM agent_runtimes')
          ? { rows: [{ status: 'running', container_id: 'c1', host: 'h1', last_seen_at: 't', last_error: null }] }
          : undefined),
      ]);
      const router = createAgentRouter(pool, AUTH_SECRET, ENCRYPTION_KEY, MCP_BASE_DOMAIN);
      const chain = getChain(router, 'get', '/me/agent/runtime');
      const req = makeReq({ headers: authHeader(userToken('user-a')) });
      const res = makeRes();
      await chain(req, res);

      expect((res._json as any).runtime.status).toBe('running');
      const call = query.mock.calls.find((c) => String(c[0]).includes('FROM agent_runtimes'));
      expect(String(call![0])).toMatch(/WHERE user_id = \$1/);
      expect(call![1]).toEqual(['user-a']);
    });

    it('returns {status:none} when there is no row', async () => {
      const { pool } = makePool([
        (sql) => (sql.includes('FROM agent_runtimes') ? { rows: [] } : undefined),
      ]);
      const router = createAgentRouter(pool, AUTH_SECRET, ENCRYPTION_KEY, MCP_BASE_DOMAIN);
      const chain = getChain(router, 'get', '/me/agent/runtime');
      const req = makeReq({ headers: authHeader(userToken('user-a')) });
      const res = makeRes();
      await chain(req, res);
      expect((res._json as any).runtime.status).toBe('none');
    });
  });

  describe('POST /me/agent/heartbeat', () => {
    it('bumps last_seen_at + sets running, scoped to the caller', async () => {
      let hb: unknown[] = [];
      const { pool } = makePool([
        (sql, params) => {
          if (sql.includes('INSERT INTO agent_runtimes')) { hb = params; return { rows: [], rowCount: 1 }; }
          return undefined;
        },
      ]);
      const router = createAgentRouter(pool, AUTH_SECRET, ENCRYPTION_KEY, MCP_BASE_DOMAIN);
      const chain = getChain(router, 'post', '/me/agent/heartbeat');
      const req = makeReq({ headers: authHeader(userToken('agent-user')) });
      const res = makeRes();
      await chain(req, res);

      expect(res._json).toEqual({ ok: true });
      expect(hb[0]).toBe('agent-user');
      // The heartbeat upsert sets last_seen_at = now() + status running, scoped to user_id.
      const sql = String((pool.query as any).mock.calls.find((c: any) => String(c[0]).includes('agent_runtimes'))[0]);
      expect(sql).toMatch(/last_seen_at = now\(\)/);
      expect(sql).toMatch(/status = 'running'/);
    });
  });

  describe('DELETE /me/agent/credentials/:id — lifecycle stop on revoke', () => {
    it('best-effort stops the runtime after a successful revoke', async () => {
      const orch = makeOrchestrator();
      const { pool } = makePool([
        (sql) => (sql.includes('UPDATE agent_credentials') ? { rows: [{ id: 'c1' }], rowCount: 1 } : undefined),
        (sql) => (sql.includes('INSERT INTO agent_runtimes') ? { rows: [], rowCount: 1 } : undefined),
      ]);
      const router = createAgentRouter(pool, AUTH_SECRET, ENCRYPTION_KEY, MCP_BASE_DOMAIN, orch);
      const chain = getChain(router, 'delete', '/me/agent/credentials/:id');
      const req = makeReq({ headers: authHeader(userToken('user-a')), params: { id: 'c1' } });
      const res = makeRes();
      await chain(req, res);

      expect(res._status).toBe(200);
      expect((res._json as any).revoked).toBe(true);
      expect(orch.stop).toHaveBeenCalledWith('user-a');
    });

    it('still revokes (200) if the orchestrator stop fails', async () => {
      const orch = {
        stop: vi.fn(async () => { throw new Error('orchestrator down'); }),
        provision: vi.fn(), status: vi.fn(),
      };
      const { pool } = makePool([
        (sql) => (sql.includes('UPDATE agent_credentials') ? { rows: [{ id: 'c1' }], rowCount: 1 } : undefined),
      ]);
      const router = createAgentRouter(pool, AUTH_SECRET, ENCRYPTION_KEY, MCP_BASE_DOMAIN, orch as any);
      const chain = getChain(router, 'delete', '/me/agent/credentials/:id');
      const req = makeReq({ headers: authHeader(userToken('user-a')), params: { id: 'c1' } });
      const res = makeRes();
      await chain(req, res);
      expect(res._status).toBe(200);
      expect((res._json as any).revoked).toBe(true);
    });
  });
});
