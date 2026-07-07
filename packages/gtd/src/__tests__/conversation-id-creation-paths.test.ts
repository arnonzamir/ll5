import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// DECISION-025 §7 acceptance — item C1: conversation_id is stamped on EVERY
// horizon-0 (message-linkable) loop-creation path, OR the path is a documented
// honest-scope exclusion (leaves conversation_id NULL because it is never a
// message-linked loop). This is the guard that a NEW creation path cannot
// silently become invisible to the reconciliation governor (which only sees
// horizon-0 loops carrying a conversation_id).
//
// This file ENUMERATES every horizon-0 creation path and gives each a verdict,
// then adds a source-level GUARD (below) that trips loudly if a new
// `INSERT INTO gtd_horizons` site is added without being classified here.
// ---------------------------------------------------------------------------

// logAudit is imported by the tool modules; mock it so nothing hits ES.
vi.mock('@ll5/shared', () => ({
  logAudit: vi.fn(),
}));

import { PostgresHorizonRepository } from '../repositories/postgres/horizon.repository.js';
import { registerActionTools } from '../tools/actions.js';
import { registerShoppingTools } from '../tools/shopping.js';
import { registerInboxTools } from '../tools/inbox.js';
import { captureTools } from './_helpers.js';
import { makeMockPool } from './_helpers.js';
import type { InboxRepository } from '../repositories/interfaces/inbox.repository.js';
import type { InboxItem } from '../types/index.js';

const USER_A = 'user-a';
const getUserId = () => USER_A;

/** Extract SQL + params from the Nth pool.query() call. */
function call(query: ReturnType<typeof vi.fn>, n: number): { sql: string; params: unknown[] } {
  const args = query.mock.calls[n] as [string, unknown[]];
  return { sql: args[0], params: args[1] };
}

const insertRow = () => [
  { id: 'h-new', user_id: USER_A, horizon: 0, title: 'x', status: 'active' },
];

function makeInboxRepo(overrides: Partial<InboxRepository> = {}): InboxRepository {
  const unimpl = (name: string) => vi.fn(() => {
    throw new Error(`InboxRepository.${name} not stubbed for this test`);
  });
  return {
    capture: unimpl('capture'),
    list: unimpl('list'),
    findById: unimpl('findById'),
    process: unimpl('process'),
    delete: unimpl('delete'),
    countByStatus: unimpl('countByStatus'),
    ...overrides,
  } as InboxRepository;
}

function fakeInboxItem(over: Partial<InboxItem> = {}): InboxItem {
  const now = new Date();
  return {
    id: 'inbox-stub',
    userId: USER_A,
    content: 'stub',
    status: 'processed',
    source: null,
    sourceLink: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  } as unknown as InboxItem;
}

// ===========================================================================
// PATH 1 — create_action (tool → repo). The GOVERNED path: h=0 loop that CAN
// be created from a conversation. Must STAMP conversation_id when supplied.
// ===========================================================================
describe('DECISION-025 C1 · path: create_action (h=0, governed)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('STAMPS conversation_id into the h=0 INSERT when created from a conversation', async () => {
    const { pool, query } = makeMockPool([insertRow()]);
    const repo = new PostgresHorizonRepository(pool);
    const tools = captureTools((s) => registerActionTools(s, repo, getUserId));

    await tools.get('create_action')!({
      title: 'Waiting on Bob',
      list_type: 'waiting',
      waiting_for: 'Bob',
      conversation_id: 'wa:conv-42',
    });

    const { sql, params } = call(query, 0);
    // The one INSERT is horizon 0 and carries the conversation_id column + value.
    expect(sql).toMatch(/INSERT INTO gtd_horizons/);
    expect(sql).toMatch(/conversation_id/);
    expect(params).toContain('wa:conv-42');
    // user_id scoping is the first bound param (never a caller arg).
    expect(params[0]).toBe(USER_A);
  });

  it('leaves conversation_id NULL when create_action has no conversation context', async () => {
    const { pool, query } = makeMockPool([insertRow()]);
    const repo = new PostgresHorizonRepository(pool);
    const tools = captureTools((s) => registerActionTools(s, repo, getUserId));

    await tools.get('create_action')!({ title: 'Standalone task' });

    const { sql, params } = call(query, 0);
    // Column is ALWAYS present in the INSERT; the bound value is null (not a
    // dropped column) so the governor sees an explicit "no conversation" loop.
    expect(sql).toMatch(/conversation_id/);
    expect(params).toContain(null);
    expect(params).not.toContain('wa:conv-42');
  });
});

