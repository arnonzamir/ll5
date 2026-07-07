import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';

vi.mock('@ll5/shared', async (orig) => {
  const actual = await orig<typeof import('@ll5/shared')>();
  return { ...actual, logAudit: vi.fn() };
});

import { createTrayRouter } from '../tray.js';

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

function getChain(router: ReturnType<typeof createTrayRouter>, method: string, path: string) {
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
// Matchers for the tray's three sources. Home tz pinned to UTC so the injected
// clock IS local wall-clock time — 2026-07-05 is a Sunday (dow 0).
// ---------------------------------------------------------------------------

const HABIT_ID = '11111111-1111-1111-1111-111111111111';
const NOW_0830 = () => new Date('2026-07-05T08:30:00Z');

const tzMatcher: Matcher = (sql) =>
  /settings->>'current_timezone'/.test(sql)
    ? { rows: [{ current_tz: null, current_tz_at: null, home_tz: 'UTC' }] }
    : undefined;

const habitsMatcher = (habits: unknown[]): Matcher =>
  (sql) => /FROM gtd_habits\s+WHERE user_id = \$1 AND status = 'active'/.test(sql)
    ? { rows: habits }
    : undefined;

const logMatcher = (rows: unknown[]): Matcher =>
  (sql) => /SELECT due_time, outcome, steps_fired/.test(sql) ? { rows } : undefined;

const pendingApprovalsMatcher = (rows: unknown[]): Matcher =>
  (sql) => /FROM permission_change_requests/.test(sql) ? { rows } : undefined;

// The collector's read (user-scoped open rows) — distinct from the answer
// route's by-id select.
const trayItemsMatcher = (rows: unknown[]): Matcher =>
  (sql) => /FROM tray_items\s+WHERE user_id = \$1 AND status = 'open' AND kind = 'decision'/.test(sql)
    ? { rows }
    : undefined;

const vaultAlertsMatcher = (rows: unknown[]): Matcher =>
  (sql) => /FROM system_alerts/.test(sql) ? { rows } : undefined;

function habitRow(overrides: Record<string, unknown> = {}) {
  return {
    id: HABIT_ID,
    name: 'Ritalin',
    description: null,
    schedule: { days: 'daily', times: ['08:00'] },
    escalation: [
      { offset_minutes: 0, level: 'notify' },
      { offset_minutes: 45, level: 'alert' },
    ],
    timezone: 'UTC',
    ...overrides,
  };
}

function trayRouter(pool: Pool, now: () => Date = NOW_0830) {
  return createTrayRouter(pool, AUTH_SECRET, { now });
}

async function runTray(pool: Pool, now: () => Date = NOW_0830) {
  const run = getChain(trayRouter(pool, now), 'get', '/me/tray');
  const req = makeReq({ headers: authHeader(userToken('u1')) });
  const res = makeRes();
  await run(req, res);
  return res;
}

describe('GET /me/tray — Needs You aggregation', () => {
  it('401s without a token', async () => {
    const { pool } = makePool([]);
    const run = getChain(trayRouter(pool), 'get', '/me/tray');
    const res = makeRes();
    await run(makeReq(), res);
    expect(res._status).toBe(401);
  });

  it('surfaces an open habit occurrence with the next unfired step as escalation honesty', async () => {
    const { pool } = makePool([
      tzMatcher,
      habitsMatcher([habitRow()]),
      logMatcher([{ due_time: '08:00', outcome: null, steps_fired: [0] }]),
    ]);
    const res = await runTray(pool);

    expect(res._status).toBe(200);
    const items = (res._json as any).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: `habit:${HABIT_ID}:2026-07-05:08:00`,
      kind: 'habit',
      // §5a: first-person agent voice, never "you have N tasks".
      question: 'Ritalin — should I mark it taken?',
      context: null,
      created_at: '2026-07-05T08:00:00.000Z',
      // Step 0 already fired → the honest future is step 1 (alert, 08:00+45).
      escalation: { future_text: 'escalates to alert 08:45 · your rule' },
      habit: { habit_id: HABIT_ID, habit_name: 'Ritalin', due_date: '2026-07-05', due_time: '08:00' },
    });
  });

  it('includes a due habit with NO occurrence row once the first escalation step time has passed', async () => {
    const { pool } = makePool([tzMatcher, habitsMatcher([habitRow()]), logMatcher([])]);
    const res = await runTray(pool); // 08:30, first step at 08:00 — passed

    const items = (res._json as any).items;
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(`habit:${HABIT_ID}:2026-07-05:08:00`);
    // Nothing fired yet → next unfired step is the first one.
    expect(items[0].escalation.future_text).toBe('escalates to notify 08:00 · your rule');
  });

  it('hides a habit whose first escalation step time has not passed (no row yet)', async () => {
    const { pool } = makePool([
      tzMatcher,
      habitsMatcher([habitRow({ schedule: { days: 'daily', times: ['20:00'] } })]),
      logMatcher([]),
    ]);
    const res = await runTray(pool); // 08:30 < 20:00
    expect((res._json as any).items).toHaveLength(0);
  });

  it('hides closed occurrences (a logged outcome never re-asks)', async () => {
    const { pool } = makePool([
      tzMatcher,
      habitsMatcher([habitRow()]),
      logMatcher([{ due_time: '08:00', outcome: 'done', steps_fired: [0, 1] }]),
    ]);
    const res = await runTray(pool);
    expect((res._json as any).items).toHaveLength(0);
  });

  it('hides habits not scheduled today (day-of-week filter)', async () => {
    // 2026-07-05 is a Sunday (dow 0); habit scheduled Mondays only.
    const { pool } = makePool([
      tzMatcher,
      habitsMatcher([habitRow({ schedule: { days: [1], times: ['08:00'] } })]),
      logMatcher([{ due_time: '08:00', outcome: null, steps_fired: [] }]),
    ]);
    const res = await runTray(pool);
    expect((res._json as any).items).toHaveLength(0);
  });

  it("falls back to 'auto-logs missed at midnight' when every escalation step has fired", async () => {
    const { pool } = makePool([
      tzMatcher,
      habitsMatcher([habitRow()]),
      logMatcher([{ due_time: '08:00', outcome: null, steps_fired: [0, 1] }]),
    ]);
    const res = await runTray(pool);

    const items = (res._json as any).items;
    expect(items).toHaveLength(1);
    expect(items[0].escalation.future_text).toBe('auto-logs missed at midnight');
  });

  it('maps pending contact-authority requests to first-person approval items', async () => {
    const { pool, calls } = makePool([
      tzMatcher,
      pendingApprovalsMatcher([{
        id: 'req-1',
        platform: 'whatsapp',
        conversation_id: 'conv-9',
        display_name: 'Dana',
        current_permission: 'batched',
        requested_permission: 'immediate',
        created_at: '2026-07-05T07:00:00.000Z',
      }]),
    ]);
    const res = await runTray(pool);

    const items = (res._json as any).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'approval_contact:req-1',
      kind: 'approval_contact',
      question: 'May I handle Dana as "immediate"?',
      context: 'currently batched',
      created_at: '2026-07-05T07:00:00.000Z',
      escalation: { future_text: 'expires — stays denied until approved' },
      approval_contact: {
        request_id: 'req-1',
        display_name: 'Dana',
        current_permission: 'batched',
        requested_permission: 'immediate',
      },
    });
    // Same source of truth as GET /approvals/pending: pending + non-expired, caller-scoped.
    const pendingCall = calls.find((c) => /permission_change_requests/.test(c[0]))!;
    expect(pendingCall[0]).toMatch(/status = 'pending' AND expires_at > now\(\)/);
    expect(pendingCall[1]).toEqual(['u1']);
  });

  it('maps firing vault.approval.<domain> alerts to approval items', async () => {
    const { pool, calls } = makePool([
      tzMatcher,
      vaultAlertsMatcher([{
        alert_key: 'vault.approval.leumi.co.il',
        summary: 'Vault login approval needed: Bank Leumi (leumi.co.il)',
        first_seen_at: '2026-07-05T06:00:00.000Z',
      }]),
    ]);
    const res = await runTray(pool);

    const items = (res._json as any).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'approval_vault:leumi.co.il',
      kind: 'approval_vault',
      question: 'Allow me to sign in to leumi.co.il?',
      context: 'Bank Leumi',
      created_at: '2026-07-05T06:00:00.000Z',
      escalation: { future_text: 'waiting — site stays blocked until you decide' },
      approval_vault: { domain: 'leumi.co.il' },
    });
    // Only FIRING vault-approval alerts, caller-scoped.
    const alertCall = calls.find((c) => /system_alerts/.test(c[0]))!;
    expect(alertCall[0]).toMatch(/status = 'firing'/);
    expect(alertCall[1]).toEqual(['u1', 'vault.approval.%']);
  });

  it('aggregates all three kinds, newest first', async () => {
    const { pool } = makePool([
      tzMatcher,
      habitsMatcher([habitRow()]),
      logMatcher([{ due_time: '08:00', outcome: null, steps_fired: [0] }]),
      pendingApprovalsMatcher([{
        id: 'req-1', platform: null, conversation_id: null, display_name: 'Dana',
        current_permission: null, requested_permission: 'immediate',
        created_at: '2026-07-05T07:00:00.000Z',
      }]),
      vaultAlertsMatcher([{
        alert_key: 'vault.approval.leumi.co.il',
        summary: 'Vault login approval needed: leumi.co.il (leumi.co.il)',
        first_seen_at: '2026-07-05T06:00:00.000Z',
      }]),
    ]);
    const res = await runTray(pool);

    const items = (res._json as any).items;
    expect(items.map((i: any) => i.kind)).toEqual(['habit', 'approval_contact', 'approval_vault']);
    // Site name identical to the domain adds nothing → no context line.
    expect(items[2].context).toBeNull();
    // Unset current permission reads as "default".
    expect(items[1].context).toBe('currently default');
  });
});

