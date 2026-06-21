import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

// Mirror the server-scoping harness: intercept pg.Pool + ES Client constructors.
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

function makeRes(): Response & { _status: number; _json: unknown } {
  const res: any = {
    _status: 200,
    _json: null,
    status(code: number) { this._status = code; return this; },
    json(data: unknown) { this._json = data; return this; },
    setHeader() { return this; },
    end() { return this; },
  };
  return res;
}

let app: any;

beforeEach(() => {
  vi.clearAllMocks();
  esMock.search.mockResolvedValue({ hits: { hits: [], total: { value: 0 } } });
  app = createApp(testConfig()).app;
});

describe('GET /geofences', () => {
  it('builds geofences from places and FILTERS OUT places with no coordinates', async () => {
    esMock.search.mockResolvedValue({
      hits: {
        hits: [
          { _id: 'p-home', _source: { name: 'Home', geo: { lat: 32.1, lon: 34.8 }, radius_m: 150 } },
          // No geo → must be filtered out (the app rejects null lat/lon).
          { _id: 'p-nogeo', _source: { name: 'Idea Place' } },
          // radius_m absent → null allowed.
          { _id: 'p-gym', _source: { name: 'Gym', geo: { lat: 32.2, lon: 34.9 } } },
        ],
      },
    });

    const handler = getHandler(app, 'get', '/geofences');
    const res = makeRes();
    await handler(reqAs('owner-1'), res);

    const body = res._json as Array<Record<string, unknown>>;
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2); // p-nogeo filtered out
    expect(body.map((g) => g.place_id)).toEqual(['p-home', 'p-gym']);

    const home = body.find((g) => g.place_id === 'p-home')!;
    expect(home).toEqual({ place_id: 'p-home', name: 'Home', lat: 32.1, lon: 34.8, radius_m: 150 });

    const gym = body.find((g) => g.place_id === 'p-gym')!;
    expect(gym.radius_m).toBeNull(); // null allowed when the doc has no radius
  });

  it('scopes the ES query to the caller user_id', async () => {
    const handler = getHandler(app, 'get', '/geofences');
    await handler(reqAs('owner-9'), makeRes());

    expect(esMock.search).toHaveBeenCalledTimes(1);
    const arg = esMock.search.mock.calls[0][0] as any;
    expect(arg.index).toBe('ll5_knowledge_places');
    const filters = (arg.query.bool.filter ?? []) as Array<Record<string, any>>;
    const userTerm = filters.find((f) => f.term && f.term.user_id !== undefined);
    expect(userTerm!.term.user_id).toBe('owner-9');
  });

  it('returns an empty array (never 500) when the places index is missing', async () => {
    esMock.search.mockRejectedValue(new Error('index_not_found_exception'));
    const handler = getHandler(app, 'get', '/geofences');
    const res = makeRes();
    await handler(reqAs('owner-1'), res);
    expect(res._json).toEqual([]);
  });
});