// ===========================================================================
// PATH 2 — manage_shopping_list add (tool → repo.createAction). Creates an
// h=0 loop but is an HONEST-SCOPE EXCLUSION: shopping items are never
// message-linked, so conversation_id is correctly NULL.
// ===========================================================================
describe('DECISION-025 C1 · path: manage_shopping_list add (h=0, NULL-by-design)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates an h=0 loop with conversation_id NULL (never a message-linked loop)', async () => {
    const { pool, query } = makeMockPool([insertRow()]);
    const repo = new PostgresHorizonRepository(pool);
    const tools = captureTools((s) => registerShoppingTools(s, repo, getUserId));

    await tools.get('manage_shopping_list')!({ action: 'add', title: 'Milk', quantity: '2L' });

    const { sql, params } = call(query, 0);
    // It DOES go through the same governed INSERT (column present)...
    expect(sql).toMatch(/INSERT INTO gtd_horizons/);
    expect(sql).toMatch(/conversation_id/);
    // ...but the shopping tool never passes a conversationId, so the bound
    // value is null. This is intentional scope: the governor ignores it.
    expect(params).toContain(null);
    // Sanity: no conversation id string leaked into the params.
    expect(params.some((p) => typeof p === 'string' && p.startsWith('wa:'))).toBe(false);
  });
});

// ===========================================================================
// PATH 3 — process_inbox_item (tool → InboxRepository). EXEMPT: it does NOT
// create an h=0 loop at all. It only records an outcome on the inbox item;
// any resulting action is created via create_action (PATH 1) separately, so
// there is nothing to stamp here.
// ===========================================================================
describe('DECISION-025 C1 · path: process_inbox_item (does NOT create h=0 — exempt)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records an outcome without creating any horizon-0 loop (no horizon INSERT)', async () => {
    // A HorizonRepository is not even wired into the inbox tools — proving the
    // process path cannot create an h=0 loop. If a future refactor made inbox
    // processing create actions inline, it would need a HorizonRepository here
    // and would then owe a conversation_id decision.
    const processFn = vi.fn(async () => fakeInboxItem({ id: 'i-1', status: 'processed' }));
    const repo = makeInboxRepo({ process: processFn });
    const tools = captureTools((s) => registerInboxTools(s, repo, getUserId));

    await tools.get('process_inbox_item')!({
      id: 'i-1',
      outcome_type: 'action',
      outcome_id: 'a-1',
    });

    // Only repo.process ran; it merely stamps the outcome on the inbox row.
    expect(processFn).toHaveBeenCalledTimes(1);
    expect(processFn.mock.calls[0][0]).toBe(USER_A);
    // The InboxRepository interface has no create-action method: structurally,
    // this path can never emit an INSERT INTO gtd_horizons.
    expect('createAction' in (repo as unknown as Record<string, unknown>)).toBe(false);
  });
});

// ===========================================================================
// PATHS 4 & 5 — createProject (h=1) and upsertHorizon create (h>=2). OUT OF
// SCOPE by design: the reconciliation governor only tracks horizon-0
// message-linked loops. Projects and higher horizons are never conversation
// loops, so they carry no conversation_id column at all.
// ===========================================================================
describe('DECISION-025 C1 · paths: createProject / upsertHorizon (h>=1 — out of scope)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('createProject inserts horizon 1 and has NO conversation_id column', async () => {
    const { pool, query } = makeMockPool([[{ id: 'p-1', user_id: USER_A, horizon: 1, title: 'Proj' }]]);
    const repo = new PostgresHorizonRepository(pool);

    await repo.createProject(USER_A, { title: 'Proj' });

    const { sql, params } = call(query, 0);
    expect(sql).toMatch(/INSERT INTO gtd_horizons/);
    // Not a horizon-0 path — governor never looks here.
    expect(sql).not.toMatch(/conversation_id/);
    // horizon literal 1 is baked into the VALUES list (not 0).
    expect(sql).toMatch(/\b1\b/);
    expect(params).not.toContain(0);
  });

  it('upsertHorizon create inserts horizon>=2 and has NO conversation_id column', async () => {
    const { pool, query } = makeMockPool([[{ id: 'hz-1', user_id: USER_A, horizon: 3, title: 'Goal' }]]);
    const repo = new PostgresHorizonRepository(pool);

    await repo.upsertHorizon(USER_A, { horizon: 3, title: 'Goal' });

    const { sql, params } = call(query, 0);
    expect(sql).toMatch(/INSERT INTO gtd_horizons/);
    expect(sql).not.toMatch(/conversation_id/);
    // horizon is a bound param here; it is 3 (>=2), never 0.
    expect(params).toContain(3);
    expect(params).not.toContain(0);
  });
});

