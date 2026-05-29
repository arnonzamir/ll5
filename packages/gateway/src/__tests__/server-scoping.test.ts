import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Mock the external boundaries: pg.Pool and @elastic/elasticsearch Client.
// createApp() constructs both internally, so we intercept the constructors and
// hand back recordable fakes. Nothing else in server.ts is mocked.
// ---------------------------------------------------------------------------

const esMock = {
  search: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  index: vi.fn(),
  indices: { exists: vi.fn().mockResolvedValue(true), create: vi.fn() },
};

const poolMock = {
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  connect: vi.fn(),
  on: vi.fn(),
};

vi.mock('@elastic/elasticsearch', () => ({
  Client: function Client() { return esMock; },
}));

vi.mock('pg', () => {
  function Pool() { return poolMock; }
  return { default: { Pool }, Pool };
});

// Avoid filesystem + scheduler side effects from createApp's static/uploads setup.
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return { ...actual, default: { ...actual, mkdirSync: vi.fn() }, mkdirSync: vi.fn() };
});

const { createApp } = await import('../server.js');
import type { EnvConfig } from '../utils/env.js';

function testConfig(): EnvConfig {
  return {
    port: 0,
    elasticsearchUrl: 'http://es.test',
    webhookTokens: {},
    logLevel: 'error',
    nodeEnv: 'test',
    geocodingApiKey: undefined,
    authSecret: 'test-secret-key-at-least-32-characters-long!!',
    apiKey: undefined,
    databaseUrl: 'postgres://x',
    googleMcpUrl: undefined,
    googleMcpApiKey: undefined,
    mcpHealthUrls: {},
    calendarReviewStartHour: 7,
    calendarReviewEndHour: 22,
    calendarReviewIntervalMinutes: 120,
    calendarReviewTimezone: 'UTC',
    dailyReviewHour: 7,
    ticklerAlertIntervalMinutes: 60,
    gtdHealthIntervalHours: 4,
    weeklyReviewDay: 5,
    weeklyReviewHour: 14,
    messageBatchIntervalMinutes: 30,
    journalConsolidationHour: 2,
    whatsappWebhookSecret: 'test-webhook-secret-at-least-32-chars-long!!',
  } as EnvConfig;
}

/** Pull the final (post-auth) handler for a method+path off the express app. */
function getHandler(app: any, method: string, path: string): (req: Request, res: Response) => Promise<unknown> {
  const stack = (app._router ?? app.router).stack;
  for (const layer of stack) {
    const route = layer.route;
    if (route && route.path === path && route.methods[method]) {
      const handlers = route.stack.map((s: { handle: Function }) => s.handle);
      return handlers[handlers.length - 1];
    }
  }
  throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
}

function reqAs(userId: string, overrides: Partial<Request> = {}): Request {
  const r = { headers: {}, query: {}, body: {}, params: {}, ...overrides } as any;
  r.userId = userId;
  return r as Request;
}

function makeRes(): Response & { _status: number; _json: unknown; _ended: boolean } {
  const res: any = {
    _status: 200,
    _json: null,
    _ended: false,
    status(code: number) { this._status = code; return this; },
    json(data: unknown) { this._json = data; return this; },
    setHeader() { return this; },
    end() { this._ended = true; return this; },
  };
  return res;
}

let app: any;

beforeEach(() => {
  vi.clearAllMocks();
  poolMock.query.mockResolvedValue({ rows: [], rowCount: 0 });
  esMock.search.mockResolvedValue({ hits: { hits: [], total: { value: 0 } } });
  esMock.get.mockResolvedValue({ _source: {} });
  esMock.update.mockResolvedValue({ result: 'updated' });
  app = createApp(testConfig()).app;
});

// ---------------------------------------------------------------------------
// GET /journal — must scope to user_id
// ---------------------------------------------------------------------------
describe('GET /journal scoping', () => {
  it('filters the ES query by the caller user_id', async () => {
    const handler = getHandler(app, 'get', '/journal');
    await handler(reqAs('owner-1'), makeRes());

    expect(esMock.search).toHaveBeenCalledTimes(1);
    const arg = esMock.search.mock.calls[0][0] as any;
    const filters = (arg.query.bool.filter ?? []) as Array<Record<string, any>>;
    const userTerm = filters.find((f) => f.term && f.term.user_id !== undefined);
    expect(userTerm, 'journal query must include a user_id term filter').toBeDefined();
    expect(userTerm!.term.user_id).toBe('owner-1');
  });
});

