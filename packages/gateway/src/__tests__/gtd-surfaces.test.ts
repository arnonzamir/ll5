import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';

vi.mock('@ll5/shared', async (orig) => {
  const actual = await orig<typeof import('@ll5/shared')>();
  return { ...actual, logAudit: vi.fn() };
});

import { createGtdSurfacesRouter } from '../gtd-surfaces.js';

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

function getChain(router: ReturnType<typeof createGtdSurfacesRouter>, method: string, path: string) {
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

const NOW = () => new Date('2026-07-05T08:30:00Z'); // Sunday

const tzMatcher = (homeTz: string): Matcher => (sql) =>
  /settings->>'current_timezone'/.test(sql)
    ? { rows: [{ current_tz: null, current_tz_at: null, home_tz: homeTz }] }
    : undefined;

const INBOX_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const ACTION_ID = 'bbbbbbbb-1111-2222-3333-444444444444';

async function run(
  pool: Pool,
  method: string,
  path: string,
  { params = {}, body = {}, token = userToken('u1') }: {
    params?: Record<string, string>; body?: unknown; token?: string | null;
  } = {},
) {
  const router = createGtdSurfacesRouter(pool, AUTH_SECRET, { now: NOW });
  const handler = getChain(router, method, path);
  const req = makeReq({
    headers: token ? authHeader(token) : {},
    params: params as any,
    body: body as Record<string, unknown>,
  });
  const res = makeRes();
  await handler(req, res);
  return res;
}

// ---------------------------------------------------------------------------
// GET /me/inbox
// ---------------------------------------------------------------------------

describe('GET /me/inbox — swipe-triage page', () => {
  it('401s without a token', async () => {
    const { pool } = makePool([]);
    const res = await run(pool, 'get', '/me/inbox', { token: null });
    expect(res._status).toBe(401);
  });

  it('returns captured items oldest-first (limit 10) with the honest remainder', async () => {
    const { pool, calls } = makePool([
      (sql) => /SELECT id, content, source, created_at/.test(sql)
        ? {
            rows: Array.from({ length: 10 }, (_, i) => ({
              id: `00000000-0000-0000-0000-00000000000${i}`,
              content: `item ${i}`,
              source: i === 0 ? 'conversation' : null,
              created_at: new Date(Date.UTC(2026, 6, 1, i)),
            })),
          }
        : undefined,
      (sql) => /SELECT COUNT\(\*\) AS count FROM gtd_inbox/.test(sql)
        ? { rows: [{ count: '46' }] }
        : undefined,
    ]);

    const res = await run(pool, 'get', '/me/inbox');
    expect(res._status).toBe(200);
    const body = res._json as any;
    expect(body.items).toHaveLength(10);
    expect(body.items[0]).toEqual({
      id: '00000000-0000-0000-0000-000000000000',
      content: 'item 0',
      source: 'conversation',
      created_at: '2026-07-01T00:00:00.000Z',
    });
    expect(body.remaining).toBe(36); // 46 total - 10 returned

    const [sql, params] = calls.find((c) => /SELECT id, content, source/.test(c[0]))!;
    expect(sql).toMatch(/status = 'captured'/);
    expect(sql).toMatch(/ORDER BY created_at ASC/);
    expect(sql).toMatch(/LIMIT 10/);
    expect(params).toEqual(['u1']);
  });

  it('degrades to empty when gtd_inbox is missing (42P01)', async () => {
    const { pool } = makePool([
      (sql) => /gtd_inbox/.test(sql) ? (() => { throw Object.assign(new Error('missing'), { code: '42P01' }); })() : undefined,
    ]);
    const res = await run(pool, 'get', '/me/inbox');
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ items: [], remaining: 0 });
  });
});

// ---------------------------------------------------------------------------
// POST /me/inbox/:id/triage
// ---------------------------------------------------------------------------

const inboxItemMatcher = (content: string, status = 'captured'): Matcher =>
  (sql) => /SELECT id, content, status FROM gtd_inbox/.test(sql)
    ? { rows: [{ id: INBOX_ID, content, status }] }
    : undefined;