// ===========================================================================
// GUARD — the tripwire. The reconciliation governor's correctness depends on
// EVERY h=0 creation path being enumerated above. This reads the repository
// source and asserts the KNOWN, classified set of `INSERT INTO gtd_horizons`
// sites is exactly the set enumerated in this file. Adding a new INSERT site
// (a potential new h=0 creation path) changes the count and FAILS this test,
// forcing the next dev to classify it: stamp conversation_id (if it can be
// created from a conversation) or document it as an honest-scope exclusion.
// ===========================================================================
describe('DECISION-025 C1 · GUARD: no un-classified horizon INSERT path', () => {
  const repoSourcePath = fileURLToPath(
    new URL('../repositories/postgres/horizon.repository.ts', import.meta.url),
  );
  const source = readFileSync(repoSourcePath, 'utf8');

  // The complete, classified inventory of horizon INSERT sites in the repo.
  // Each entry documents WHY its conversation_id verdict is safe.
  const CLASSIFIED_INSERT_SITES = [
    'createAction   → h=0 GOVERNED: stamps conversation_id (dynamic INSERT; NULL when absent)',
    'createProject  → h=1 OUT OF SCOPE: projects are never message-linked loops',
    'upsertHorizon  → h>=2 OUT OF SCOPE: higher horizons are never message-linked loops',
  ];

  it('has exactly the enumerated set of INSERT INTO gtd_horizons sites', () => {
    const matches = source.match(/INSERT INTO gtd_horizons/g) ?? [];
    if (matches.length !== CLASSIFIED_INSERT_SITES.length) {
      throw new Error(
        `Found ${matches.length} INSERT INTO gtd_horizons site(s) but ${CLASSIFIED_INSERT_SITES.length} are classified for DECISION-025 C1.\n` +
        `A new horizon INSERT path was added. If it creates a horizon-0 (message-linkable) loop it MUST stamp conversation_id ` +
        `so the reconciliation governor can see it; if it is out of scope (project/higher horizon, or never message-linked) ` +
        `document it as an honest-scope exclusion. Then enumerate it in ` +
        `conversation-id-creation-paths.test.ts.\nClassified sites:\n  - ${CLASSIFIED_INSERT_SITES.join('\n  - ')}`,
      );
    }
    expect(matches.length).toBe(CLASSIFIED_INSERT_SITES.length);
  });

  it('the sole horizon-0 INSERT path (createAction) still carries conversation_id', () => {
    // Isolate the createAction method body and prove the governed column is
    // present. If someone drops conversation_id from the h=0 INSERT, this trips.
    const start = source.indexOf('async createAction(');
    expect(start).toBeGreaterThan(-1);
    const nextMethod = source.indexOf('async updateAction(', start);
    const body = source.slice(start, nextMethod === -1 ? undefined : nextMethod);

    expect(body).toMatch(/INSERT INTO gtd_horizons/);
    expect(body).toMatch(/conversation_id/);
    // And it is the horizon-0 path (horizon value '0' in the VALUES list).
    expect(body).toMatch(/'0'/);
  });

  it('the other INSERT sites (createProject, upsertHorizon) do not touch conversation_id', () => {
    // Belt-and-suspenders: the out-of-scope INSERT bodies must NOT reference
    // conversation_id (which would imply an unclassified h=0-style path).
    const projStart = source.indexOf('async createProject(');
    const projBody = source.slice(projStart, source.indexOf('async updateProject('));
    expect(projBody).toMatch(/INSERT INTO gtd_horizons/);
    expect(projBody).not.toMatch(/conversation_id/);

    const upsertStart = source.indexOf('async upsertHorizon(');
    const upsertBody = source.slice(upsertStart, source.indexOf('async listHorizons('));
    expect(upsertBody).toMatch(/INSERT INTO gtd_horizons/);
    expect(upsertBody).not.toMatch(/conversation_id/);
  });
});
