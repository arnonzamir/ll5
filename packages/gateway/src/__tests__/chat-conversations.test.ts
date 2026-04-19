import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createChatRouter } from '../chat.js';
import type { Request, Response } from 'express';
import type { Pool, PoolClient } from 'pg';

// ---------------------------------------------------------------------------
// Helpers: simulated PG pool + Express handler extraction
// ---------------------------------------------------------------------------

const AUTH_SECRET = 'test-secret-key-for-testing';

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    query: {},
    body: {},
    params: {},
    ...overrides,
  } as unknown as Request;
}

function makeRes() {
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
  };
  return res as unknown as Response & { _status: number; _json: unknown };
}

/** Minimal PG pool mock that drives query responses by matching a substring
 *  in the SQL. Tests declare the routing table; unmatched queries throw. */
type QueryMatcher = (sql: string, params: unknown[]) => { rows: Record<string, unknown>[]; rowCount?: number } | undefined;

function makePool(matchers: QueryMatcher[]): Pool {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      for (const m of matchers) {
        const r = m(sql, params);
        if (r) return r;
      }
      throw new Error(`Unmatched query: ${sql.slice(0, 80)}`);
    }),
    connect: vi.fn(async () => ({
      query: pool.query,
      release: vi.fn(),
    }) as unknown as PoolClient),
    _calls: calls,
  };
  return pool as unknown as Pool & { _calls: typeof calls };
}

function findHandler(router: ReturnType<typeof createChatRouter>, method: string, path: string) {
  const layers = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Function }> } }> }).stack;
  const layer = layers.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  const handlers = layer.route.stack.map((s) => s.handle);
  return handlers[handlers.length - 1] as (req: Request, res: Response) => Promise<unknown>;
}

function reqAs(userId: string, overrides: Partial<Request> = {}): Request {
  const r = makeReq(overrides) as unknown as Request & { userId: string };
  r.userId = userId;
  return r as unknown as Request;
}

// ---------------------------------------------------------------------------
// POST /messages — active-conversation routing and archived-write handling
// ---------------------------------------------------------------------------

