import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';

vi.mock('@ll5/shared', async (orig) => {
  const actual = await orig<typeof import('@ll5/shared')>();
  return { ...actual, logAudit: vi.fn() };
});
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createTrayRouter, enqueueReconcileConfirm, collectTrayItems } from '../tray.js';

const AUTH_SECRET = 'test-secret-key-at-least-32-characters-long!!';
const LOOP_ID = '33333333-3333-3333-3333-333333333333';
const ITEM_ID = '44444444-4444-4444-4444-444444444444';

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

// The gate's close (confirmReconcileClose) — closes only an ACTIVE horizon-0
// loop owned by params[1]. `owner` decides which user_id the loop belongs to;
// a mismatch (foreign / absent) returns rowCount 0 like the real query.
const gateCloseMatcher = (owner: string | null): Matcher =>
  (sql, params) => {
    if (!/UPDATE gtd_horizons/.test(sql) || !/status = 'completed'/.test(sql)) return undefined;
    const [loopId, userId] = params as [string, string];
    const closed = owner !== null && userId === owner && loopId === LOOP_ID;
    return { rows: [], rowCount: closed ? 1 : 0 };
  };

const trayResolveMatcher: Matcher = (sql) =>
  /UPDATE tray_items\s+SET status = 'answered', answer_key = 'confirmed'/.test(sql)
    ? { rows: [], rowCount: 1 }
    : undefined;

function trayRouter(pool: Pool) {
  return createTrayRouter(pool, AUTH_SECRET);
}

const runConfirm = async (pool: Pool, body: unknown, token = userToken('u1')) => {
  const run = getChain(trayRouter(pool), 'post', '/me/reconcile/confirm');
  const req = makeReq({ headers: authHeader(token), body: body as Record<string, unknown> });
  const res = makeRes();
  await run(req, res);
  return res;
};

describe('POST /me/reconcile/confirm — one-tap close of a consequential loop', () => {
  it('closes an active consequential loop via the gate and returns success', async () => {
    const { pool, calls } = makePool([gateCloseMatcher('u1'), trayResolveMatcher]);
    const res = await runConfirm(pool, { loop_id: LOOP_ID });

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ status: 'closed', loop_id: LOOP_ID });

    // The close ran through confirmReconcileClose: status completed, both
    // reviewed_at AND completed_at stamped, user-scoped to the TOKEN's user.
    const gate = calls.find((c) => /UPDATE gtd_horizons/.test(c[0]))!;
    expect(gate[0]).toMatch(/status = 'completed'/);
    expect(gate[0]).toMatch(/completed_at = now\(\)/);
    expect(gate[0]).toMatch(/reviewed_at = now\(\)/);
    expect(gate[0]).toMatch(/WHERE id = \$1 AND user_id = \$2 AND horizon = 0 AND status = 'active'/);
    expect(gate[1]).toEqual([LOOP_ID, 'u1']);
  });

  it('closes ONLY through the gate — the route runs no close SQL of its own', async () => {
    const { pool, calls } = makePool([gateCloseMatcher('u1'), trayResolveMatcher]);
    await runConfirm(pool, { loop_id: LOOP_ID });

    // Single writer: exactly one statement touches gtd_horizons, and it is the
    // gate's close. A second writer would show up as another gtd_horizons row.
    const loopWrites = calls.filter((c) => /gtd_horizons/.test(c[0]));
    expect(loopWrites).toHaveLength(1);
    expect(loopWrites[0][0]).toMatch(/status = 'completed'/);
    // Every OTHER statement the route issues is tray bookkeeping.
    const others = calls.filter((c) => !/gtd_horizons/.test(c[0]));
    for (const [sql] of others) expect(sql).toMatch(/tray_items/);
  });

  it('resolves exactly the caller+loop confirm card after a close', async () => {
    const { pool, calls } = makePool([gateCloseMatcher('u1'), trayResolveMatcher]);
    await runConfirm(pool, { loop_id: LOOP_ID });

    const resolve = calls.find((c) => /UPDATE tray_items/.test(c[0]))!;
    expect(resolve[0]).toMatch(
      /WHERE user_id = \$1 AND loop_id = \$2 AND kind = 'reconcile_confirm' AND status = 'open'/,
    );
    expect(resolve[1]).toEqual(['u1', LOOP_ID]);
  });

  it('returns not_found and changes nothing for a non-existent / already-closed loop', async () => {
    const { pool, calls } = makePool([gateCloseMatcher(null), trayResolveMatcher]);
    const res = await runConfirm(pool, { loop_id: LOOP_ID });

    expect(res._status).toBe(404);
    expect(res._json).toEqual({ error: 'No confirmable loop found' });
    // The gate matched no active loop → the tray card is never resolved.
    expect(calls.some((c) => /UPDATE tray_items/.test(c[0]))).toBe(false);
  });

  it('cross-tenant: user A confirming user B\'s loop closes nothing (gate is user-scoped)', async () => {
    // The loop belongs to u2; u1 presents a valid token and the same loop_id.
    const { pool, calls } = makePool([gateCloseMatcher('u2'), trayResolveMatcher]);
    const res = await runConfirm(pool, { loop_id: LOOP_ID }, userToken('u1'));

    expect(res._status).toBe(404);
    // The gate ran user-scoped to u1 and matched nothing; no tray write happened.
    const gate = calls.find((c) => /UPDATE gtd_horizons/.test(c[0]))!;
    expect(gate[1]).toEqual([LOOP_ID, 'u1']);
    expect(calls.some((c) => /UPDATE tray_items/.test(c[0]))).toBe(false);
  });

  it('400s on a malformed loop_id and never reaches the gate', async () => {
    const { pool, calls } = makePool([gateCloseMatcher('u1'), trayResolveMatcher]);
    const res = await runConfirm(pool, { loop_id: 'not-a-uuid' });
    expect(res._status).toBe(400);
    expect(calls.some((c) => /gtd_horizons/.test(c[0]))).toBe(false);
  });

  it('401s without a token', async () => {
    const { pool } = makePool([gateCloseMatcher('u1')]);
    const run = getChain(trayRouter(pool), 'post', '/me/reconcile/confirm');
    const res = makeRes();
    await run(makeReq({ body: { loop_id: LOOP_ID } }), res);
    expect(res._status).toBe(401);
  });
});