describe('POST /me/habits/outcome — one-tap habit answer', () => {
  const runOutcome = async (pool: Pool, body: unknown, token = userToken('u1')) => {
    const run = getChain(trayRouter(pool), 'post', '/me/habits/outcome');
    const req = makeReq({ headers: authHeader(token), body: body as Record<string, unknown> });
    const res = makeRes();
    await run(req, res);
    return res;
  };

  const ownershipMatcher: Matcher = (sql) =>
    /SELECT id, name FROM gtd_habits WHERE id = \$1 AND user_id = \$2/.test(sql)
      ? { rows: [{ id: HABIT_ID, name: 'Ritalin' }] }
      : undefined;

  const upsertMatcher: Matcher = (sql) =>
    /INSERT INTO gtd_habit_log/.test(sql) ? { rows: [{ id: 'log-1' }] } : undefined;

  it('upserts on (habit_id, due_date, due_time) updating only outcome/closed_at/note — identical to the gtd tool', async () => {
    const { pool, calls } = makePool([ownershipMatcher, upsertMatcher]);
    const res = await runOutcome(pool, {
      habit_id: HABIT_ID, due_date: '2026-07-05', due_time: '08:00', outcome: 'done',
    });

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ status: 'logged', outcome: 'done' });

    // Assertions mirrored from packages/gtd habit.repository.test.ts
    // (PostgresHabitRepository.logOutcome) — the upsert semantics are a
    // shared contract with the gtd MCP's log_habit_outcome.
    const [sql, params] = calls.find((c) => /INSERT INTO gtd_habit_log/.test(c[0]))!;
    expect(sql).toMatch(/ON CONFLICT \(habit_id, due_date, due_time\)/);
    expect(sql).toMatch(/outcome = EXCLUDED\.outcome/);
    expect(sql).toMatch(/closed_at = now\(\)/);
    // Omitted note must not wipe an existing one.
    expect(sql).toMatch(/note = COALESCE\(EXCLUDED\.note, gtd_habit_log\.note\)/);
    // steps_fired stays scheduler-owned.
    expect(sql).not.toMatch(/steps_fired = /);
    // Defense-in-depth: conflicting row must belong to the same user.
    expect(sql).toMatch(/WHERE gtd_habit_log\.user_id = \$2/);
    expect(params).toEqual([HABIT_ID, 'u1', '2026-07-05', '08:00', 'done', null]);
  });

  it('passes the note through when provided', async () => {
    const { pool, calls } = makePool([ownershipMatcher, upsertMatcher]);
    const res = await runOutcome(pool, {
      habit_id: HABIT_ID, due_date: '2026-07-05', due_time: '18:00',
      outcome: 'skipped_deliberate', note: 'skipping today',
    });

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ status: 'logged', outcome: 'skipped_deliberate' });
    const [, params] = calls.find((c) => /INSERT INTO gtd_habit_log/.test(c[0]))!;
    expect(params[5]).toBe('skipping today');
  });

  it("404s when the habit does not belong to the caller (user-scoped via the habit's user_id)", async () => {
    const { pool, calls } = makePool([upsertMatcher]); // ownership select returns nothing
    const res = await runOutcome(pool, {
      habit_id: HABIT_ID, due_date: '2026-07-05', due_time: '08:00', outcome: 'done',
    });

    expect(res._status).toBe(404);
    expect(calls.some((c) => /INSERT INTO gtd_habit_log/.test(c[0]))).toBe(false);
  });

  it("400s on 'missed' — misses are the sweep's verdict, never a tray button", async () => {
    const { pool } = makePool([ownershipMatcher, upsertMatcher]);
    const res = await runOutcome(pool, {
      habit_id: HABIT_ID, due_date: '2026-07-05', due_time: '08:00', outcome: 'missed',
    });
    expect(res._status).toBe(400);
  });

  it('400s on malformed due_date / due_time / habit_id', async () => {
    const { pool } = makePool([ownershipMatcher, upsertMatcher]);
    const base = { habit_id: HABIT_ID, due_date: '2026-07-05', due_time: '08:00', outcome: 'done' };
    expect((await runOutcome(pool, { ...base, due_date: '05/07/2026' }))._status).toBe(400);
    expect((await runOutcome(pool, { ...base, due_time: '8:00' }))._status).toBe(400);
    expect((await runOutcome(pool, { ...base, habit_id: 'not-a-uuid' }))._status).toBe(400);
  });

  it('409s when the guarded upsert matches a row owned by someone else', async () => {
    const { pool } = makePool([ownershipMatcher]); // upsert returns no rows
    const res = await runOutcome(pool, {
      habit_id: HABIT_ID, due_date: '2026-07-05', due_time: '08:00', outcome: 'done',
    });
    expect(res._status).toBe(409);
  });

  it('401s without a token', async () => {
    const { pool } = makePool([]);
    const run = getChain(trayRouter(pool), 'post', '/me/habits/outcome');
    const res = makeRes();
    await run(makeReq({ body: { habit_id: HABIT_ID, due_date: '2026-07-05', due_time: '08:00', outcome: 'done' } }), res);
    expect(res._status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Agent-filed decision cards (tray_items — migration 037)
// ---------------------------------------------------------------------------

const ITEM_ID = '22222222-2222-2222-2222-222222222222';

function trayItemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_ID,
    question: 'Park the ROI ingest project?',
    context: 'untouched 34 days, no next action',
    options: [
      { key: 'a', label: 'Park it', recommended: true },
      { key: 'b', label: 'Keep active' },
      { key: 'c', label: 'Kill it' },
    ],
    default_key: 'a',
    // 2026-07-09 is a Thursday; home tz pinned to UTC by tzMatcher.
    expires_at: '2026-07-09T12:00:00.000Z',
    created_at: '2026-07-05T07:30:00.000Z',
    status: 'open',
    ...overrides,
  };
}

describe('GET /me/tray — decision items (4th source)', () => {
  it('projects an open tray_items row to the frozen decision-card shape', async () => {
    const { pool } = makePool([tzMatcher, trayItemsMatcher([trayItemRow()])]);
    const res = await runTray(pool);

    expect(res._status).toBe(200);
    const items = (res._json as any).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      id: `decision:${ITEM_ID}`,
      kind: 'decision',
      question: 'Park the ROI ingest project?',
      context: 'untouched 34 days, no next action',
      created_at: '2026-07-05T07:30:00.000Z',
      // Deadline discloses its own default — weekday + the DEFAULT's label.
      escalation: { future_text: 'Thu default: Park it · disclosed' },
      decision: {
        item_id: ITEM_ID,
        options: [
          { key: 'a', label: 'Park it', recommended: true },
          // recommended is normalised to a real boolean for the phone.
          { key: 'b', label: 'Keep active', recommended: false },
          { key: 'c', label: 'Kill it', recommended: false },
        ],
      },
    });
  });

  it("shows 'waiting — no deadline' when expires_at is null", async () => {
    const { pool } = makePool([
      tzMatcher,
      trayItemsMatcher([trayItemRow({ expires_at: null, default_key: null })]),
    ]);
    const res = await runTray(pool);
    expect((res._json as any).items[0].escalation.future_text).toBe('waiting — no deadline');
  });

  it('falls back to the recommended option when default_key is unset but a deadline exists', async () => {
    const { pool } = makePool([tzMatcher, trayItemsMatcher([trayItemRow({ default_key: null })])]);
    const res = await runTray(pool);
    expect((res._json as any).items[0].escalation.future_text).toBe('Thu default: Park it · disclosed');
  });

  it('sorts decision items into the merged list, newest first', async () => {
    const { pool } = makePool([
      tzMatcher,
      habitsMatcher([habitRow()]),
      logMatcher([{ due_time: '08:00', outcome: null, steps_fired: [0] }]),
      trayItemsMatcher([trayItemRow({ created_at: '2026-07-05T08:15:00.000Z' })]),
    ]);
    const res = await runTray(pool);
    // decision (08:15) between habit (08:00)? No — habit created_at is 08:00,
    // decision 08:15 → decision first.
    expect((res._json as any).items.map((i: any) => i.kind)).toEqual(['decision', 'habit']);
  });
});