const inboxProcessMatcher: Matcher = (sql) =>
  /UPDATE gtd_inbox/.test(sql) ? { rows: [{ id: INBOX_ID }], rowCount: 1 } : undefined;

const actionInsertMatcher: Matcher = (sql) =>
  /INSERT INTO gtd_horizons/.test(sql) ? { rows: [{ id: ACTION_ID }] } : undefined;

const sysMsgMatcher: Matcher = (sql) =>
  /INSERT INTO chat_messages/.test(sql) ? { rows: [{ id: 'msg-1' }] } : undefined;

describe('POST /me/inbox/:id/triage — mirrors gtd process_inbox_item', () => {
  it('trash → processed / outcome_type trash, no action created, no system message', async () => {
    const { pool, calls } = makePool([inboxItemMatcher('old flyer'), inboxProcessMatcher]);
    const res = await run(pool, 'post', '/me/inbox/:id/triage', {
      params: { id: INBOX_ID }, body: { action: 'trash' },
    });

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ status: 'triaged', action: 'trash', inbox_id: INBOX_ID, action_id: null });

    const [sql, params] = calls.find((c) => /UPDATE gtd_inbox/.test(c[0]))!;
    expect(sql).toMatch(/status = 'processed'/);
    expect(sql).toMatch(/processed_at = now\(\)/);
    expect(params).toEqual([INBOX_ID, 'u1', 'trash', null]);
    expect(calls.some((c) => /INSERT INTO gtd_horizons/.test(c[0]))).toBe(false);
    expect(calls.some((c) => /INSERT INTO chat_messages/.test(c[0]))).toBe(false);
  });

  it('someday → processed / outcome_type someday', async () => {
    const { pool, calls } = makePool([inboxItemMatcher('learn cello'), inboxProcessMatcher]);
    const res = await run(pool, 'post', '/me/inbox/:id/triage', {
      params: { id: INBOX_ID }, body: { action: 'someday' },
    });
    expect(res._status).toBe(200);
    const [, params] = calls.find((c) => /UPDATE gtd_inbox/.test(c[0]))!;
    expect(params[2]).toBe('someday');
  });

  it('keep → creates an ACTIVE horizon-0 todo action and links it as outcome_id (no system message)', async () => {
    const { pool, calls } = makePool([
      inboxItemMatcher('  call the   plumber about the boiler '),
      actionInsertMatcher,
      inboxProcessMatcher,
    ]);
    const res = await run(pool, 'post', '/me/inbox/:id/triage', {
      params: { id: INBOX_ID }, body: { action: 'keep' },
    });

    expect(res._status).toBe(200);
    expect((res._json as any).action_id).toBe(ACTION_ID);

    const [insertSql, insertParams] = calls.find((c) => /INSERT INTO gtd_horizons/.test(c[0]))!;
    expect(insertSql).toMatch(/horizon, title, status, energy, list_type, context, category/);
    expect(insertSql).toMatch(/'todo'/);
    expect(insertSql).toMatch(/'medium'/);
    expect(insertSql).toMatch(/category[\s\S]*NULL/);
    // Whitespace-flattened title.
    expect(insertParams).toEqual(['u1', 'call the plumber about the boiler', 'active']);

    const [, processParams] = calls.find((c) => /UPDATE gtd_inbox/.test(c[0]))!;
    expect(processParams).toEqual([INBOX_ID, 'u1', 'action', ACTION_ID]);

    // Per-swipe triage inserts NOTHING for the agent — the batch summary does.
    expect(calls.some((c) => /INSERT INTO chat_messages/.test(c[0]))).toBe(false);
  });

  it('keep trims the action title to ≤200 chars', async () => {
    const { pool, calls } = makePool([
      inboxItemMatcher('x'.repeat(500)),
      actionInsertMatcher,
      inboxProcessMatcher,
    ]);
    await run(pool, 'post', '/me/inbox/:id/triage', {
      params: { id: INBOX_ID }, body: { action: 'keep' },
    });
    const [, insertParams] = calls.find((c) => /INSERT INTO gtd_horizons/.test(c[0]))!;
    expect((insertParams[1] as string).length).toBe(200);
  });

  it('done → creates the action pre-completed (status completed, completed_at now)', async () => {
    const { pool, calls } = makePool([
      inboxItemMatcher('water the plants'),
      actionInsertMatcher,
      inboxProcessMatcher,
    ]);
    const res = await run(pool, 'post', '/me/inbox/:id/triage', {
      params: { id: INBOX_ID }, body: { action: 'done' },
    });

    expect(res._status).toBe(200);
    const [insertSql, insertParams] = calls.find((c) => /INSERT INTO gtd_horizons/.test(c[0]))!;
    expect(insertSql).toMatch(/CASE WHEN \$3 = 'completed' THEN now\(\) ELSE NULL END/);
    expect(insertParams[2]).toBe('completed');
    const [, processParams] = calls.find((c) => /UPDATE gtd_inbox/.test(c[0]))!;
    expect(processParams[2]).toBe('action');
    expect(processParams[3]).toBe(ACTION_ID);
  });

  it('reference → processed / outcome_type reference, NO action, one [Inbox → Reference] message', async () => {
    const { pool, calls } = makePool([
      inboxItemMatcher('  the wifi   password is hunter2 '),
      inboxProcessMatcher,
      sysMsgMatcher,
    ]);
    const res = await run(pool, 'post', '/me/inbox/:id/triage', {
      params: { id: INBOX_ID }, body: { action: 'reference' },
    });

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ status: 'filed', action: 'reference', inbox_id: INBOX_ID });

    const [sql, params] = calls.find((c) => /UPDATE gtd_inbox/.test(c[0]))!;
    expect(sql).toMatch(/status = 'processed'/);
    expect(sql).toMatch(/outcome_type = 'reference'/);
    expect(sql).toMatch(/processed_at = now\(\)/);
    expect(params).toEqual([INBOX_ID, 'u1']);

    // No gtd action is created for a reference.
    expect(calls.some((c) => /INSERT INTO gtd_horizons/.test(c[0]))).toBe(false);

    // Exactly one self-announcing system message, with the frozen prefix + content.
    const msgs = calls.filter((c) => /INSERT INTO chat_messages/.test(c[0]));
    expect(msgs).toHaveLength(1);
    const content = msgs[0][1][1] as string;
    expect(content).toContain('[Inbox → Reference] The user filed this as reference (not actionable, not trash): ');
    expect(content).toContain('the wifi password is hunter2'); // whitespace-flattened
    expect(content).toContain('personal-knowledge');
  });

  it('project → reviewed (NOT processed), notes triage:project, one [Inbox → Project] message', async () => {
    const { pool, calls } = makePool([
      inboxItemMatcher('build a greenhouse in the yard'),
      inboxProcessMatcher,
      sysMsgMatcher,
    ]);
    const res = await run(pool, 'post', '/me/inbox/:id/triage', {
      params: { id: INBOX_ID }, body: { action: 'project' },
    });

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ status: 'pending_agent', action: 'project', inbox_id: INBOX_ID });

    const [sql, params] = calls.find((c) => /UPDATE gtd_inbox/.test(c[0]))!;
    expect(sql).toMatch(/status = 'reviewed'/);
    expect(sql).not.toMatch(/status = 'processed'/);
    expect(sql).toMatch(/notes = COALESCE/);
    expect(params).toEqual([INBOX_ID, 'u1', 'triage:project']);

    // Deferred: nothing is created synchronously.
    expect(calls.some((c) => /INSERT INTO gtd_horizons/.test(c[0]))).toBe(false);

    const msgs = calls.filter((c) => /INSERT INTO chat_messages/.test(c[0]));
    expect(msgs).toHaveLength(1);
    const content = msgs[0][1][1] as string;
    expect(content).toContain('[Inbox → Project] The user wants this handled as a PROJECT: ');
    expect(content).toContain('build a greenhouse in the yard');
    expect(content).toContain(`(inbox id ${INBOX_ID})`);
    expect(content).toContain('add_tray_item');
  });

  it('followup → reviewed (NOT processed), notes triage:followup, one [Inbox → Follow-up] message', async () => {
    const { pool, calls } = makePool([
      inboxItemMatcher('chase the landlord about the deposit'),
      inboxProcessMatcher,
      sysMsgMatcher,
    ]);
    const res = await run(pool, 'post', '/me/inbox/:id/triage', {
      params: { id: INBOX_ID }, body: { action: 'followup' },
    });

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ status: 'pending_agent', action: 'followup', inbox_id: INBOX_ID });

    const [sql, params] = calls.find((c) => /UPDATE gtd_inbox/.test(c[0]))!;
    expect(sql).toMatch(/status = 'reviewed'/);
    expect(sql).not.toMatch(/status = 'processed'/);
    expect(params).toEqual([INBOX_ID, 'u1', 'triage:followup']);

    expect(calls.some((c) => /INSERT INTO gtd_horizons/.test(c[0]))).toBe(false);

    const msgs = calls.filter((c) => /INSERT INTO chat_messages/.test(c[0]));
    expect(msgs).toHaveLength(1);
    const content = msgs[0][1][1] as string;
    expect(content).toContain('[Inbox → Follow-up] The user wants a follow-up on: ');
    expect(content).toContain('chase the landlord about the deposit');
    expect(content).toContain(`(inbox id ${INBOX_ID})`);
    expect(content).toContain('Waiting for');
  });

  it('rejects an unknown action (enum) — reference/project/followup are the only new adds', async () => {
    const { pool } = makePool([]);
    expect((await run(pool, 'post', '/me/inbox/:id/triage', {
      params: { id: INBOX_ID }, body: { action: 'file' },
    }))._status).toBe(400);
    expect((await run(pool, 'post', '/me/inbox/:id/triage', {
      params: { id: INBOX_ID }, body: { action: 'delegate' },
    }))._status).toBe(400);
  });

  it('404s for an unknown item, 409s for an already-processed one', async () => {
    const { pool: emptyPool } = makePool([]);
    expect((await run(emptyPool, 'post', '/me/inbox/:id/triage', {
      params: { id: INBOX_ID }, body: { action: 'keep' },
    }))._status).toBe(404);

    const { pool: processedPool } = makePool([inboxItemMatcher('done already', 'processed')]);
    expect((await run(processedPool, 'post', '/me/inbox/:id/triage', {
      params: { id: INBOX_ID }, body: { action: 'keep' },
    }))._status).toBe(409);
  });

  it('compensates the created action when the process-write loses a race (409, no orphan)', async () => {
    const { pool, calls } = makePool([
      inboxItemMatcher('call mom'),
      actionInsertMatcher,
      (sql) => /UPDATE gtd_inbox/.test(sql) ? { rows: [], rowCount: 0 } : undefined,
      (sql) => /DELETE FROM gtd_horizons/.test(sql) ? { rows: [{ id: ACTION_ID }] } : undefined,
    ]);
    const res = await run(pool, 'post', '/me/inbox/:id/triage', {
      params: { id: INBOX_ID }, body: { action: 'keep' },
    });
    expect(res._status).toBe(409);
    const del = calls.find((c) => /DELETE FROM gtd_horizons/.test(c[0]))!;
    expect(del[1]).toEqual([ACTION_ID, 'u1']);
  });

  it('400s on a bad action or a non-UUID id', async () => {
    const { pool } = makePool([]);
    expect((await run(pool, 'post', '/me/inbox/:id/triage', {
      params: { id: INBOX_ID }, body: { action: 'archive' },
    }))._status).toBe(400);
    expect((await run(pool, 'post', '/me/inbox/:id/triage', {
      params: { id: 'nope' }, body: { action: 'keep' },
    }))._status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /me/inbox/triage-summary
// ---------------------------------------------------------------------------

describe('POST /me/inbox/triage-summary — ONE batch message to the agent', () => {
  it('inserts a single [Inbox Triage] system message with counts + kept titles', async () => {
    const { pool, calls } = makePool([
      (sql) => /SELECT id, title FROM gtd_horizons/.test(sql)
        ? { rows: [{ id: ACTION_ID, title: 'call the plumber about the boiler' }] }
        : undefined,
      (sql) => /INSERT INTO chat_messages/.test(sql) ? { rows: [{ id: 'msg-1' }] } : undefined,
    ]);

    const res = await run(pool, 'post', '/me/inbox/triage-summary', {
      body: { kept: [ACTION_ID], trashed: 3, someday: 1, done: 2 },
    });

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ status: 'ok', message_id: 'msg-1' });

    const messageInserts = calls.filter((c) => /INSERT INTO chat_messages/.test(c[0]));
    expect(messageInserts).toHaveLength(1);
    const content = messageInserts[0][1][1] as string;
    expect(content).toContain('[Inbox Triage]');
    expect(content).toContain('1 kept, 2 done on the spot, 3 trashed, 1 to someday');
    expect(content).toContain('call the plumber about the boiler');
    expect(content).toContain(ACTION_ID);
    expect(content).toMatch(/infer context tags and energy/i);

    // Kept lookup is user-scoped.
    const [lookupSql, lookupParams] = calls.find((c) => /SELECT id, title FROM gtd_horizons/.test(c[0]))!;
    expect(lookupSql).toMatch(/user_id = \$1/);
    expect(lookupParams).toEqual(['u1', [ACTION_ID]]);
  });

  it('accepts a keep-less batch (counts only, no refine instruction)', async () => {
    const { pool, calls } = makePool([
      (sql) => /INSERT INTO chat_messages/.test(sql) ? { rows: [{ id: 'msg-2' }] } : undefined,
    ]);
    const res = await run(pool, 'post', '/me/inbox/triage-summary', { body: { trashed: 4 } });
    expect(res._status).toBe(200);
    const content = calls.find((c) => /INSERT INTO chat_messages/.test(c[0]))![1][1] as string;
    expect(content).toContain('0 kept, 0 done on the spot, 4 trashed, 0 to someday');
    expect(content).not.toMatch(/infer context tags/i);
  });

  it('400s on an empty summary or malformed fields', async () => {
    const { pool } = makePool([]);
    expect((await run(pool, 'post', '/me/inbox/triage-summary', { body: {} }))._status).toBe(400);
    expect((await run(pool, 'post', '/me/inbox/triage-summary', { body: { kept: ['nope'] } }))._status).toBe(400);
    expect((await run(pool, 'post', '/me/inbox/triage-summary', { body: { trashed: -1 } }))._status).toBe(400);
    expect((await run(pool, 'post', '/me/inbox/triage-summary', { body: { trashed: 1.5 } }))._status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Shopping
// ---------------------------------------------------------------------------

describe('GET /me/shopping — store-grouped checklist (gtd category axis)', () => {
  it('groups items by category with checked = completed; null category = null store', async () => {
    const { pool, calls } = makePool([
      (sql) => /list_type = 'shopping'/.test(sql) && /SELECT id, title, status, category/.test(sql)
        ? {
            rows: [
              { id: 'i1', title: 'Milk', status: 'active', category: 'Supermarket' },
              { id: 'i2', title: 'Eggs (12)', status: 'completed', category: 'Supermarket' },
              { id: 'i3', title: 'Screws', status: 'active', category: 'Hardware' },
              { id: 'i4', title: 'Batteries', status: 'active', category: null },
            ],
          }
        : undefined,
    ]);

    const res = await run(pool, 'get', '/me/shopping');
    expect(res._status).toBe(200);
    expect(res._json).toEqual({
      stores: [
        {
          name: 'Supermarket',
          items: [
            { id: 'i1', title: 'Milk', checked: false },
            { id: 'i2', title: 'Eggs (12)', checked: true },
          ],
        },
        { name: 'Hardware', items: [{ id: 'i3', title: 'Screws', checked: false }] },
        { name: null, items: [{ id: 'i4', title: 'Batteries', checked: false }] },
      ],
    });

    // Mirrors the gtd tool's list: shopping list_type, active+completed,
    // start-date gate, the repo's ordering, capped at 200.
    const [sql, params] = calls.find((c) => /list_type = 'shopping'/.test(c[0]))!;
    expect(sql).toMatch(/status IN \('active', 'completed'\)/);
    expect(sql).toMatch(/start_date IS NULL OR start_date <= CURRENT_DATE/);
    expect(sql).toMatch(/ORDER BY due_date ASC NULLS LAST, created_at DESC/);
    expect(sql).toMatch(/LIMIT 200/);
    expect(params).toEqual(['u1']);
  });

  it('degrades to empty stores when gtd_horizons is missing (42P01)', async () => {
    const { pool } = makePool([
      (sql) => /list_type = 'shopping'/.test(sql)
        ? (() => { throw Object.assign(new Error('missing'), { code: '42P01' }); })()
        : undefined,
    ]);
    const res = await run(pool, 'get', '/me/shopping');
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ stores: [] });
  });
});

describe('POST /me/shopping — add item (mirror of the gtd add)', () => {
  it('inserts a horizon-0 shopping action with energy low and category = store', async () => {
    const { pool, calls } = makePool([
      (sql) => /INSERT INTO gtd_horizons/.test(sql)
        ? { rows: [{ id: 'i9', title: 'Olive oil', category: 'Supermarket' }] }
        : undefined,
    ]);
    const res = await run(pool, 'post', '/me/shopping', {
      body: { title: 'Olive oil', store: 'Supermarket' },
    });

    expect(res._status).toBe(200);
    expect(res._json).toEqual({
      item: { id: 'i9', title: 'Olive oil', checked: false, store: 'Supermarket' },
    });
    const [sql, params] = calls.find((c) => /INSERT INTO gtd_horizons/.test(c[0]))!;
    expect(sql).toMatch(/'low', 'shopping'/);
    expect(params).toEqual(['u1', 'Olive oil', 'Supermarket']);
  });

  it('store is optional → category null', async () => {
    const { pool, calls } = makePool([
      (sql) => /INSERT INTO gtd_horizons/.test(sql)
        ? { rows: [{ id: 'i9', title: 'Bread', category: null }] }
        : undefined,
    ]);
    const res = await run(pool, 'post', '/me/shopping', { body: { title: 'Bread' } });
    expect(res._status).toBe(200);
    expect((res._json as any).item.store).toBeNull();
    const [, params] = calls.find((c) => /INSERT INTO gtd_horizons/.test(c[0]))!;
    expect(params[2]).toBeNull();
  });

  it('400s on a missing/empty title', async () => {
    const { pool } = makePool([]);
    expect((await run(pool, 'post', '/me/shopping', { body: {} }))._status).toBe(400);
    expect((await run(pool, 'post', '/me/shopping', { body: { title: '   ' } }))._status).toBe(400);
    expect((await run(pool, 'post', '/me/shopping', { body: { title: 5 } }))._status).toBe(400);
  });
});

describe('POST /me/shopping/:id/check — gtd complete/re-open lifecycle', () => {
  const ITEM_ID = 'cccccccc-1111-2222-3333-444444444444';

  it('checked=true → status completed + completed_at now, scoped to shopping rows', async () => {
    const { pool, calls } = makePool([
      (sql) => /UPDATE gtd_horizons/.test(sql) ? { rows: [{ id: ITEM_ID, title: 'Milk' }] } : undefined,
    ]);
    const res = await run(pool, 'post', '/me/shopping/:id/check', {
      params: { id: ITEM_ID }, body: { checked: true },
    });

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ status: 'ok', checked: true });
    const [sql, params] = calls.find((c) => /UPDATE gtd_horizons/.test(c[0]))!;
    expect(sql).toMatch(/status = 'completed', completed_at = now\(\)/);
    expect(sql).toMatch(/list_type = 'shopping'/);
    expect(params).toEqual([ITEM_ID, 'u1']);
  });

  it('checked=false → re-open: status active + completed_at cleared (exactly the gtd repo behavior)', async () => {
    const { pool, calls } = makePool([
      (sql) => /UPDATE gtd_horizons/.test(sql) ? { rows: [{ id: ITEM_ID, title: 'Milk' }] } : undefined,
    ]);
    const res = await run(pool, 'post', '/me/shopping/:id/check', {
      params: { id: ITEM_ID }, body: { checked: false },
    });
    expect(res._status).toBe(200);
    const [sql] = calls.find((c) => /UPDATE gtd_horizons/.test(c[0]))!;
    expect(sql).toMatch(/status = 'active', completed_at = NULL/);
  });

  it('404s for an unknown/foreign item, 400s on bad input', async () => {
    const { pool } = makePool([]);
    expect((await run(pool, 'post', '/me/shopping/:id/check', {
      params: { id: ITEM_ID }, body: { checked: true },
    }))._status).toBe(404);
    expect((await run(pool, 'post', '/me/shopping/:id/check', {
      params: { id: ITEM_ID }, body: {},
    }))._status).toBe(400);
    expect((await run(pool, 'post', '/me/shopping/:id/check', {
      params: { id: 'nope' }, body: { checked: true },
    }))._status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Today's actions
// ---------------------------------------------------------------------------

describe("GET /me/actions/today — the agent's ≤7-row plan viewport", () => {
  it('lists active horizon-0 non-shopping actions due ≤ today, first context tag as the context word', async () => {
    const { pool, calls } = makePool([
      tzMatcher('UTC'),
      (sql) => /due_date::text AS due_date/.test(sql)
        ? {
            rows: [
              { id: 'a1', title: 'File the VAT report', context: ['computer', 'office'], due_date: '2026-07-04' },
              { id: 'a2', title: 'Call the dentist', context: [], due_date: '2026-07-05' },
            ],
          }
        : undefined,
    ]);

    const res = await run(pool, 'get', '/me/actions/today');
    expect(res._status).toBe(200);
    expect(res._json).toEqual({
      items: [
        { id: 'a1', title: 'File the VAT report', context: 'computer', due_date: '2026-07-04' },
        { id: 'a2', title: 'Call the dentist', context: null, due_date: '2026-07-05' },
      ],
    });

    const [sql, params] = calls.find((c) => /due_date::text AS due_date/.test(c[0]))!;
    expect(sql).toMatch(/horizon = 0 AND status = 'active'/);
    expect(sql).toMatch(/list_type IS NULL OR list_type <> 'shopping'/);
    expect(sql).toMatch(/due_date IS NOT NULL AND due_date <= \$2/);
    expect(sql).toMatch(/ORDER BY due_date ASC, created_at ASC/);
    expect(sql).toMatch(/LIMIT 7/);
    expect(params).toEqual(['u1', '2026-07-05']);
  });

  it("resolves 'today' in the effective tz (22:30Z + Asia/Jerusalem = July 6)", async () => {
    const { pool, calls } = makePool([tzMatcher('Asia/Jerusalem')]);
    const router = createGtdSurfacesRouter(pool, AUTH_SECRET, { now: () => new Date('2026-07-05T22:30:00Z') });
    const handler = getChain(router, 'get', '/me/actions/today');
    const res = makeRes();
    await handler(makeReq({ headers: authHeader(userToken('u1')) }), res);
    const [, params] = calls.find((c) => /due_date::text AS due_date/.test(c[0]))!;
    expect(params[1]).toBe('2026-07-06');
  });

  it('degrades to empty when gtd_horizons is missing (42P01)', async () => {
    const { pool } = makePool([
      tzMatcher('UTC'),
      (sql) => /due_date::text AS due_date/.test(sql)
        ? (() => { throw Object.assign(new Error('missing'), { code: '42P01' }); })()
        : undefined,
    ]);
    const res = await run(pool, 'get', '/me/actions/today');
    expect(res._status).toBe(200);
    expect(res._json).toEqual({ items: [] });
  });
});

describe('POST /me/actions/:id/complete', () => {
  it('completes idempotently — keeps the FIRST completion time via COALESCE', async () => {
    const { pool, calls } = makePool([
      (sql) => /UPDATE gtd_horizons/.test(sql) ? { rows: [{ id: ACTION_ID, title: 'Call the dentist' }] } : undefined,
    ]);
    const res = await run(pool, 'post', '/me/actions/:id/complete', { params: { id: ACTION_ID } });

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ status: 'completed' });
    const [sql, params] = calls.find((c) => /UPDATE gtd_horizons/.test(c[0]))!;
    expect(sql).toMatch(/status = 'completed'/);
    expect(sql).toMatch(/completed_at = COALESCE\(completed_at, now\(\)\)/);
    expect(sql).toMatch(/horizon = 0/);
    expect(params).toEqual([ACTION_ID, 'u1']);
  });

  it('404s for an unknown action', async () => {
    const { pool } = makePool([]);
    expect((await run(pool, 'post', '/me/actions/:id/complete', {
      params: { id: ACTION_ID },
    }))._status).toBe(404);
  });
});

describe('POST /me/actions/:id/defer', () => {
  it('moves due_date to tomorrow (effective tz), appends a note marker, and tells the agent', async () => {
    const { pool, calls } = makePool([
      tzMatcher('Asia/Jerusalem'),
      (sql) => /UPDATE gtd_horizons/.test(sql) ? { rows: [{ id: ACTION_ID, title: 'Call the dentist' }] } : undefined,
      (sql) => /INSERT INTO chat_messages/.test(sql) ? { rows: [{ id: 'msg-1' }] } : undefined,
    ]);
    const res = await run(pool, 'post', '/me/actions/:id/defer', { params: { id: ACTION_ID } });

    expect(res._status).toBe(200);
    expect(res._json).toEqual({ status: 'deferred', due_date: '2026-07-06' });

    const [sql, params] = calls.find((c) => /UPDATE gtd_horizons/.test(c[0]))!;
    expect(sql).toMatch(/due_date = \$3/);
    expect(sql).toMatch(/description = COALESCE\(description \|\| E'\\n', ''\) \|\| \$4/);
    expect(sql).toMatch(/status = 'active'/);
    expect(params).toEqual([
      ACTION_ID, 'u1', '2026-07-06', '[deferred from phone 2026-07-05 -> 2026-07-06]',
    ]);

    // The compact system message the agent sees.
    const msg = calls.find((c) => /INSERT INTO chat_messages/.test(c[0]))!;
    expect(msg[1][1]).toBe("[Actions] user deferred 'Call the dentist' to tomorrow (from the phone)");
  });

  it('late-night defer crosses the local midnight correctly (22:30Z = 01:30 local July 6 → July 7)', async () => {
    const { pool, calls } = makePool([
      tzMatcher('Asia/Jerusalem'),
      (sql) => /UPDATE gtd_horizons/.test(sql) ? { rows: [{ id: ACTION_ID, title: 'X' }] } : undefined,
    ]);
    const router = createGtdSurfacesRouter(pool, AUTH_SECRET, { now: () => new Date('2026-07-05T22:30:00Z') });
    const handler = getChain(router, 'post', '/me/actions/:id/defer');
    const res = makeRes();
    await handler(makeReq({ headers: authHeader(userToken('u1')), params: { id: ACTION_ID } as any }), res);

    expect((res._json as any).due_date).toBe('2026-07-07');
    const [, params] = calls.find((c) => /UPDATE gtd_horizons/.test(c[0]))!;
    expect(params[2]).toBe('2026-07-07');
  });

  it('404s for an unknown/inactive action and sends nothing to the agent', async () => {
    const { pool, calls } = makePool([tzMatcher('UTC')]);
    const res = await run(pool, 'post', '/me/actions/:id/defer', { params: { id: ACTION_ID } });
    expect(res._status).toBe(404);
    expect(calls.some((c) => /INSERT INTO chat_messages/.test(c[0]))).toBe(false);
  });
});