// ---------------------------------------------------------------------------
// PATCH /journal/:id — must verify ownership before update
// ---------------------------------------------------------------------------
describe('PATCH /journal/:id scoping', () => {
  it('returns 404 (not 403) and does NOT update when the entry belongs to another user', async () => {
    // The entry exists but is owned by someone else.
    esMock.get.mockResolvedValue({ _source: { user_id: 'other-owner' } });

    const handler = getHandler(app, 'patch', '/journal/:id');
    const res = makeRes();
    await handler(reqAs('attacker-1', { params: { id: 'entry-x' }, body: { status: 'resolved' } }), res);

    expect(res._status).toBe(404);
    expect(esMock.update).not.toHaveBeenCalled();
  });

  it('updates when the caller owns the entry', async () => {
    esMock.get.mockResolvedValue({ _source: { user_id: 'owner-1' } });

    const handler = getHandler(app, 'patch', '/journal/:id');
    const res = makeRes();
    await handler(reqAs('owner-1', { params: { id: 'entry-x' }, body: { status: 'resolved' } }), res);

    expect(esMock.update).toHaveBeenCalledTimes(1);
    expect(res._json).toEqual({ updated: true });
  });
});

// ---------------------------------------------------------------------------
// GET /sessions/:id — must verify ownership
// ---------------------------------------------------------------------------
describe('GET /sessions/:id scoping', () => {
  it('returns 404 when the session belongs to another user', async () => {
    esMock.get.mockResolvedValue({ _source: { user_id: 'other-owner', session_id: 's1' } });

    const handler = getHandler(app, 'get', '/sessions/:id');
    const res = makeRes();
    await handler(reqAs('attacker-1', { params: { id: 's1' } }), res);

    expect(res._status).toBe(404);
  });

  it('returns the session when the caller owns it', async () => {
    esMock.get.mockResolvedValue({ _source: { user_id: 'owner-1', session_id: 's1' } });

    const handler = getHandler(app, 'get', '/sessions/:id');
    const res = makeRes();
    await handler(reqAs('owner-1', { params: { id: 's1' } }), res);

    expect(res._status).toBe(200);
    expect((res._json as any).session_id).toBe('s1');
  });
});

// ---------------------------------------------------------------------------
// GET /media/:id/links — must scope to user_id
// ---------------------------------------------------------------------------
describe('GET /media/:id/links scoping', () => {
  it('filters the ES query by the caller user_id', async () => {
    const handler = getHandler(app, 'get', '/media/:id/links');
    await handler(reqAs('owner-1', { params: { id: 'media-1' } }), makeRes());

    expect(esMock.search).toHaveBeenCalledTimes(1);
    const arg = esMock.search.mock.calls[0][0] as any;
    const filters = (arg.query.bool.filter ?? []) as Array<Record<string, any>>;
    const userTerm = filters.find((f) => f.term && f.term.user_id !== undefined);
    expect(userTerm, 'media-links query must include a user_id term filter').toBeDefined();
    expect(userTerm!.term.user_id).toBe('owner-1');
  });
});

// ---------------------------------------------------------------------------
// PUT /contact-settings — partial update must not reset omitted fields
// ---------------------------------------------------------------------------
describe('PUT /contact-settings partial update', () => {
  it('binds NULL (not a default) for omitted routing/permission so COALESCE keeps existing', async () => {
    poolMock.query.mockResolvedValue({ rows: [], rowCount: 1 });

    const handler = getHandler(app, 'put', '/contact-settings');
    const res = makeRes();
    // Only display_name supplied — routing/permission omitted.
    await handler(
      reqAs('owner-1', { body: { target_type: 'whatsapp', target_id: 'jid-1', display_name: 'Bob' } }),
      res,
    );

    expect(poolMock.query).toHaveBeenCalled();
    const sql = poolMock.query.mock.calls[0][0] as string;
    const params = poolMock.query.mock.calls[0][1] as unknown[];

    // The UPDATE branch must COALESCE against a param that is NULL when the
    // field was omitted, so the existing value is preserved. BUG (pre-fix):
    // routing/permission COALESCE'd against $4/$5 which defaulted to
    // 'batch'/'input', overwriting the existing value on every partial update.
    // Find which $n the UPDATE clause COALESCEs routing/permission against and
    // assert that bind is NULL.
    const routingMatch = sql.match(/routing = COALESCE\(\$(\d+),/);
    const permissionMatch = sql.match(/permission = COALESCE\(\$(\d+),/);
    expect(routingMatch, 'UPDATE must COALESCE routing against a param').not.toBeNull();
    expect(permissionMatch, 'UPDATE must COALESCE permission against a param').not.toBeNull();
    const routingBind = params[Number(routingMatch![1]) - 1];
    const permissionBind = params[Number(permissionMatch![1]) - 1];
    expect(routingBind, 'omitted routing must bind NULL in the UPDATE branch').toBeNull();
    expect(permissionBind, 'omitted permission must bind NULL in the UPDATE branch').toBeNull();
  });
});
