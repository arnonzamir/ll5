import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

// Mock external boundaries (same pattern as server-scoping.test.ts).
const esMock = {
  search: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  index: vi.fn(),
  count: vi.fn(),
  deleteByQuery: vi.fn(),
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

// No real geocoding.
vi.mock('../utils/geocoding.js', () => ({ reverseGeocode: vi.fn(async () => null) }));

const { createApp } = await import('../server.js');
import type { EnvConfig } from '../utils/env.js';

const TOKEN = 'webhook-token-1';
const USER = 'owner-1';

function testConfig(): EnvConfig {
  return {
    port: 0,
    elasticsearchUrl: 'http://es.test',
    webhookTokens: { [TOKEN]: USER },
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

function makeRes(): Response & { _status: number; _json: any } {
  const res: any = {
    _status: 200,
    _json: null,
    status(c: number) { this._status = c; return this; },
    json(d: unknown) { this._json = d; return this; },
    setHeader() { return this; },
    end() { return this; },
  };
  return res;
}

let app: any;

beforeEach(() => {
  vi.clearAllMocks();
  poolMock.query.mockResolvedValue({ rows: [], rowCount: 0 });
  // getPreviousLocation / matchKnownPlace / etc. → no hits.
  esMock.search.mockResolvedValue({ hits: { hits: [], total: { value: 0 } } });
  esMock.get.mockRejectedValue({ meta: { statusCode: 404 } });
  esMock.index.mockResolvedValue({ result: 'created' });
  esMock.count.mockResolvedValue({ count: 0 });
  esMock.deleteByQuery.mockResolvedValue({ deleted: 0 });
  app = createApp(testConfig()).app;
});

/** Timestamps of every doc indexed into ll5_awareness_locations, in call order. */
function indexedLocationTimestamps(): string[] {
  return esMock.index.mock.calls
    .map((c) => c[0] as { index: string; document: { timestamp?: string } })
    .filter((a) => a.index === 'll5_awareness_locations')
    .map((a) => a.document.timestamp as string);
}

describe('POST /webhook — G1/G2 location batch ordering', () => {
  it('ingests out-of-order location points in ascending timestamp order', async () => {
    const handler = getHandler(app, 'post', '/webhook');
    const res = makeRes();
    // Deliberately shuffled.
    const items = [
      { type: 'location', timestamp: '2026-05-30T10:02:00.000Z', lat: 32.0, lon: 34.0 },
      { type: 'location', timestamp: '2026-05-30T10:00:00.000Z', lat: 32.0, lon: 34.0 },
      { type: 'location', timestamp: '2026-05-30T10:01:00.000Z', lat: 32.0, lon: 34.0 },
    ];
    await handler(
      { headers: { authorization: `Bearer ll5.x` }, params: { token: TOKEN }, body: { items } } as any,
      res,
    );

    expect(res._json.accepted).toBe(3);
    expect(indexedLocationTimestamps()).toEqual([
      '2026-05-30T10:00:00.000Z',
      '2026-05-30T10:01:00.000Z',
      '2026-05-30T10:02:00.000Z',
    ]);
  });

  it('preserves results bookkeeping at original indices with mixed item types', async () => {
    const handler = getHandler(app, 'post', '/webhook');
    const res = makeRes();
    const items = [
      { type: 'location', timestamp: '2026-05-30T10:02:00.000Z', lat: 32.0, lon: 34.0 }, // idx 0
      { type: 'phone_status', timestamp: '2026-05-30T10:00:30.000Z', battery_pct: 80, is_charging: false }, // idx 1
      { type: 'location', timestamp: '2026-05-30T10:00:00.000Z', lat: 32.0, lon: 34.0 }, // idx 2
    ];
    await handler(
      { headers: {}, params: { token: TOKEN }, body: { items } } as any,
      res,
    );

    const results = res._json.results as Array<{ index: number; type: string; status: string }>;
    expect(results).toHaveLength(3);
    // Results stay aligned to original indices regardless of processing order.
    expect(results[0]).toMatchObject({ index: 0, type: 'location', status: 'ok' });
    expect(results[1]).toMatchObject({ index: 1, type: 'phone_status', status: 'ok' });
    expect(results[2]).toMatchObject({ index: 2, type: 'location', status: 'ok' });
    // Locations still ingested chronologically.
    expect(indexedLocationTimestamps()).toEqual([
      '2026-05-30T10:00:00.000Z',
      '2026-05-30T10:02:00.000Z',
    ]);
  });
});
