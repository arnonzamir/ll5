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

// ---------------------------------------------------------------------------
// ISS-005 — idempotent telemetry writes (deterministic id + op_type:create)
// ---------------------------------------------------------------------------
describe('telemetry writes are idempotent (ISS-005)', () => {
  const conflict = () => Object.assign(new Error('version_conflict_engine_exception'), { meta: { statusCode: 409 } });

  it('eval-moment: id = `${session_id}:${ts}` with op_type:create', async () => {
    const handler = getHandler(app, 'post', '/telemetry/eval-moment');
    const res = makeRes();
    await handler(reqAs('owner-1', { ts: '2026-09-04T10:00:00.000Z', decision: 'suppress', session_id: 'sess-9' }), res);
    const arg = esMock.index.mock.calls[0][0] as any;
    expect(arg.index).toBe('ll5_eval_moments');
    expect(arg.id).toBe('sess-9:2026-09-04T10:00:00.000Z');
    expect(arg.op_type).toBe('create');
    expect(res._json).toEqual({ ok: true });
  });

  it('eval-moment: a retried hook (409) is acknowledged as a duplicate, not a 500, and writes nothing new', async () => {
    esMock.index.mockRejectedValueOnce(conflict());
    const handler = getHandler(app, 'post', '/telemetry/eval-moment');
    const res = makeRes();
    await handler(reqAs('owner-1', { ts: '2026-09-04T10:00:00.000Z', decision: 'suppress', session_id: 'sess-9' }), res);
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ ok: true, duplicate: true });
    expect(esMock.index).toHaveBeenCalledTimes(1);
  });

  it('eval-moment: without a session_id it degrades to the old auto-id append (no id, no op_type)', async () => {
    const handler = getHandler(app, 'post', '/telemetry/eval-moment');
    const res = makeRes();
    await handler(reqAs('owner-1', { ts: '2026-09-04T10:00:00.000Z', decision: 'suppress' }), res);
    const arg = esMock.index.mock.calls[0][0] as any;
    expect(arg.id).toBeUndefined();
    expect(arg.op_type).toBeUndefined();
    expect(res._json).toEqual({ ok: true });
  });

  it('eval-moment: a non-409 ES failure is still a 500', async () => {
    esMock.index.mockRejectedValueOnce(Object.assign(new Error('boom'), { meta: { statusCode: 503 } }));
    const handler = getHandler(app, 'post', '/telemetry/eval-moment');
    const res = makeRes();
    await handler(reqAs('owner-1', { ts: '2026-09-04T10:00:00.000Z', session_id: 'sess-9' }), res);
    expect(res._status).toBe(500);
  });

  it('turn-cost: same id scheme, same duplicate handling, user_id from auth', async () => {
    const handler = getHandler(app, 'post', '/telemetry/turn-cost');
    const res = makeRes();
    await handler(reqAs('owner-1', { ts: '2026-09-04T10:00:00.000Z', session_id: 'sess-9', model: 'claude-opus-5', cost_usd: 0.12, is_main: true, user_id: 'attacker' }), res);
    const arg = esMock.index.mock.calls[0][0] as any;
    expect(arg.index).toBe('ll5_turn_costs');
    expect(arg.id).toBe('sess-9:2026-09-04T10:00:00.000Z');
    expect(arg.op_type).toBe('create');
    expect(arg.document.user_id).toBe('owner-1');
    expect(arg.document.cost_usd).toBe(0.12);

    esMock.index.mockRejectedValueOnce(conflict());
    const res2 = makeRes();
    await handler(reqAs('owner-1', { ts: '2026-09-04T10:00:00.000Z', session_id: 'sess-9' }), res2);
    expect(res2._json).toEqual({ ok: true, duplicate: true });
  });
});