describe('POST /chat/messages with unified conversations', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes to the active LL5-native conversation when none supplied', async () => {
    const activeId = 'active-conv-1';
    const insertedMsg = { id: 'msg-1', conversation_id: activeId };

    const pool = makePool([
      // getOrCreateActiveConversation — existing active found
      (sql) => sql.includes('FROM chat_conversations') && sql.includes('archived_at IS NULL')
        ? { rows: [{ conversation_id: activeId }] }
        : undefined,
      // INSERT chat_messages
      (sql) => sql.startsWith('INSERT INTO chat_messages')
        ? { rows: [insertedMsg] }
        : undefined,
    ]);

    const router = createChatRouter(pool, AUTH_SECRET);
    const handler = findHandler(router, 'post', '/messages');

    const req = reqAs('user-1', { body: { channel: 'web', content: 'hello' } });
    const res = makeRes();
    await handler(req, res);

    expect(res._status).toBe(201);
    expect((res._json as { conversation_id: string }).conversation_id).toBe(activeId);
  });

  it('creates an active conversation if the user has none', async () => {
    const newId = 'new-conv-1';
    let selectCalls = 0;

    const pool = makePool([
      (sql) => {
        if (sql.includes('FROM chat_conversations') && sql.includes('archived_at IS NULL')) {
          selectCalls++;
          return { rows: [] }; // no active
        }
        return undefined;
      },
      (sql) => sql.startsWith('INSERT INTO chat_conversations')
        ? { rows: [{ conversation_id: newId }] }
        : undefined,
      (sql) => sql.startsWith('INSERT INTO chat_messages')
        ? { rows: [{ id: 'msg-1', conversation_id: newId }] }
        : undefined,
    ]);

    const router = createChatRouter(pool, AUTH_SECRET);
    const handler = findHandler(router, 'post', '/messages');

    const req = reqAs('user-2', { body: { channel: 'web', content: 'first' } });
    const res = makeRes();
    await handler(req, res);

    expect(res._status).toBe(201);
    expect((res._json as { conversation_id: string }).conversation_id).toBe(newId);
    expect(selectCalls).toBe(1);
  });

  it('reroutes writes to a conversation archived <30s ago and signals rerouted_from', async () => {
    const archivedId = 'archived-conv';
    const activeId = 'active-conv';
    const recentArchival = new Date(Date.now() - 5_000).toISOString(); // 5s ago

    const pool = makePool([
      (sql) => sql.includes('FROM chat_conversations') && sql.includes('WHERE conversation_id = $1')
        ? { rows: [{ archived_at: recentArchival, user_id: 'user-1' }] }
        : undefined,
      (sql) => sql.includes('FROM chat_conversations') && sql.includes('archived_at IS NULL')
        ? { rows: [{ conversation_id: activeId }] }
        : undefined,
      (sql) => sql.startsWith('INSERT INTO chat_messages')
        ? { rows: [{ id: 'msg-r', conversation_id: activeId }] }
        : undefined,
    ]);

    const router = createChatRouter(pool, AUTH_SECRET);
    const handler = findHandler(router, 'post', '/messages');

    const req = reqAs('user-1', {
      body: { channel: 'web', content: 'mid-send', conversation_id: archivedId },
    });
    const res = makeRes();
    await handler(req, res);

    expect(res._status).toBe(201);
    const body = res._json as { conversation_id: string; rerouted_from?: string };
    expect(body.conversation_id).toBe(activeId);
    expect(body.rerouted_from).toBe(archivedId);
  });

  it('returns 409 conversation_archived when the window has passed', async () => {
    const archivedId = 'old-archived';
    const activeId = 'active-id';
    const oldArchival = new Date(Date.now() - 120_000).toISOString(); // 2m ago

    const pool = makePool([
      (sql, params) => sql.includes('WHERE conversation_id = $1') && params[0] === archivedId
        ? { rows: [{ archived_at: oldArchival, user_id: 'user-1' }] }
        : undefined,
      (sql) => sql.includes('archived_at IS NULL')
        ? { rows: [{ conversation_id: activeId }] }
        : undefined,
    ]);

    const router = createChatRouter(pool, AUTH_SECRET);
    const handler = findHandler(router, 'post', '/messages');

    const req = reqAs('user-1', {
      body: { channel: 'web', content: 'stale', conversation_id: archivedId },
    });
    const res = makeRes();
    await handler(req, res);

    expect(res._status).toBe(409);
    const body = res._json as { code: string; active_conversation_id: string };
    expect(body.code).toBe('conversation_archived');
    expect(body.active_conversation_id).toBe(activeId);
  });

  it('leaves WhatsApp conversations alone (external channel, unique conv per remote_jid)', async () => {
    const waConv = 'whatsapp-conv-from-remote-jid';

    const pool = makePool([
      (sql) => sql.startsWith('INSERT INTO chat_messages')
        ? { rows: [{ id: 'wa-1', conversation_id: waConv }] }
        : undefined,
    ]);

    const router = createChatRouter(pool, AUTH_SECRET);
    const handler = findHandler(router, 'post', '/messages');

    const req = reqAs('user-1', {
      body: { channel: 'whatsapp', content: 'hi', conversation_id: waConv },
    });
    const res = makeRes();
    await handler(req, res);

    expect(res._status).toBe(201);
    expect((res._json as { conversation_id: string }).conversation_id).toBe(waConv);
    // Should not have queried chat_conversations at all for WhatsApp
    const calls = (pool as unknown as { _calls: Array<{ sql: string }> })._calls;
    const touchedConvTable = calls.some((c) => c.sql.includes('FROM chat_conversations'));
    expect(touchedConvTable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// POST /messages — reactions
// ---------------------------------------------------------------------------

describe('POST /chat/messages with reactions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accepts a reaction row with content omitted and reply_to_id set', async () => {
    const convId = 'active-1';
    const pool = makePool([
      (sql) => sql.includes('FROM chat_conversations') && sql.includes('archived_at IS NULL')
        ? { rows: [{ conversation_id: convId }] }
        : undefined,
      (sql, params) => {
        if (!sql.startsWith('INSERT INTO chat_messages')) return undefined;
        // content param is at index 5 (user, conv, channel, direction, role, content, status, metadata, reply_to, reaction, display_compact)
        expect(params[5]).toBeNull();
        expect(params[9]).toBe('acknowledge');
        expect(params[8]).toBe('msg-target');
        return { rows: [{ id: 'reaction-1', conversation_id: convId }] };
      },
    ]);

    const router = createChatRouter(pool, AUTH_SECRET);
    const handler = findHandler(router, 'post', '/messages');

    const req = reqAs('user-1', {
      body: { channel: 'web', reaction: 'acknowledge', reply_to_id: 'msg-target' },
    });
    const res = makeRes();
    await handler(req, res);

    expect(res._status).toBe(201);
  });

  it('rejects reaction without reply_to_id', async () => {
    const pool = makePool([]);
    const router = createChatRouter(pool, AUTH_SECRET);
    const handler = findHandler(router, 'post', '/messages');

    const req = reqAs('user-1', { body: { channel: 'web', reaction: 'acknowledge' } });
    const res = makeRes();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect((res._json as { error: string }).error).toContain('reply_to_id');
  });

  it('rejects unknown reaction values', async () => {
    const pool = makePool([]);
    const router = createChatRouter(pool, AUTH_SECRET);
    const handler = findHandler(router, 'post', '/messages');

    const req = reqAs('user-1', {
      body: { channel: 'web', reaction: 'heart', reply_to_id: 'msg-1' },
    });
    const res = makeRes();
    await handler(req, res);

    expect(res._status).toBe(400);
    expect((res._json as { error: string }).error).toContain('Invalid reaction');
  });
});

// ---------------------------------------------------------------------------
// POST /conversations/new — atomic archive + open
// ---------------------------------------------------------------------------

describe('POST /chat/conversations/new', () => {
  beforeEach(() => vi.clearAllMocks());

  it('archives the active conversation and opens a new one atomically', async () => {
    const priorId = 'prior-conv';
    const newId = 'new-conv';
    const txLog: string[] = [];

    const client = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        txLog.push(sql.slice(0, 40));
        if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
        if (sql.startsWith('UPDATE chat_conversations')) {
          expect(params[1]).toBe('summary text');
          return { rows: [{ conversation_id: priorId }] };
        }
        if (sql.startsWith('INSERT INTO chat_conversations')) {
          return { rows: [{ conversation_id: newId, created_at: new Date().toISOString() }] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };

    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(),
    } as unknown as Pool;

    const router = createChatRouter(pool, AUTH_SECRET);
    const handler = findHandler(router, 'post', '/conversations/new');

    const req = reqAs('user-1', { body: { summary: 'summary text' } });
    const res = makeRes();
    await handler(req, res);

    expect(res._status).toBe(201);
    const body = res._json as { conversation_id: string; prior_id: string | null };
    expect(body.conversation_id).toBe(newId);
    expect(body.prior_id).toBe(priorId);
    expect(txLog.includes('BEGIN')).toBe(true);
    expect(txLog.includes('COMMIT')).toBe(true);
  });

  it('succeeds even when no prior active exists (first conversation)', async () => {
    const newId = 'brand-new';
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
        if (sql.startsWith('UPDATE chat_conversations')) return { rows: [] }; // none archived
        if (sql.startsWith('INSERT INTO chat_conversations')) {
          return { rows: [{ conversation_id: newId, created_at: new Date().toISOString() }] };
        }
        throw new Error(`Unexpected: ${sql}`);
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(),
    } as unknown as Pool;

    const router = createChatRouter(pool, AUTH_SECRET);
    const handler = findHandler(router, 'post', '/conversations/new');

    const req = reqAs('user-1', { body: { summary: 'nothing much' } });
    const res = makeRes();
    await handler(req, res);

    expect(res._status).toBe(201);
    expect((res._json as { prior_id: string | null }).prior_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PATCH /messages/:id — reaction upsert
// ---------------------------------------------------------------------------

describe('PATCH /chat/messages/:id reactions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('upserts a reaction (delete existing, insert new)', async () => {
    const calls: Array<{ sql: string }> = [];
    const pool = makePool([
      (sql) => {
        calls.push({ sql });
        if (sql.includes('SELECT channel, conversation_id FROM chat_messages')) {
          return { rows: [{ channel: 'web', conversation_id: 'conv-1' }] };
        }
        if (sql.startsWith('DELETE FROM chat_messages')) return { rows: [], rowCount: 0 };
        if (sql.startsWith('INSERT INTO chat_messages')) return { rows: [{ id: 'reaction-1' }] };
        return undefined;
      },
    ]);

    const router = createChatRouter(pool, AUTH_SECRET);
    const handler = findHandler(router, 'patch', '/messages/:id');

    const req = reqAs('user-1', {
      params: { id: 'target-msg' },
      body: { reaction: 'agree' },
    });
    const res = makeRes();
    await handler(req, res);

    expect(res._status).toBe(201);
    const body = res._json as { id: string; reaction: string };
    expect(body.reaction).toBe('agree');
    expect(calls.some((c) => c.sql.startsWith('DELETE FROM chat_messages'))).toBe(true);
    expect(calls.some((c) => c.sql.startsWith('INSERT INTO chat_messages'))).toBe(true);
  });

  it('removes the reaction when reaction is null', async () => {
    let deleted = false;
    const pool = makePool([
      (sql) => sql.includes('SELECT channel, conversation_id FROM chat_messages')
        ? { rows: [{ channel: 'web', conversation_id: 'conv-1' }] }
        : undefined,
      (sql) => {
        if (sql.startsWith('DELETE FROM chat_messages')) {
          deleted = true;
          return { rows: [], rowCount: 1 };
        }
        return undefined;
      },
    ]);

    const router = createChatRouter(pool, AUTH_SECRET);
    const handler = findHandler(router, 'patch', '/messages/:id');

    const req = reqAs('user-1', {
      params: { id: 'target-msg' },
      body: { reaction: null },
    });
    const res = makeRes();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect((res._json as { removed: boolean }).removed).toBe(true);
    expect(deleted).toBe(true);
  });

  it('rejects invalid reaction value', async () => {
    const pool = makePool([]);
    const router = createChatRouter(pool, AUTH_SECRET);
    const handler = findHandler(router, 'patch', '/messages/:id');

    const req = reqAs('user-1', {
      params: { id: 'target-msg' },
      body: { reaction: 'love' },
    });
    const res = makeRes();
    await handler(req, res);

    expect(res._status).toBe(400);
  });

  it('returns 404 when target message not found', async () => {
    const pool = makePool([
      (sql) => sql.includes('SELECT channel, conversation_id FROM chat_messages')
        ? { rows: [] }
        : undefined,
    ]);

    const router = createChatRouter(pool, AUTH_SECRET);
    const handler = findHandler(router, 'patch', '/messages/:id');

    const req = reqAs('user-1', {
      params: { id: 'missing' },
      body: { reaction: 'agree' },
    });
    const res = makeRes();
    await handler(req, res);

    expect(res._status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /conversations/search — ES first, ILIKE fallback
// ---------------------------------------------------------------------------

describe('GET /chat/conversations/search', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns ES results when available', async () => {
    const pool = makePool([
      (sql) => sql.includes('FROM chat_conversations') && sql.includes('ANY($2::uuid[])')
        ? { rows: [{ conversation_id: 'conv-a', title: 'T', summary: 'S' }] }
        : undefined,
    ]);

    const esClient = {
      search: vi.fn(async () => ({
        hits: {
          hits: [
            {
              _source: {
                conversation_id: 'conv-a',
                content: 'morning plan',
                created_at: new Date().toISOString(),
              },
              highlight: { content: ['<em>morning</em> plan'] },
            },
          ],
        },
      })),
    };

    const router = createChatRouter(pool, AUTH_SECRET, esClient as never);
    const handler = findHandler(router, 'get', '/conversations/search');

    const req = reqAs('user-1', { query: { q: 'morning' } });
    const res = makeRes();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { backend: string; results: Array<{ conversation_id: string; snippet: string }> };
    expect(body.backend).toBe('es');
    expect(body.results[0].conversation_id).toBe('conv-a');
    expect(body.results[0].snippet).toContain('<em>');
  });

  it('falls back to ILIKE when ES throws', async () => {
    const pool = makePool([
      (sql) => sql.includes('WITH recent AS')
        ? { rows: [{
            conversation_id: 'conv-b',
            snippet: 'lunch tomorrow',
            matched_at: new Date().toISOString(),
            title: null,
          }] }
        : undefined,
    ]);

    const esClient = {
      search: vi.fn(async () => { throw new Error('ES down'); }),
    };

    const router = createChatRouter(pool, AUTH_SECRET, esClient as never);
    const handler = findHandler(router, 'get', '/conversations/search');

    const req = reqAs('user-1', { query: { q: 'lunch' } });
    const res = makeRes();
    await handler(req, res);

    expect(res._status).toBe(200);
    const body = res._json as { backend: string; results: unknown[] };
    expect(body.backend).toBe('ilike');
    expect(body.results).toHaveLength(1);
  });

  it('requires q parameter of at least 2 chars', async () => {
    const pool = makePool([]);
    const router = createChatRouter(pool, AUTH_SECRET);
    const handler = findHandler(router, 'get', '/conversations/search');

    const req = reqAs('user-1', { query: { q: 'a' } });
    const res = makeRes();
    await handler(req, res);

    expect(res._status).toBe(400);
  });
});
