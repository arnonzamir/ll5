import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import type { Client } from '@elastic/elasticsearch';

vi.mock('@ll5/shared', async (orig) => {
  const actual = await orig<typeof import('@ll5/shared')>();
  return { ...actual, logAudit: vi.fn() };
});

import { createTodayRouter } from '../today.js';

const AUTH_SECRET = 'test-secret-key-at-least-32-characters-long!!';

/** Mint a valid ll5 token for a given user/role. */
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

function getChain(router: ReturnType<typeof createTodayRouter>, method: string, path: string) {
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

// ---------------------------------------------------------------------------
// Matchers. Default home tz pinned to UTC so the injected clock IS local
// wall-clock time — 2026-07-05 is a Sunday (dow 0).
// ---------------------------------------------------------------------------

const HABIT_ID = '11111111-1111-1111-1111-111111111111';
const NOW_0830 = () => new Date('2026-07-05T08:30:00Z');

const tzMatcher = (homeTz: string): Matcher => (sql) =>
  /settings->>'current_timezone'/.test(sql)
    ? { rows: [{ current_tz: null, current_tz_at: null, home_tz: homeTz }] }
    : undefined;

// Tray collector's habit query (SELECT list includes description + escalation)
// — distinct from the Today strip query below.
const trayHabitsMatcher = (habits: unknown[]): Matcher =>
  (sql) => /SELECT id, name, description, schedule, escalation, timezone/.test(sql)
    ? { rows: habits }
    : undefined;

const trayLogMatcher = (rows: unknown[]): Matcher =>
  (sql) => /SELECT due_time, outcome, steps_fired/.test(sql) ? { rows } : undefined;

// Today strip queries.
const stripHabitsMatcher = (habits: unknown[]): Matcher =>
  (sql) => /SELECT id, name, schedule, timezone\s+FROM gtd_habits/.test(sql)
    ? { rows: habits }
    : undefined;

const stripLogMatcher = (rows: unknown[]): Matcher =>
  (sql) => /SELECT due_date::text AS due_date, due_time, outcome/.test(sql) ? { rows } : undefined;

const dayCardSelectMatcher = (rows: unknown[]): Matcher =>
  (sql) => /SELECT voice, one_thing, updated_at FROM day_cards/.test(sql) ? { rows } : undefined;

const dayCardInsertMatcher: Matcher = (sql) =>
  /INSERT INTO day_cards/.test(sql) ? { rows: [], rowCount: 1 } : undefined;

const chatMessagesMatcher = (rows: unknown[]): Matcher =>
  (sql) => /FROM chat_messages/.test(sql) ? { rows } : undefined;

function trayHabitRow(overrides: Record<string, unknown> = {}) {
  return {
    id: HABIT_ID,
    name: 'Ritalin',
    description: null,
    schedule: { days: 'daily', times: ['08:00'] },
    escalation: [{ offset_minutes: 0, level: 'notify' }],
    timezone: 'UTC',
    ...overrides,
  };
}

function stripHabitRow(overrides: Record<string, unknown> = {}) {
  return {
    id: HABIT_ID,
    name: 'Ritalin',
    schedule: { days: 'daily', times: ['08:00'] },
    timezone: 'UTC',
    ...overrides,
  };
}

function todayRouter(pool: Pool, es: Client, now: () => Date = NOW_0830) {
  return createTodayRouter(pool, es, AUTH_SECRET, { now });
}

async function runToday(pool: Pool, es: Client, now: () => Date = NOW_0830) {
  const run = getChain(todayRouter(pool, es, now), 'get', '/me/today');
  const req = makeReq({ headers: authHeader(userToken('u1')) });
  const res = makeRes();
  await run(req, res);
  return res;
}

async function runPostCard(pool: Pool, es: Client, body: unknown, now: () => Date = NOW_0830) {
  const run = getChain(todayRouter(pool, es, now), 'post', '/today-card');
  const req = makeReq({ headers: authHeader(userToken('u1')), body: body as Record<string, unknown> });
  const res = makeRes();
  await run(req, res);
  return res;
}

// ---------------------------------------------------------------------------
// POST /today-card
// ---------------------------------------------------------------------------

describe('POST /today-card — agent writes the day card', () => {
  it('401s without a token', async () => {
    const { pool } = makePool([]);
    const { es } = makeEs();
    const run = getChain(todayRouter(pool, es), 'post', '/today-card');
    const res = makeRes();
    await run(makeReq({ body: { voice: 'hi' } }), res);
    expect(res._status).toBe(401);
  });

  it("upserts today's row on (user_id, day) with full-replace semantics", async () => {
    const { pool, calls } = makePool([tzMatcher('UTC'), dayCardInsertMatcher]);
    const { es } = makeEs();
    const res = await runPostCard(pool, es, {
      voice: 'Quiet morning — I am watching the 14:00 with Chen.',
      one_thing: 'Ship the deploy fix',
    });

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ status: 'ok' });

    const [sql, params] = calls.find((c) => /INSERT INTO day_cards/.test(c[0]))!;
    expect(sql).toMatch(/ON CONFLICT \(user_id, day\)/);
    expect(sql).toMatch(/voice = EXCLUDED\.voice/);
    expect(sql).toMatch(/one_thing = EXCLUDED\.one_thing/);
    expect(sql).toMatch(/updated_at = now\(\)/);
    expect(params).toEqual([
      'u1', '2026-07-05',
      'Quiet morning — I am watching the 14:00 with Chen.',
      'Ship the deploy fix',
    ]);
  });

  it("resolves TODAY in the user's effective tz (22:30Z + Asia/Jerusalem = tomorrow)", async () => {
    const { pool, calls } = makePool([tzMatcher('Asia/Jerusalem'), dayCardInsertMatcher]);
    const { es } = makeEs();
    const res = await runPostCard(pool, es, { voice: 'late note', one_thing: null },
      () => new Date('2026-07-05T22:30:00Z')); // 01:30 local, July 6

    expect(res._status).toBe(200);
    const [, params] = calls.find((c) => /INSERT INTO day_cards/.test(c[0]))!;
    expect(params[1]).toBe('2026-07-06');
  });

  it('treats omitted one_thing as null', async () => {
    const { pool, calls } = makePool([tzMatcher('UTC'), dayCardInsertMatcher]);
    const { es } = makeEs();
    const res = await runPostCard(pool, es, { voice: 'just the read' });
    expect(res._status).toBe(200);
    const [, params] = calls.find((c) => /INSERT INTO day_cards/.test(c[0]))!;
    expect(params[3]).toBeNull();
  });

  it('400s on missing/empty/oversized voice and oversized/mistyped one_thing', async () => {
    const { pool } = makePool([tzMatcher('UTC'), dayCardInsertMatcher]);
    const { es } = makeEs();
    expect((await runPostCard(pool, es, {}))._status).toBe(400);
    expect((await runPostCard(pool, es, { voice: '' }))._status).toBe(400);
    expect((await runPostCard(pool, es, { voice: 42 }))._status).toBe(400);
    expect((await runPostCard(pool, es, { voice: 'x'.repeat(401) }))._status).toBe(400);
    expect((await runPostCard(pool, es, { voice: 'ok', one_thing: 'x'.repeat(201) }))._status).toBe(400);
    expect((await runPostCard(pool, es, { voice: 'ok', one_thing: 42 }))._status).toBe(400);
    // Boundary lengths are fine.
    expect((await runPostCard(pool, es, { voice: 'x'.repeat(400), one_thing: 'y'.repeat(200) }))._status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /me/today
// ---------------------------------------------------------------------------

describe('GET /me/today — Today card aggregation', () => {
  it('401s without a token', async () => {
    const { pool } = makePool([]);
    const { es } = makeEs();
    const run = getChain(todayRouter(pool, es), 'get', '/me/today');
    const res = makeRes();
    await run(makeReq(), res);
    expect(res._status).toBe(401);
  });

  it('aggregates day card + next event + habit strip + needs-you count (quiet_since null while something needs you)', async () => {
    const { pool } = makePool([
      tzMatcher('UTC'),
      dayCardSelectMatcher([{
        voice: 'Watching the 14:00 with Chen; otherwise a quiet day.',
        one_thing: 'Ship the deploy fix',
        updated_at: new Date('2026-07-05T06:10:00Z'),
      }]),
      // Tray collectors: 08:00 daily habit, no row at 08:30 → one open item.
      trayHabitsMatcher([trayHabitRow()]),
      trayLogMatcher([]),
      // Strip: same habit, today unanswered.
      stripHabitsMatcher([stripHabitRow()]),
      stripLogMatcher([{ due_date: '2026-07-04', due_time: '08:00', outcome: 'done' }]),
      chatMessagesMatcher([{ created_at: new Date('2026-07-05T07:00:00Z') }]),
    ]);
    const { es } = makeEs([{
      _source: { title: 'Chen 1:1', start_time: '2026-07-05T14:00:00Z', location: 'office' },
    }]);
    const res = await runToday(pool, es);

    expect(res._status).toBe(200);
    const body = res._json as any;
    expect(body.voice).toBe('Watching the 14:00 with Chen; otherwise a quiet day.');
    expect(body.one_thing).toBe('Ship the deploy fix');
    expect(body.voice_updated_at).toBe('2026-07-05T06:10:00.000Z');
    expect(body.next_event).toEqual({
      title: 'Chen 1:1',
      start_local: '14:00',
      start_iso: '2026-07-05T14:00:00.000Z',
      location: 'office',
      as_of: '2026-07-05T08:30:00.000Z',
    });
    expect(body.habits).toHaveLength(1);
    expect(body.habits[0].habit_id).toBe(HABIT_ID);
    // The same open occurrence the tray shows IS the needs-you count.
    expect(body.needs_you_count).toBe(1);
    // Something needs you → not quiet, even though assistant messages exist.
    expect(body.quiet_since).toBeNull();
  });

  it('returns the empty shape + quiet_since (newest assistant message) when nothing needs you', async () => {
    const { pool } = makePool([
      tzMatcher('UTC'),
      chatMessagesMatcher([{ created_at: new Date('2026-07-05T07:42:00Z') }]),
    ]);
    const { es } = makeEs([]);
    const res = await runToday(pool, es);

    expect(res._status).toBe(200);
    expect(res._json).toEqual({
      voice: null,
      one_thing: null,
      voice_updated_at: null,
      next_event: null,
      habits: [],
      needs_you_count: 0,
      quiet_since: '2026-07-05T07:42:00.000Z',
    });
    // v1 simplification: quiet_since only queries ASSISTANT messages.
  });

  it('quiet_since is null when there are no assistant messages at all', async () => {
    const { pool, calls } = makePool([tzMatcher('UTC')]);
    const { es } = makeEs([]);
    const res = await runToday(pool, es);
    expect((res._json as any).quiet_since).toBeNull();
    const [sql, params] = calls.find((c) => /FROM chat_messages/.test(c[0]))!;
    expect(sql).toMatch(/role = 'assistant'/);
    expect(sql).toMatch(/ORDER BY created_at DESC/);
    expect(params).toEqual(['u1']);
  });

  it("queries ES for today's window, excluding instruction ticklers and all-day events", async () => {
    const { pool } = makePool([tzMatcher('UTC')]);
    const { es, search } = makeEs([]);
    await runToday(pool, es);

    expect(search).toHaveBeenCalledTimes(1);
    const q = search.mock.calls[0][0] as any;
    expect(q.index).toBe('ll5_awareness_calendar_events');
    expect(q.size).toBe(1);
    expect(q.sort).toEqual([{ start_time: 'asc' }]);
    expect(q.query.bool.filter).toEqual([
      { term: { user_id: 'u1' } },
      // Upcoming = from the query instant to local end of day (UTC here).
      { range: { start_time: { gte: '2026-07-05T08:30:00.000Z', lt: '2026-07-06T00:00:00.000Z' } } },
    ]);
    // Same exclusion the calendar review applies (kind=instruction is
    // agent-private) + all-day docs (no meaningful "next at HH:MM").
    expect(q.query.bool.must_not).toEqual([
      { term: { kind: 'instruction' } },
      { term: { all_day: true } },
    ]);
  });

  it("renders start_local in the user's effective timezone", async () => {
    const { pool } = makePool([tzMatcher('Asia/Jerusalem')]);
    const { es } = makeEs([{
      _source: { title: 'Dinner', start_time: '2026-07-05T16:30:00Z', location: null },
    }]);
    const res = await runToday(pool, es);
    const body = res._json as any;
    expect(body.next_event.start_local).toBe('19:30'); // UTC+3 in July
    expect(body.next_event.location).toBeNull();
  });

  it('maps habit log outcomes to day states: done/missed/skipped/excused/none/open, 14 days oldest-first ending today', async () => {
    const { pool } = makePool([
      tzMatcher('UTC'),
      stripHabitsMatcher([stripHabitRow()]),
      stripLogMatcher([
        { due_date: '2026-07-04', due_time: '08:00', outcome: 'done' },
        { due_date: '2026-07-03', due_time: '08:00', outcome: 'missed' },
        { due_date: '2026-07-02', due_time: '08:00', outcome: 'skipped_deliberate' },
        { due_date: '2026-07-01', due_time: '08:00', outcome: 'excused' },
        // 2026-06-30: scheduled, no row → 'none' (the sweep's business, not ours)
        // today 2026-07-05: no row → 'open'
      ]),
    ]);
    const { es } = makeEs([]);
    const res = await runToday(pool, es);

    const habit = (res._json as any).habits[0];
    expect(habit.days).toHaveLength(14);
    expect(habit.days[0].date).toBe('2026-06-22');
    expect(habit.days[13].date).toBe('2026-07-05');

    const state = (d: string) => habit.days.find((x: any) => x.date === d).state;
    expect(state('2026-07-05')).toBe('open');
    expect(state('2026-07-04')).toBe('done');
    expect(state('2026-07-03')).toBe('missed');
    expect(state('2026-07-02')).toBe('skipped'); // skipped_deliberate → skipped
    expect(state('2026-07-01')).toBe('excused');
    expect(state('2026-06-30')).toBe('none');
  });

  it("marks unscheduled days 'none' (weekly habit) and keeps today 'open' only when scheduled", async () => {
    // Mondays only; 2026-07-05 (today) is a Sunday.
    const { pool } = makePool([
      tzMatcher('UTC'),
      stripHabitsMatcher([stripHabitRow({ schedule: { days: [1], times: ['08:00'] } })]),
      stripLogMatcher([
        { due_date: '2026-06-29', due_time: '08:00', outcome: 'done' }, // a Monday
      ]),
    ]);
    const { es } = makeEs([]);
    const res = await runToday(pool, es);

    const habit = (res._json as any).habits[0];
    const state = (d: string) => habit.days.find((x: any) => x.date === d).state;
    expect(state('2026-06-29')).toBe('done');  // logged Monday
    expect(state('2026-06-22')).toBe('none');  // scheduled Monday, no row
    expect(state('2026-07-05')).toBe('none');  // today, but not scheduled → never 'open'
    expect(state('2026-07-04')).toBe('none');  // Saturday, unscheduled
  });

  it("keeps today 'open' while any of multiple daily times is unanswered", async () => {
    const { pool } = makePool([
      tzMatcher('UTC'),
      stripHabitsMatcher([stripHabitRow({ schedule: { days: 'daily', times: ['08:00', '20:00'] } })]),
      stripLogMatcher([
        { due_date: '2026-07-05', due_time: '08:00', outcome: 'done' },
        // 20:00 dose unanswered — the day is still live.
      ]),
    ]);
    const { es } = makeEs([]);
    const res = await runToday(pool, es);
    expect((res._json as any).habits[0].days[13].state).toBe('open');
  });

  it("computes the habit day window in the HABIT's timezone (22:30Z = July 6 in Asia/Jerusalem)", async () => {
    const { pool, calls } = makePool([
      tzMatcher('UTC'), // user's effective tz stays UTC — the habit's own tz must win
      stripHabitsMatcher([stripHabitRow({ timezone: 'Asia/Jerusalem' })]),
      stripLogMatcher([{ due_date: '2026-07-06', due_time: '08:00', outcome: 'done' }]),
    ]);
    const { es } = makeEs([]);
    const res = await runToday(pool, es, () => new Date('2026-07-05T22:30:00Z'));

    const habit = (res._json as any).habits[0];
    // Habit-local "today" is already July 6 even though UTC still says July 5.
    expect(habit.days[13].date).toBe('2026-07-06');
    expect(habit.days[0].date).toBe('2026-06-23');
    expect(habit.days[13].state).toBe('done');

    const [, params] = calls.find((c) => /SELECT due_date::text AS due_date/.test(c[0]))!;
    expect(params).toEqual([HABIT_ID, 'u1', '2026-06-23', '2026-07-06']);
  });

  it('needs_you_count reuses the tray collectors (contact approvals count too)', async () => {
    const { pool, calls } = makePool([
      tzMatcher('UTC'),
      (sql) => /FROM permission_change_requests/.test(sql)
        ? {
            rows: [{
              id: 'req-1', platform: null, conversation_id: null, display_name: 'Dana',
              current_permission: null, requested_permission: 'immediate',
              created_at: '2026-07-05T07:00:00.000Z',
            }],
          }
        : undefined,
    ]);
    const { es } = makeEs([]);
    const res = await runToday(pool, es);

    expect((res._json as any).needs_you_count).toBe(1);
    expect((res._json as any).quiet_since).toBeNull();
    // Proof of reuse: the tray's own source queries ran (same SQL, same scope).
    const pendingCall = calls.find((c) => /permission_change_requests/.test(c[0]))!;
    expect(pendingCall[0]).toMatch(/status = 'pending' AND expires_at > now\(\)/);
    expect(pendingCall[1]).toEqual(['u1']);
    expect(calls.some((c) => /FROM system_alerts/.test(c[0]))).toBe(true);
    expect(calls.some((c) => /SELECT id, name, description, schedule, escalation, timezone/.test(c[0]))).toBe(true);
  });

  it('500s when ES fails — no silent defaults', async () => {
    const { pool } = makePool([tzMatcher('UTC')]);
    const es = { search: vi.fn(async () => { throw new Error('ES down'); }) } as unknown as Client;
    const res = await runToday(pool, es);
    expect(res._status).toBe(500);
  });
});