// ---------------------------------------------------------------------------
// ISS-014 — POST /sessions: replace vs append, bounded, tenant-scoped
// ---------------------------------------------------------------------------
describe('POST /sessions (ISS-014)', () => {
  const notFound = () => Object.assign(new Error('not_found'), { meta: { statusCode: 404 } });
  const msg = (i: number, text = `m${i}`) => ({ role: 'human', text, timestamp: `2026-09-04T10:00:${String(i).padStart(2, '0')}.000Z` });

  it('replace (default): full overwrite keyed on session_id, user_id from auth, transcript_text projected from the NEWEST text', async () => {
    const handler = getHandler(app, 'post', '/sessions');
    const res = makeRes();
    await handler(reqAs('owner-1', {
      session_id: 'S1',
      messages: [msg(1, 'alpha'), msg(2, 'beta')],
      message_count: 2,
      first_message: msg(1).timestamp,
      last_message: msg(2).timestamp,
      user_id: 'attacker',
    }), res);
    expect(esMock.get).not.toHaveBeenCalled();
    const arg = esMock.index.mock.calls[0][0] as any;
    expect(arg.index).toBe('ll5_session_history');
    expect(arg.id).toBe('S1');
    expect(arg.if_seq_no).toBeUndefined();
    expect(arg.document.user_id).toBe('owner-1');
    expect(arg.document.messages).toHaveLength(2);
    expect(arg.document.messages_dropped).toBe(0);
    expect(arg.document.transcript_text).toBe('alpha\nbeta');
    expect(res._status).toBe(201);
    expect(res._json).toMatchObject({ indexed: true, session_id: 'S1', mode: 'replace', stored: 2, dropped: 0 });
  });

  it('append: keeps the stored messages, adds only those newer than the stored last_message, carries seq_no/primary_term', async () => {
    esMock.get.mockResolvedValueOnce({
      _seq_no: 7,
      _primary_term: 2,
      _source: {
        user_id: 'owner-1',
        session_id: 'S1',
        messages: [msg(1), msg(2)],
        message_count: 2,
        first_message: msg(1).timestamp,
        last_message: msg(2).timestamp,
        messages_dropped: 0,
        workspace: 'll5-run',
      },
    });
    const handler = getHandler(app, 'post', '/sessions');
    const res = makeRes();
    // The tail overlaps the stored doc (m2 again) — the retry/overlap case.
    await handler(reqAs('owner-1', {
      session_id: 'S1',
      mode: 'append',
      messages: [msg(2), msg(3), msg(4)],
      message_count: 4,
      last_message: msg(4).timestamp,
    }), res);
    const arg = esMock.index.mock.calls[0][0] as any;
    expect(arg.id).toBe('S1');
    expect(arg.if_seq_no).toBe(7);
    expect(arg.if_primary_term).toBe(2);
    expect(arg.document.messages.map((m: any) => m.text)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(arg.document.message_count).toBe(4);
    expect(arg.document.first_message).toBe(msg(1).timestamp);
    expect(arg.document.last_message).toBe(msg(4).timestamp);
    expect(arg.document.transcript_text).toBe('m1\nm2\nm3\nm4');
    expect(res._json).toMatchObject({ mode: 'append', appended: 2, stored: 4, dropped: 0 });
  });

  it('append on a session with no stored doc (404) creates it without a concurrency guard', async () => {
    esMock.get.mockRejectedValueOnce(notFound());
    const handler = getHandler(app, 'post', '/sessions');
    const res = makeRes();
    await handler(reqAs('owner-1', { session_id: 'S2', mode: 'append', messages: [msg(1), msg(2)] }), res);
    const arg = esMock.index.mock.calls[0][0] as any;
    expect(arg.if_seq_no).toBeUndefined();
    expect(arg.document.messages).toHaveLength(2);
    expect(arg.document.message_count).toBe(2);
    expect(arg.document.first_message).toBe(msg(1).timestamp);
    expect(arg.document.last_message).toBe(msg(2).timestamp);
    expect(res._status).toBe(201);
  });

  it('append: a stored doc owned by another tenant is refused (403) and never overwritten', async () => {
    esMock.get.mockResolvedValueOnce({ _seq_no: 1, _primary_term: 1, _source: { user_id: 'owner-2', session_id: 'S1', messages: [msg(1)] } });
    const handler = getHandler(app, 'post', '/sessions');
    const res = makeRes();
    await handler(reqAs('owner-1', { session_id: 'S1', mode: 'append', messages: [msg(2)] }), res);
    expect(res._status).toBe(403);
    expect(esMock.index).not.toHaveBeenCalled();
  });

  it('append: losing the optimistic-concurrency race is a retryable 409, not a 500', async () => {
    esMock.get.mockResolvedValueOnce({ _seq_no: 1, _primary_term: 1, _source: { user_id: 'owner-1', session_id: 'S1', messages: [msg(1)], last_message: msg(1).timestamp } });
    esMock.index.mockRejectedValueOnce(Object.assign(new Error('version_conflict_engine_exception'), { meta: { statusCode: 409 } }));
    const handler = getHandler(app, 'post', '/sessions');
    const res = makeRes();
    await handler(reqAs('owner-1', { session_id: 'S1', mode: 'append', messages: [msg(2)] }), res);
    expect(res._status).toBe(409);
  });

  it('both modes cap the stored array at 5000 (oldest dropped) and count the drop', async () => {
    const many = Array.from({ length: 5003 }, (_, i) => ({ role: 'human', text: `t${i}`, timestamp: `2026-09-04T${String(Math.floor(i / 3600)).padStart(2, '0')}:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z` }));
    const handler = getHandler(app, 'post', '/sessions');
    const res = makeRes();
    await handler(reqAs('owner-1', { session_id: 'S3', messages: many, message_count: 5003 }), res);
    const arg = esMock.index.mock.calls[0][0] as any;
    expect(arg.document.messages).toHaveLength(5000);
    expect(arg.document.messages[0].text).toBe('t3');
    expect(arg.document.messages_dropped).toBe(3);
    expect(arg.document.message_count).toBe(5003);
    expect(res._json).toMatchObject({ stored: 5000, dropped: 3 });
  });

  it('rejects a body with no session_id (400)', async () => {
    const handler = getHandler(app, 'post', '/sessions');
    const res = makeRes();
    await handler(reqAs('owner-1', { messages: [msg(1)] }), res);
    expect(res._status).toBe(400);
    expect(esMock.index).not.toHaveBeenCalled();
  });
});
