import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';

const esMock = {
  search: vi.fn().mockResolvedValue({ hits: { hits: [], total: { value: 0 } } }),
  get: vi.fn(),
  update: vi.fn(),
  index: vi.fn(),
  indices: { exists: vi.fn().mockResolvedValue(true), create: vi.fn() },
};

// Pool whose device_commands poll NEVER reaches a terminal state, so the route
// would otherwise poll for the full timeout. We use it to prove the loop aborts
// when the client disconnects.
const poolMock = {
  query: vi.fn(),
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
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return { ...actual, default: { ...actual, mkdirSync: vi.fn() }, mkdirSync: vi.fn() };
});

const { createApp } = await import('../server.js');
import type { EnvConfig } from '../utils/env.js';

function testConfig(): EnvConfig {
  return {
    port: 0, elasticsearchUrl: 'http://es.test', webhookTokens: {}, logLevel: 'error',
    nodeEnv: 'test', geocodingApiKey: undefined,
    authSecret: 'test-secret-key-at-least-32-characters-long!!', apiKey: undefined,
    databaseUrl: 'postgres://x', googleMcpUrl: undefined, googleMcpApiKey: undefined,
    mcpHealthUrls: {}, calendarReviewStartHour: 7, calendarReviewEndHour: 22,
    calendarReviewIntervalMinutes: 120, calendarReviewTimezone: 'UTC', dailyReviewHour: 7,
    ticklerAlertIntervalMinutes: 60, gtdHealthIntervalHours: 4, weeklyReviewDay: 5,
    weeklyReviewHour: 14, messageBatchIntervalMinutes: 30, journalConsolidationHour: 2,
    whatsappWebhookSecret: 'test-webhook-secret-at-least-32-chars-long!!',
  } as EnvConfig;
}

function getHandler(app: any, method: string, path: string) {
  const stack = (app._router ?? app.router).stack;
  for (const layer of stack) {
    const route = layer.route;
    if (route && route.path === path && route.methods[method]) {
      const handlers = route.stack.map((s: any) => s.handle);
      return handlers[handlers.length - 1] as (req: Request, res: Response) => Promise<unknown>;
    }
  }
  throw new Error(`Route not found: ${method} ${path}`);
}

function reqAs(userId: string, body: Record<string, unknown>) {
  const closeHandlers: Array<() => void> = [];
  const r: any = {
    headers: {}, query: {}, params: {}, body, userId,
    on: vi.fn((event: string, cb: () => void) => {
      if (event === 'close') closeHandlers.push(cb);
    }),
    _fireClose() { closeHandlers.forEach((c) => c()); },
  };
  return r as Request & { _fireClose: () => void };
}

function makeRes() {
  const r: any = {
    _status: 200, _json: null, _ended: false,
    status(c: number) { this._status = c; return this; },
    json(d: unknown) { this._json = d; return this; },
    setHeader() { return this; },
    end() { this._ended = true; return this; },
  };
  return r as Response & { _status: number };
}

describe('POST /availability/check — abort on client disconnect', () => {
  let app: any;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // queueDeviceCommand INSERT returns an id; poll SELECT stays pending forever.
    poolMock.query.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO device_commands')) {
        return { rows: [{ id: 'cmd-1' }], rowCount: 1 };
      }
      return { rows: [{ status: 'pending', result_data: null, error: null }] };
    });
    app = createApp(testConfig()).app;
  });
  afterEach(() => vi.useRealTimers());

  it('registers a req close handler and stops polling once the client disconnects', async () => {
    const handler = getHandler(app, 'post', '/availability/check');
    const req = reqAs('user-1', {
      from: '2026-05-29T00:00:00Z',
      to: '2026-05-29T23:59:59Z',
      accounts: ['acct-1'],
    });
    const res = makeRes();

    const done = handler(req, res);

    // Let the first poll iteration run.
    await vi.advanceTimersByTimeAsync(600);
    // BUG: the route never registers a close handler, so req.on('close') is
    // never called for the abort. With the fix it must be registered.
    expect((req.on as any)).toHaveBeenCalledWith('close', expect.any(Function));

    // Disconnect the client; the loop must abort instead of polling for 30s.
    const queryCountAtClose = poolMock.query.mock.calls.length;
    req._fireClose();
    await vi.advanceTimersByTimeAsync(5000);
    const queryCountAfter = poolMock.query.mock.calls.length;

    // After close, no meaningful additional polling (allow at most one in-flight).
    expect(queryCountAfter - queryCountAtClose).toBeLessThanOrEqual(1);

    await vi.advanceTimersByTimeAsync(31000);
    await done;
  });
});
