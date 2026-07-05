import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import type { Client } from '@elastic/elasticsearch';

vi.mock('@ll5/shared', async (orig) => {
  const actual = await orig<typeof import('@ll5/shared')>();
  return { ...actual, logAudit: vi.fn() };
});

const mcp = vi.hoisted(() => ({
  callTool: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = vi.fn(async () => {});
    callTool = mcp.callTool;
    close = vi.fn(async () => {});
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {},
}));

import {
  createNarrativesRouter,
  rankNarrativesNow,
  calendarProximity,
  fmtEventShort,
  type CalendarEventLite,
  type NowRankableNarrative,
} from '../narratives.js';

const AUTH_SECRET = 'test-secret-key-at-least-32-characters-long!!';

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

function makeEs(hits: unknown[] = []): { es: Client; search: ReturnType<typeof vi.fn> } {
  const search = vi.fn(async () => ({ hits: { hits } }));
  return { es: { search } as unknown as Client, search };
}

function getChain(router: ReturnType<typeof createNarrativesRouter>, method: string, path: string) {
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

const tzMatcher = (homeTz: string): Matcher => (sql) =>
  /settings->>'current_timezone'/.test(sql)
    ? { rows: [{ current_tz: null, current_tz_at: null, home_tz: homeTz }] }
    : undefined;

// 2026-07-05 is a Sunday.
const NOW_ISO = '2026-07-05T08:30:00Z';
const NOW_MS = Date.parse(NOW_ISO);
const NOW = () => new Date(NOW_ISO);

const hoursFromNow = (h: number) => NOW_MS + h * 3_600_000;

function narrative(overrides: Partial<NowRankableNarrative> = {}): NowRankableNarrative {
  return {
    title: 'Quiet thread',
    status: 'active',
    openThreads: [],
    participants: [],
    lastObservedAt: NOW_ISO,
    observationCount: 3,
    ...overrides,
  };
}

function event(overrides: Partial<CalendarEventLite> = {}): CalendarEventLite {
  return { title: 'Standup', attendees: [], startMs: hoursFromNow(6), ...overrides };
}

// ---------------------------------------------------------------------------
// Ranking math (pure)
// ---------------------------------------------------------------------------

describe('rankNarrativesNow — score math (0.35 open_loop + 0.30 calendar + 0.25 recency + 0.10 status)', () => {
  it('scores a fresh active open-loop narrative 0.35 + 0.25 + 0.10 = 0.70 (no calendar)', () => {
    const [r] = rankNarrativesNow(
      [narrative({ openThreads: ['Reply to Dana about the venue'] })],
      [], NOW_MS, 'UTC',
    );
    expect(r.now_score).toBeCloseTo(0.70, 4);
    expect(r.why_now).toEqual({ kind: 'open_loop', detail: 'Reply to Dana about the venue' });
  });

  it('scores a fresh active calendar-matched narrative 0.30 + 0.25 + 0.10 = 0.65 (event ≤12h)', () => {
    const [r] = rankNarrativesNow(
      [narrative({ title: 'Wedding planning' })],
      [event({ title: 'Hen wedding fitting', startMs: hoursFromNow(6) })],
      NOW_MS, 'UTC',
    );
    expect(r.now_score).toBeCloseTo(0.65, 4);
    expect(r.why_now.kind).toBe('calendar');
    expect(r.why_now.detail).toBe('Sun 14:30'); // 08:30Z + 6h in UTC
  });

  it('applies closeness tiers: ≤12h → 1.0, ≤24h → 0.7, ≤48h → 0.4', () => {
    // Isolate the calendar term: no threads, no activity timestamps → recency 0.
    const base = { title: 'Wedding planning', lastObservedAt: undefined, status: 'active' as const };
    const score = (h: number) => rankNarrativesNow(
      [narrative(base)],
      [event({ title: 'wedding', startMs: hoursFromNow(h) })],
      NOW_MS, 'UTC',
    )[0].now_score;
    expect(score(6)).toBeCloseTo(0.30 * 1.0 + 0.10, 4);
    expect(score(20)).toBeCloseTo(0.30 * 0.7 + 0.10, 4);
    expect(score(40)).toBeCloseTo(0.30 * 0.4 + 0.10, 4);
  });

  it('recency decays with a 3-day half-life (72h old → 0.25 * 0.5)', () => {
    const [r] = rankNarrativesNow(
      [narrative({ lastObservedAt: new Date(NOW_MS - 72 * 3_600_000).toISOString() })],
      [], NOW_MS, 'UTC',
    );
    expect(r.now_score).toBeCloseTo(0.25 * 0.5 + 0.10, 4);
  });

  it('weights status: active 1.0, dormant 0.3', () => {
    const stale = { lastObservedAt: undefined };
    const [active] = rankNarrativesNow([narrative({ ...stale, status: 'active' })], [], NOW_MS, 'UTC');
    const [dormant] = rankNarrativesNow([narrative({ ...stale, status: 'dormant' })], [], NOW_MS, 'UTC');
    expect(active.now_score).toBeCloseTo(0.10, 4);
    expect(dormant.now_score).toBeCloseTo(0.03, 4);
  });

  it('volume is NOT a factor — observation count never moves the score', () => {
    const [a] = rankNarrativesNow([narrative({ observationCount: 2 })], [], NOW_MS, 'UTC');
    const [b] = rankNarrativesNow([narrative({ observationCount: 500 })], [], NOW_MS, 'UTC');
    expect(a.now_score).toBe(b.now_score);
  });

  it('sorts by score descending', () => {
    const ranked = rankNarrativesNow(
      [
        narrative({ title: 'quiet', lastObservedAt: new Date(NOW_MS - 200 * 3_600_000).toISOString() }),
        narrative({ title: 'owes an answer', openThreads: ['reply to Dana'] }),
        narrative({ title: 'recent but silent' }),
      ],
      [], NOW_MS, 'UTC',
    );
    expect(ranked.map((r) => r.title)).toEqual(['owes an answer', 'recent but silent', 'quiet']);
  });
});

describe('rankNarrativesNow — why_now selection (exactly one signal)', () => {
  it('open_loop wins over calendar when both fire', () => {
    const [r] = rankNarrativesNow(
      [narrative({ title: 'Wedding planning', openThreads: ['confirm the caterer'] })],
      [event({ title: 'wedding fitting' })],
      NOW_MS, 'UTC',
    );
    expect(r.why_now.kind).toBe('open_loop');
    expect(r.why_now.detail).toBe('confirm the caterer');
    // ...but the calendar signal still counts toward the score.
    expect(r.now_score).toBeCloseTo(0.35 + 0.30 + 0.25 + 0.10, 4);
  });

  it('is null/null when neither signal fires', () => {
    const [r] = rankNarrativesNow([narrative()], [], NOW_MS, 'UTC');
    expect(r.why_now).toEqual({ kind: null, detail: null });
  });

  it('truncates the open-loop detail to ≤60 chars with an ellipsis', () => {
    const long = 'a'.repeat(100);
    const [r] = rankNarrativesNow([narrative({ openThreads: [long] })], [], NOW_MS, 'UTC');
    expect(r.why_now.detail!.length).toBe(60);
    expect(r.why_now.detail!.endsWith('…')).toBe(true);
  });

  it('whitespace-only open threads do not count as an open loop', () => {
    const [r] = rankNarrativesNow([narrative({ openThreads: ['   '] })], [], NOW_MS, 'UTC');
    expect(r.why_now.kind).toBeNull();
    expect(r.now_score).toBeCloseTo(0.25 + 0.10, 4);
  });

  it("renders the calendar detail in the user's effective timezone", () => {
    // 2026-07-05T11:00Z + Asia/Jerusalem (UTC+3) = Sun 14:00.
    const [r] = rankNarrativesNow(
      [narrative({ title: 'Chen catchup', lastObservedAt: undefined })],
      [event({ title: 'Chen 1:1', startMs: Date.parse('2026-07-05T11:00:00Z') })],
      NOW_MS, 'Asia/Jerusalem',
    );
    expect(r.why_now).toEqual({ kind: 'calendar', detail: 'Sun 14:00' });
  });
});

describe('calendarProximity — name-token matching', () => {
  it('matches attendees against participant names, case-insensitively', () => {
    const hit = calendarProximity(
      narrative({ title: '', participants: ['Dana Levi'] }),
      [event({ title: 'Sync', attendees: ['DANA@example.com'] })],
      NOW_MS,
    );
    expect(hit).not.toBeNull();
    expect(hit!.scale).toBe(1.0);
  });

  it('ignores name tokens shorter than 3 chars', () => {
    const hit = calendarProximity(
      narrative({ title: '', participants: ['Li'] }),
      [event({ title: 'Li planning session' })],
      NOW_MS,
    );
    expect(hit).toBeNull();
  });

  it('ignores events outside the 48h window and picks the earliest match inside it', () => {
    const hit = calendarProximity(
      narrative({ title: 'wedding' }),
      [
        event({ title: 'wedding rehearsal', startMs: hoursFromNow(60) }), // out of window
        event({ title: 'wedding fitting', startMs: hoursFromNow(30) }),
        event({ title: 'wedding call', startMs: hoursFromNow(14) }),
      ],
      NOW_MS,
    );
    expect(hit!.startMs).toBe(hoursFromNow(14)); // earliest in-window match
    expect(hit!.scale).toBe(0.7);
  });

  it('never matches past events', () => {
    const hit = calendarProximity(
      narrative({ title: 'wedding' }),
      [event({ title: 'wedding brunch', startMs: hoursFromNow(-2) })],
      NOW_MS,
    );
    expect(hit).toBeNull();
  });
});

describe('fmtEventShort', () => {
  it('formats "Thu 14:00" style in the given zone', () => {
    // 2026-07-09 is a Thursday; 11:00Z = 14:00 in Asia/Jerusalem.
    expect(fmtEventShort(Date.parse('2026-07-09T11:00:00Z'), 'Asia/Jerusalem')).toBe('Thu 14:00');
    expect(fmtEventShort(Date.parse('2026-07-09T11:00:00Z'), 'UTC')).toBe('Thu 11:00');
  });
});

// ---------------------------------------------------------------------------
// GET /narratives?sort=now — route behavior
// ---------------------------------------------------------------------------

function mcpNarrativesReply(narratives: unknown[], total = narratives.length) {
  mcp.callTool.mockResolvedValue({
    content: [{ type: 'text', text: JSON.stringify({ narratives, total }) }],
  });
}

async function runList(pool: Pool, es: Client, query: Record<string, string>) {
  const router = createNarrativesRouter(pool, es, AUTH_SECRET, 'http://knowledge.test', { now: NOW });
  const run = getChain(router, 'get', '/narratives');
  const req = makeReq({ headers: authHeader(userToken('u1')), query });
  const res = makeRes();
  await run(req, res);
  return res;
}

describe('GET /narratives?sort=now', () => {
  beforeEach(() => {
    mcp.callTool.mockReset();
  });

  it('fetches relevance-sorted actives (limit 25) from the MCP and re-ranks in the gateway', async () => {
    mcpNarrativesReply([
      { title: 'Quiet recent thread', status: 'active', openThreads: [], participants: [], lastObservedAt: NOW_ISO },
      { title: 'Wedding planning', status: 'active', openThreads: [], participants: [], lastObservedAt: NOW_ISO },
    ], 2);
    const { pool } = makePool([tzMatcher('UTC')]);
    const { es, search } = makeEs([
      { _source: { title: 'Hen wedding fitting', attendees: ['Hen'], start_time: '2026-07-05T14:30:00Z' } },
    ]);

    const res = await runList(pool, es, { sort: 'now' });
    expect(res._status).toBe(200);

    // MCP call: existing relevance path, limit pinned to 25.
    expect(mcp.callTool).toHaveBeenCalledWith({
      name: 'list_narratives',
      arguments: expect.objectContaining({ sort: 'relevance', limit: 25, offset: 0, status: 'active' }),
    });

    // ES: next-48h window excluding instruction ticklers.
    const q = search.mock.calls[0][0] as any;
    expect(q.index).toBe('ll5_awareness_calendar_events');
    expect(q.query.bool.filter).toEqual([
      { term: { user_id: 'u1' } },
      { range: { start_time: { gte: '2026-07-05T08:30:00.000Z', lt: '2026-07-07T08:30:00.000Z' } } },
    ]);
    expect(q.query.bool.must_not).toEqual([{ term: { kind: 'instruction' } }]);

    // Re-rank: calendar-matched narrative outranks the equally-fresh quiet one.
    const body = res._json as any;
    expect(body.total).toBe(2);
    expect(body.narratives[0].title).toBe('Wedding planning');
    expect(body.narratives[0].why_now).toEqual({ kind: 'calendar', detail: 'Sun 14:30' });
    expect(body.narratives[1].why_now).toEqual({ kind: null, detail: null });
  });

  it('leaves the default relevance path untouched (no ES call, no why_now)', async () => {
    mcpNarrativesReply([{ title: 'A', status: 'active' }]);
    const { pool } = makePool([tzMatcher('UTC')]);
    const { es, search } = makeEs([]);

    const res = await runList(pool, es, {});
    expect(res._status).toBe(200);
    expect(search).not.toHaveBeenCalled();
    const body = res._json as any;
    expect(body.narratives[0].why_now).toBeUndefined();
    expect(mcp.callTool).toHaveBeenCalledWith({
      name: 'list_narratives',
      arguments: expect.objectContaining({ sort: 'relevance', limit: 50 }),
    });
  });

  it('degrades to no-calendar-signal when the calendar index is missing (still 200)', async () => {
    mcpNarrativesReply([
      { title: 'Wedding planning', status: 'active', openThreads: ['book the band'], lastObservedAt: NOW_ISO },
    ]);
    const { pool } = makePool([tzMatcher('UTC')]);
    const search = vi.fn(async () => { throw new Error('index_not_found_exception: no such index'); });
    const es = { search } as unknown as Client;

    const res = await runList(pool, es, { sort: 'now' });
    expect(res._status).toBe(200);
    const body = res._json as any;
    expect(body.narratives[0].why_now.kind).toBe('open_loop');
  });

  it('502s when the ES calendar query fails for real (no silent defaults)', async () => {
    mcpNarrativesReply([{ title: 'A', status: 'active' }]);
    const { pool } = makePool([tzMatcher('UTC')]);
    const search = vi.fn(async () => { throw new Error('connection refused'); });
    const es = { search } as unknown as Client;

    const res = await runList(pool, es, { sort: 'now' });
    expect(res._status).toBe(502);
  });

  it('401s without a token', async () => {
    const { pool } = makePool([]);
    const { es } = makeEs();
    const router = createNarrativesRouter(pool, es, AUTH_SECRET, 'http://knowledge.test', { now: NOW });
    const run = getChain(router, 'get', '/narratives');
    const res = makeRes();
    await run(makeReq({ query: { sort: 'now' } }), res);
    expect(res._status).toBe(401);
  });
});