describe('enqueueReconcileConfirm — user-scoped, idempotent confirm card', () => {
  const insertMatcher: Matcher = (sql) =>
    /INSERT INTO tray_items/.test(sql) ? { rows: [{ id: ITEM_ID }], rowCount: 1 } : undefined;

  it('inserts a reconcile_confirm row scoped to the user + loop, guarded against duplicates', async () => {
    const { pool, calls } = makePool([insertMatcher]);
    const id = await enqueueReconcileConfirm(pool, 'u1', { loopId: LOOP_ID, title: 'Pay the plumber' });

    expect(id).toBe(ITEM_ID);
    const [sql, params] = calls.find((c) => /INSERT INTO tray_items/.test(c[0]))!;
    expect(sql).toMatch(/kind, question, context, options, loop_id/);
    expect(sql).toMatch(/'reconcile_confirm'/);
    // Idempotency guard: no second open card for the same user+loop.
    expect(sql).toMatch(/WHERE NOT EXISTS/);
    expect(sql).toMatch(/user_id = \$1 AND loop_id = \$4 AND kind = 'reconcile_confirm' AND status = 'open'/);
    expect(params[0]).toBe('u1');
    expect(params[1]).toBe('Shall I close out "Pay the plumber"?');
    expect(params[3]).toBe(LOOP_ID);
  });

  it('returns null when an open confirm card for the loop already exists (INSERT ... SELECT no-op)', async () => {
    const { pool } = makePool([(sql) => (/INSERT INTO tray_items/.test(sql) ? { rows: [], rowCount: 0 } : undefined)]);
    const id = await enqueueReconcileConfirm(pool, 'u1', { loopId: LOOP_ID, title: 'Pay the plumber' });
    expect(id).toBeNull();
  });
});

describe('GET /me/tray surfacing — reconcile_confirm cards', () => {
  const reconcileRowMatcher = (rows: unknown[]): Matcher =>
    (sql) => /kind = 'reconcile_confirm'/.test(sql) && /SELECT id, loop_id/.test(sql)
      ? { rows }
      : undefined;

  it('projects an open reconcile_confirm row to the frozen tray shape', async () => {
    const { pool } = makePool([
      reconcileRowMatcher([{
        id: ITEM_ID,
        loop_id: LOOP_ID,
        question: 'Shall I close out "Pay the plumber"?',
        context: "Dana replied 'all sorted, thanks'",
        created_at: '2026-07-07T09:00:00.000Z',
      }]),
    ]);
    const items = await collectTrayItems(pool, 'u1', new Date('2026-07-07T10:00:00Z'));
    const item = items.find((i) => i.kind === 'reconcile_confirm')!;
    expect(item).toEqual({
      id: `reconcile_confirm:${LOOP_ID}`,
      kind: 'reconcile_confirm',
      question: 'Shall I close out "Pay the plumber"?',
      context: "Dana replied 'all sorted, thanks'",
      created_at: '2026-07-07T09:00:00.000Z',
      escalation: { future_text: 'stays open until you confirm — I never close it on my own' },
      reconcile_confirm: { loop_id: LOOP_ID, item_id: ITEM_ID },
    });
  });

  it('is user-scoped: the collector query filters on user_id = $1', async () => {
    const { pool, calls } = makePool([reconcileRowMatcher([])]);
    await collectTrayItems(pool, 'u1', new Date('2026-07-07T10:00:00Z'));
    const q = calls.find((c) => /kind = 'reconcile_confirm'/.test(c[0]) && /SELECT id, loop_id/.test(c[0]))!;
    expect(q[0]).toMatch(/WHERE user_id = \$1 AND status = 'open' AND kind = 'reconcile_confirm'/);
    expect(q[1]).toEqual(['u1']);
  });
});
