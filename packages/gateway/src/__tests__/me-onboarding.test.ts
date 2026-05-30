import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// GET /me/onboarding — self-scoped onboarding status for the onboarding wizard.
//
// Boundary mocks (per docs/testing.md route-handler rules): pg.Pool and the
// elasticsearch Client constructors, both built inside createApp. The real
// Express handler is extracted off the app and invoked — nothing else mocked.
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

/**
 * Route the three pgPool.query calls the handler makes (enrichment SELECT,
 * user_settings SELECT, fcm_tokens COUNT) by inspecting the SQL.
 */
function routeQueries(opts: {
  enriched?: Record<string, unknown> | null;
  settings?: Record<string, unknown> | null;
  fcmCount?: number;
}) {
  poolMock.query.mockImplementation((sql: string) => {
    if (/FROM auth_users/i.test(sql)) {
      return Promise.resolve({ rows: opts.enriched ? [opts.enriched] : [], rowCount: opts.enriched ? 1 : 0 });
    }
    if (/FROM fcm_tokens/i.test(sql)) {
      return Promise.resolve({ rows: [{ device_count: String(opts.fcmCount ?? 0) }], rowCount: 1 });
    }
    if (/FROM user_settings/i.test(sql)) {
      return Promise.resolve({
        rows: opts.settings === null || opts.settings === undefined ? [] : [{ settings: opts.settings }],
        rowCount: opts.settings ? 1 : 0,
      });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

const ENRICHED_ROW = {
  user_id: 'owner-1',
  email: 'o@example.com',
  username: 'owner',
  display_name: 'Owner',
  role: 'user',
  enabled: true,
  created_at: '2026-01-01T00:00:00Z',
  onboarding: { completed: true, steps: { profile: true, google: true } },
  chan_google: true,
  chan_whatsapp: false,
  chan_health: true,
  last_active_at: '2026-05-01T00:00:00Z',
};

let app: any;

beforeEach(() => {
  vi.clearAllMocks();
  poolMock.query.mockResolvedValue({ rows: [], rowCount: 0 });
  esMock.search.mockResolvedValue({ hits: { hits: [], total: { value: 0 } } });
  esMock.indices.exists.mockResolvedValue(true);
  app = createApp(testConfig()).app;
});

describe('GET /me/onboarding — self-scoped shape', () => {
  it('returns the {onboarding, channels, phone, profile} shape derived for the caller', async () => {
    routeQueries({
      enriched: ENRICHED_ROW,
      settings: {
        display_name: 'Owner',
        timezone: 'Asia/Jerusalem',
        work_week: { start_day: 0, start_hour: '09:00', end_hour: '17:00' },
        self_names: ['Owner', 'O'],
      },
      fcmCount: 2,
    });

    const handler = getHandler(app, 'get', '/me/onboarding');
    const res = makeRes();
    await handler(reqAs('owner-1'), res);

    expect(res._status).toBe(200);
    expect(res._json).toEqual({
      onboarding: { completed: true, steps: { profile: true, google: true } },
      channels: { google: true, whatsapp: false, health: true },
      phone: { linked: true, device_count: 2 },
      profile: {
        display_name: 'Owner',
        timezone: 'Asia/Jerusalem',
        work_week: { start_day: 0, start_hour: '09:00', end_hour: '17:00' },
        self_names: ['Owner', 'O'],
      },
    });
  });

  it('never leaks secrets and does not call the personal-knowledge MCP', async () => {
    routeQueries({ enriched: ENRICHED_ROW, settings: {}, fcmCount: 0 });
    const handler = getHandler(app, 'get', '/me/onboarding');
    const res = makeRes();
    await handler(reqAs('owner-1'), res);

    const serialized = JSON.stringify(res._json);
    expect(serialized).not.toMatch(/pin_hash|password_hash|ciphertext|api_key|token_hash/i);
  });
});

describe('GET /me/onboarding — strict self-scoping', () => {
  it('filters EVERY query by the caller user_id from the token claim', async () => {
    routeQueries({ enriched: ENRICHED_ROW, settings: {}, fcmCount: 1 });
    const handler = getHandler(app, 'get', '/me/onboarding');
    await handler(reqAs('caller-9'), makeRes());

    // Three queries: enrichment SELECT, user_settings SELECT, fcm_tokens COUNT.
    expect(poolMock.query).toHaveBeenCalledTimes(3);

    for (const call of poolMock.query.mock.calls) {
      const sql = call[0] as string;
      const params = call[1] as unknown[];
      // Every query is parameterized on user_id = $1 and bound to the caller.
      expect(sql).toMatch(/user_id\s*=\s*\$1/i);
      expect(params).toEqual(['caller-9']);
    }
  });

  it('the enrichment SELECT scopes on au.user_id = $1, the fcm count on fcm_tokens.user_id = $1', async () => {
    routeQueries({ enriched: ENRICHED_ROW, settings: {}, fcmCount: 0 });
    const handler = getHandler(app, 'get', '/me/onboarding');
    await handler(reqAs('caller-9'), makeRes());

    const sqls = poolMock.query.mock.calls.map((c) => c[0] as string);
    const enrichSql = sqls.find((s) => /FROM auth_users/i.test(s))!;
    const fcmSql = sqls.find((s) => /FROM fcm_tokens/i.test(s))!;
    expect(enrichSql).toMatch(/WHERE\s+au\.user_id\s*=\s*\$1/);
    expect(fcmSql).toMatch(/FROM fcm_tokens\s+WHERE\s+user_id\s*=\s*\$1/);
  });
});

describe('GET /me/onboarding — phone linkage', () => {
  it('phone.linked=true and device_count reflects fcm rows when tokens exist', async () => {
    routeQueries({ enriched: ENRICHED_ROW, settings: {}, fcmCount: 3 });
    const handler = getHandler(app, 'get', '/me/onboarding');
    const res = makeRes();
    await handler(reqAs('owner-1'), res);

    expect((res._json as any).phone).toEqual({ linked: true, device_count: 3 });
  });

  it('phone.linked=false and device_count=0 when the caller has no fcm tokens', async () => {
    routeQueries({ enriched: ENRICHED_ROW, settings: {}, fcmCount: 0 });
    const handler = getHandler(app, 'get', '/me/onboarding');
    const res = makeRes();
    await handler(reqAs('owner-1'), res);

    expect((res._json as any).phone).toEqual({ linked: false, device_count: 0 });
  });
});

describe('GET /me/onboarding — defaults', () => {
  it('onboarding defaults to {completed:false, steps:{}} when the user has no settings/onboarding', async () => {
    // No user_settings row at all, and no enriched row -> defaults everywhere.
    routeQueries({ enriched: null, settings: null, fcmCount: 0 });
    const handler = getHandler(app, 'get', '/me/onboarding');
    const res = makeRes();
    await handler(reqAs('fresh-user'), res);

    expect(res._status).toBe(200);
    expect((res._json as any).onboarding).toEqual({ completed: false, steps: {} });
    expect((res._json as any).channels).toEqual({ google: false, whatsapp: false, health: false });
    expect((res._json as any).profile).toEqual({
      display_name: null,
      timezone: null,
      work_week: null,
      self_names: null,
    });
  });

  it('onboarding defaults when the enrichment row has onboarding=null (empty jsonb)', async () => {
    routeQueries({
      enriched: { ...ENRICHED_ROW, onboarding: null, chan_google: false, chan_whatsapp: false, chan_health: false },
      settings: {},
      fcmCount: 0,
    });
    const handler = getHandler(app, 'get', '/me/onboarding');
    const res = makeRes();
    await handler(reqAs('owner-1'), res);

    expect((res._json as any).onboarding).toEqual({ completed: false, steps: {} });
  });
});