describe('POST /tray-items — agent files a decision card', () => {
  const validBody = () => ({
    question: 'Park the ROI ingest project?',
    context: 'untouched 34 days',
    options: [
      { key: 'a', label: 'Park it', recommended: true },
      { key: 'b', label: 'Keep active' },
    ],
    default_key: 'a',
    expires_at: '2026-07-09T12:00:00.000Z', // nowFn = 2026-07-05T08:30Z → 4d out
    source: 'weekly-review',
  });

  const insertMatcher: Matcher = (sql) =>
    /INSERT INTO tray_items/.test(sql) ? { rows: [{ id: ITEM_ID }] } : undefined;

  const runPost = async (pool: Pool, body: unknown) => {
    const run = getChain(trayRouter(pool), 'post', '/tray-items');
    const req = makeReq({ headers: authHeader(userToken('u1')), body: body as Record<string, unknown> });
    const res = makeRes();
    await run(req, res);
    return res;
  };

  it('inserts a valid card and returns its id', async () => {
    const { pool, calls } = makePool([insertMatcher]);
    const res = await runPost(pool, validBody());

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ id: ITEM_ID });

    const [sql, params] = calls.find((c) => /INSERT INTO tray_items/.test(c[0]))!;
    expect(sql).toMatch(/\(user_id, question, context, options, default_key, expires_at, source\)/);
    expect(params[0]).toBe('u1');
    expect(params[1]).toBe('Park the ROI ingest project?');
    expect(params[2]).toBe('untouched 34 days');
    // Options stored normalised — recommended always a boolean.
    expect(JSON.parse(params[3] as string)).toEqual([
      { key: 'a', label: 'Park it', recommended: true },
      { key: 'b', label: 'Keep active', recommended: false },
    ]);
    expect(params[4]).toBe('a');
    expect(params[5]).toBe('2026-07-09T12:00:00.000Z');
    expect(params[6]).toBe('weekly-review');
  });

  it('accepts the minimal body (question + options only)', async () => {
    const { pool, calls } = makePool([insertMatcher]);
    const res = await runPost(pool, {
      question: 'Go with plan A or B?',
      options: [{ key: 'a', label: 'Plan A' }, { key: 'b', label: 'Plan B' }],
    });
    expect(res._status).toBe(200);
    const [, params] = calls.find((c) => /INSERT INTO tray_items/.test(c[0]))!;
    expect(params.slice(2)).toEqual([
      null,
      JSON.stringify([
        { key: 'a', label: 'Plan A', recommended: false },
        { key: 'b', label: 'Plan B', recommended: false },
      ]),
      null, null, null,
    ]);
  });

  it('400s strictly on every malformed field', async () => {
    const { pool, calls } = makePool([insertMatcher]);
    const cases: Array<Record<string, unknown>> = [
      { ...validBody(), question: '' },
      { ...validBody(), question: 'x'.repeat(201) },
      { ...validBody(), context: 'x'.repeat(301) },
      { ...validBody(), options: [{ key: 'a', label: 'Only one' }] },          // < 2
      { ...validBody(), options: Array.from({ length: 4 }, (_, i) => ({ key: `k${i}`, label: `L${i}` })) }, // > 3
      { ...validBody(), options: [{ key: 'a', label: 'A' }, { key: 'a', label: 'Dup' }] }, // dup keys
      { ...validBody(), options: [{ key: 'a', label: 'A' }, { key: 'b' }] },   // missing label
      { ...validBody(), options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B', recommended: 'yes' }] },
      { ...validBody(), default_key: 'z' },                                     // not an option key
      { ...validBody(), expires_at: 'not-a-date' },
      { ...validBody(), expires_at: '2026-07-01T00:00:00Z' },                   // in the past
      { ...validBody(), expires_at: '2026-07-25T00:00:00Z' },                   // > 14 days out
      { ...validBody(), source: 42 },
    ];
    for (const body of cases) {
      const res = await runPost(pool, body);
      expect(res._status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    expect(calls.some((c) => /INSERT INTO tray_items/.test(c[0]))).toBe(false);
  });

  it('401s without a token', async () => {
    const { pool } = makePool([insertMatcher]);
    const run = getChain(trayRouter(pool), 'post', '/tray-items');
    const res = makeRes();
    await run(makeReq({ body: validBody() }), res);
    expect(res._status).toBe(401);
  });
});

describe('POST /me/tray/decision — one-tap decision answer', () => {
  const itemSelectMatcher = (rows: unknown[]): Matcher =>
    (sql) => /FROM tray_items\s+WHERE id = \$1 AND user_id = \$2/.test(sql) ? { rows } : undefined;

  const answerUpdateMatcher: Matcher = (sql) =>
    /UPDATE tray_items\s+SET status = 'answered'/.test(sql) ? { rows: [], rowCount: 1 } : undefined;

  const chatInsertMatcher: Matcher = (sql) =>
    /INSERT INTO chat_messages/.test(sql) ? { rows: [{ id: 'msg-1' }] } : undefined;

  const runDecision = async (pool: Pool, body: unknown) => {
    const run = getChain(trayRouter(pool), 'post', '/me/tray/decision');
    const req = makeReq({ headers: authHeader(userToken('u1')), body: body as Record<string, unknown> });
    const res = makeRes();
    await run(req, res);
    return res;
  };

  it('flips the row to answered and hands the choice to the agent as a system message', async () => {
    const { pool, calls } = makePool([
      itemSelectMatcher([trayItemRow()]),
      answerUpdateMatcher,
      chatInsertMatcher,
    ]);
    const res = await runDecision(pool, { item_id: ITEM_ID, answer_key: 'b' });

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ status: 'answered' });

    const [updateSql, updateParams] = calls.find((c) => /UPDATE tray_items/.test(c[0]))!;
    expect(updateSql).toMatch(/SET status = 'answered', answer_key = \$3, answered_at = now\(\)/);
    // Guarded: only an OPEN row of THIS user flips (race with expiry sweep).
    expect(updateSql).toMatch(/WHERE id = \$1 AND user_id = \$2 AND status = 'open'/);
    expect(updateParams).toEqual([ITEM_ID, 'u1', 'b']);

    // The agent applies the decision — the system message carries the LABEL.
    const [, msgParams] = calls.find((c) => /INSERT INTO chat_messages/.test(c[0]))!;
    expect(msgParams[1]).toBe("[Decision] user chose 'Keep active' for: Park the ROI ingest project?");
  });

  it("400s when answer_key is not one of the card's options", async () => {
    const { pool, calls } = makePool([itemSelectMatcher([trayItemRow()]), answerUpdateMatcher, chatInsertMatcher]);
    const res = await runDecision(pool, { item_id: ITEM_ID, answer_key: 'z' });
    expect(res._status).toBe(400);
    expect(calls.some((c) => /UPDATE tray_items/.test(c[0]))).toBe(false);
  });

  it('404s when the item is missing, foreign, or no longer open', async () => {
    const missing = makePool([itemSelectMatcher([])]);
    expect((await runDecision(missing.pool, { item_id: ITEM_ID, answer_key: 'a' }))._status).toBe(404);

    const answered = makePool([itemSelectMatcher([trayItemRow({ status: 'answered' })])]);
    expect((await runDecision(answered.pool, { item_id: ITEM_ID, answer_key: 'a' }))._status).toBe(404);
    expect(answered.calls.some((c) => /UPDATE tray_items/.test(c[0]))).toBe(false);
  });

  it('404s when the guarded update matches nothing (expiry-sweep race) and sends no message', async () => {
    const { pool, calls } = makePool([
      itemSelectMatcher([trayItemRow()]),
      (sql) => (/UPDATE tray_items/.test(sql) ? { rows: [], rowCount: 0 } : undefined),
      chatInsertMatcher,
    ]);
    const res = await runDecision(pool, { item_id: ITEM_ID, answer_key: 'a' });
    expect(res._status).toBe(404);
    expect(calls.some((c) => /INSERT INTO chat_messages/.test(c[0]))).toBe(false);
  });

  it('400s on malformed item_id / answer_key', async () => {
    const { pool } = makePool([itemSelectMatcher([trayItemRow()])]);
    expect((await runDecision(pool, { item_id: 'not-a-uuid', answer_key: 'a' }))._status).toBe(400);
    expect((await runDecision(pool, { item_id: ITEM_ID, answer_key: '' }))._status).toBe(400);
    expect((await runDecision(pool, { item_id: ITEM_ID }))._status).toBe(400);
  });

  it('401s without a token', async () => {
    const { pool } = makePool([]);
    const run = getChain(trayRouter(pool), 'post', '/me/tray/decision');
    const res = makeRes();
    await run(makeReq({ body: { item_id: ITEM_ID, answer_key: 'a' } }), res);
    expect(res._status).toBe(401);
  });
});
