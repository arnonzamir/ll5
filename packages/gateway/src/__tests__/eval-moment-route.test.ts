import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Mock the external boundaries: pg.Pool and @elastic/elasticsearch Client.
// createApp() constructs both internally, so we intercept the constructors and
// hand back recordable fakes (mirrors server-scoping.test.ts). Nothing else in
// server.ts is mocked.
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

function reqAs(userId: string, body: Record<string, unknown>): Request {
  const r = { headers: {}, query: {}, body, params: {} } as any;
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
  esMock.index.mockResolvedValue({ result: 'created' });
  app = createApp(testConfig()).app;
});

// ---------------------------------------------------------------------------
// POST /telemetry/eval-moment — the eval-moment whitelist (DECISION-025 B4)
// ---------------------------------------------------------------------------
describe('POST /telemetry/eval-moment — close_count + F5 whitelist', () => {
  it('indexes close_count when sent (alongside grounding_calls)', async () => {
    const handler = getHandler(app, 'post', '/telemetry/eval-moment');
    const res = makeRes();
    await handler(reqAs('owner-1', {
      ts: '2026-07-07T18:00:00.000Z',
      decision: 'ping_now',
      trigger_class: 'event',
      source: 'gtd',
      grounding_calls: 2,
      close_count: 3,
      pencil_count: 4,
      session_id: 'sess-1',
    }), res);

    expect(esMock.index).toHaveBeenCalledTimes(1);
    const arg = esMock.index.mock.calls[0][0] as any;
    expect(arg.index).toBe('ll5_eval_moments');
    expect(arg.document.close_count).toBe(3);
    expect(arg.document.pencil_count).toBe(4);
    expect(arg.document.grounding_calls).toBe(2);
    expect(arg.document.user_id).toBe('owner-1');
    expect(res._json).toEqual({ ok: true });
  });

  it('coerces close_count with the int() helper (truncates, drops non-numeric)', async () => {
    const handler = getHandler(app, 'post', '/telemetry/eval-moment');

    const res1 = makeRes();
    await handler(reqAs('owner-1', { ts: '2026-07-07T18:00:00.000Z', close_count: 2.9 }), res1);
    expect((esMock.index.mock.calls[0][0] as any).document.close_count).toBe(2);

    // A non-numeric close_count is dropped to undefined (not coerced to a string).
    const res2 = makeRes();
    await handler(reqAs('owner-1', { ts: '2026-07-07T18:00:00.000Z', close_count: 'lots' }), res2);
    expect((esMock.index.mock.calls[1][0] as any).document.close_count).toBeUndefined();
  });

  it('F5: free-text fields NEVER reach the indexed document — only the whitelist', async () => {
    const handler = getHandler(app, 'post', '/telemetry/eval-moment');
    const res = makeRes();
    await handler(reqAs('owner-1', {
      ts: '2026-07-07T18:00:00.000Z',
      decision: 'ping_now',
      grounding_calls: 1,
      close_count: 1,
      // Unexpected free-text fields an attacker/agent-bug might attach — these
      // must be dropped by the field-by-field whitelist (the F5 guarantee).
      message: 'secret body: bank pin 1234',
      body: 'another secret body',
      text: 'raw message text',
      payload: 'the trigger body',
      tools_called: [{ tool: 'update_action' }],
      // message_sent is a KNOWN field but must be coerced to a boolean, never
      // stored as the delivered text.
      message_sent: 'SECRET delivered body: your PIN is 1234',
    }), res);

    const doc = (esMock.index.mock.calls[0][0] as any).document;

    // Only the whitelist keys are present.
    expect(new Set(Object.keys(doc))).toEqual(new Set([
      'timestamp', 'user_id', 'decision', 'decision_claimed', 'decision_mismatch',
      'trigger_class', 'source', 'message_sent', 'cold_start', 'grounding_calls',
      'close_count', 'pencil_count', 'session_id',
    ]));

    // The unexpected free-text fields did not survive.
    for (const k of ['message', 'body', 'text', 'payload', 'tools_called']) {
      expect(doc[k]).toBeUndefined();
    }
    // message_sent is coerced to a boolean — the body text is gone.
    expect(typeof doc.message_sent).toBe('boolean');
    expect(doc.message_sent).toBe(true);

    // No indexed VALUE carries any of the secret body text.
    const blob = JSON.stringify(doc);
    expect(blob).not.toContain('bank pin');
    expect(blob).not.toContain('your PIN');
    expect(blob).not.toContain('trigger body');
  });

  it('rejects a payload with no ts (400, no index write)', async () => {
    const handler = getHandler(app, 'post', '/telemetry/eval-moment');
    const res = makeRes();
    await handler(reqAs('owner-1', { close_count: 1 }), res);
    expect(res._status).toBe(400);
    expect(esMock.index).not.toHaveBeenCalled();
  });
});
