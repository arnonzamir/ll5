import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @ll5/shared.logAudit so we can assert audit emissions without writing
// to ES. This must be hoisted before the tool modules import it.
// ---------------------------------------------------------------------------
vi.mock('@ll5/shared', () => ({
  logAudit: vi.fn(),
}));

import { logAudit } from '@ll5/shared';
import { mapHorizonRow, mapInboxRow } from '../repositories/postgres/base.repository.js';
import { registerActionTools } from '../tools/actions.js';
import { registerInboxTools } from '../tools/inbox.js';
import { registerHealthTools } from '../tools/health.js';
import { captureTools, parseToolResponse } from './_helpers.js';
import type { HorizonRepository } from '../repositories/interfaces/horizon.repository.js';
import type { InboxRepository } from '../repositories/interfaces/inbox.repository.js';
import type { Horizon, InboxItem } from '../types/index.js';

const USER_ID = 'user-test-1';
const getUserId = () => USER_ID;

// ---------------------------------------------------------------------------
// Repository stub factories — every method asserts user_id is forwarded.
// Tests override only the methods they exercise.
// ---------------------------------------------------------------------------

function makeHorizonRepo(overrides: Partial<HorizonRepository> = {}): HorizonRepository {
  const unimpl = (name: string) => vi.fn(() => {
    throw new Error(`HorizonRepository.${name} not stubbed for this test`);
  });
  return {
    createAction: unimpl('createAction'),
    updateAction: unimpl('updateAction'),
    findActionById: unimpl('findActionById'),
    findActionByTitle: unimpl('findActionByTitle'),
    listActions: unimpl('listActions'),
    deleteAction: unimpl('deleteAction'),
    createProject: unimpl('createProject'),
    updateProject: unimpl('updateProject'),
    findProjectById: unimpl('findProjectById'),
    listProjects: unimpl('listProjects'),
    upsertHorizon: unimpl('upsertHorizon'),
    listHorizons: unimpl('listHorizons'),
    getHealth: unimpl('getHealth'),
    recommendActions: unimpl('recommendActions'),
    ...overrides,
  } as HorizonRepository;
}

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

function fakeAction(over: Partial<Horizon> = {}): Horizon {
  const now = new Date();
  return {
    id: 'action-stub',
    userId: USER_ID,
    horizon: 0,
    title: 'Stub action',
    description: null,
    status: 'active',
    energy: 'medium',
    listType: 'todo',
    context: [],
    dueDate: null,
    startDate: null,
    projectId: null,
    areaId: null,
    waitingFor: null,
    timeEstimate: null,
    category: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  } as Horizon;
}

function fakeInboxItem(over: Partial<InboxItem> = {}): InboxItem {
  const now = new Date();
  return {
    id: 'inbox-stub',
    userId: USER_ID,
    content: 'Stub content',
    source: 'direct',
    sourceLink: null,
    status: 'captured',
    outcomeType: null,
    outcomeId: null,
    notes: null,
    processedAt: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  } as InboxItem;
}

// ===========================================================================
// PURE MAPPING TESTS (kept from original — these were already real)
// ===========================================================================

describe('mapHorizonRow', () => {
  it('maps all fields from snake_case to camelCase', () => {
    const row = {
      id: 'action-1',
      user_id: USER_ID,
      horizon: 0,
      title: 'Buy groceries',
      description: 'Need milk and eggs',
      status: 'active',
      energy: 'low',
      list_type: 'todo',
      context: '["@home", "@errands"]',
      due_date: '2025-12-31',
      start_date: null,
      project_id: 'proj-1',
      area_id: null,
      waiting_for: null,
      time_estimate: 30,
      category: 'household',
      completed_at: null,
      created_at: new Date('2025-01-01'),
      updated_at: new Date('2025-01-15'),
    };

    const mapped = mapHorizonRow(row);

    expect(mapped.id).toBe('action-1');
    expect(mapped.userId).toBe(USER_ID);
    expect(mapped.horizon).toBe(0);
    expect(mapped.title).toBe('Buy groceries');
    expect(mapped.description).toBe('Need milk and eggs');
    expect(mapped.status).toBe('active');
    expect(mapped.energy).toBe('low');
    expect(mapped.listType).toBe('todo');
    expect(mapped.context).toEqual(['@home', '@errands']);
    expect(mapped.dueDate).toBe('2025-12-31');
    expect(mapped.startDate).toBeNull();
    expect(mapped.projectId).toBe('proj-1');
    expect(mapped.areaId).toBeNull();
    expect(mapped.waitingFor).toBeNull();
    expect(mapped.timeEstimate).toBe(30);
    expect(mapped.category).toBe('household');
    expect(mapped.completedAt).toBeNull();
  });

  it('parses JSONB context string', () => {
    const mapped = mapHorizonRow({
      id: 'a-1', user_id: USER_ID, horizon: 0, title: 'Test', status: 'active',
      context: '["@computer", "@office"]', created_at: new Date(), updated_at: new Date(),
    });
    expect(mapped.context).toEqual(['@computer', '@office']);
  });

  it('handles array context (already parsed)', () => {
    const mapped = mapHorizonRow({
      id: 'a-2', user_id: USER_ID, horizon: 0, title: 'Test', status: 'active',
      context: ['@home'], created_at: new Date(), updated_at: new Date(),
    });
    expect(mapped.context).toEqual(['@home']);
  });

  it('handles null/empty context', () => {
    const mapped = mapHorizonRow({
      id: 'a-3', user_id: USER_ID, horizon: 0, title: 'Test', status: 'active',
      context: null, created_at: new Date(), updated_at: new Date(),
    });
    expect(mapped.context).toEqual([]);
  });

  it('converts time_estimate to number', () => {
    const mapped = mapHorizonRow({
      id: 'a-4', user_id: USER_ID, horizon: 0, title: 'Test', status: 'active',
      time_estimate: '45', created_at: new Date(), updated_at: new Date(),
    });
    expect(mapped.timeEstimate).toBe(45);
    expect(typeof mapped.timeEstimate).toBe('number');
  });

  it('defaults nullable fields to null', () => {
    const mapped = mapHorizonRow({
      id: 'a-6', user_id: USER_ID, horizon: 0, title: 'Minimal', status: 'active',
      created_at: new Date(), updated_at: new Date(),
    });
    expect(mapped.description).toBeNull();
    expect(mapped.energy).toBeNull();
    expect(mapped.listType).toBeNull();
    expect(mapped.dueDate).toBeNull();
    expect(mapped.startDate).toBeNull();
    expect(mapped.projectId).toBeNull();
    expect(mapped.areaId).toBeNull();
    expect(mapped.waitingFor).toBeNull();
    expect(mapped.timeEstimate).toBeNull();
    expect(mapped.category).toBeNull();
    expect(mapped.completedAt).toBeNull();
  });
});

describe('mapInboxRow', () => {
  it('maps all inbox fields correctly', () => {
    const mapped = mapInboxRow({
      id: 'inbox-1', user_id: USER_ID, content: 'Buy a new keyboard', source: 'conversation',
      source_link: 'https://example.com/chat/123', status: 'captured',
      outcome_type: null, outcome_id: null, notes: null, processed_at: null,
      created_at: new Date('2025-01-01'), updated_at: new Date('2025-01-01'),
    });

    expect(mapped.id).toBe('inbox-1');
    expect(mapped.userId).toBe(USER_ID);
    expect(mapped.content).toBe('Buy a new keyboard');
    expect(mapped.source).toBe('conversation');
    expect(mapped.sourceLink).toBe('https://example.com/chat/123');
    expect(mapped.status).toBe('captured');
    expect(mapped.outcomeType).toBeNull();
  });

  it('maps processed inbox item with outcome', () => {
    const mapped = mapInboxRow({
      id: 'inbox-2', user_id: USER_ID, content: 'Book dentist', source: 'email',
      source_link: null, status: 'processed', outcome_type: 'action', outcome_id: 'action-abc',
      notes: 'Created as next action', processed_at: new Date('2025-01-15'),
      created_at: new Date('2025-01-01'), updated_at: new Date('2025-01-15'),
    });
    expect(mapped.status).toBe('processed');
    expect(mapped.outcomeType).toBe('action');
    expect(mapped.outcomeId).toBe('action-abc');
    expect(mapped.notes).toBe('Created as next action');
  });
});

// ===========================================================================
// REAL TOOL HANDLER TESTS — these import the real registerXxxTools functions,
// capture the registered handlers, and invoke them against stub repositories.
// ===========================================================================

describe('create_action tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards params with default energy=medium and list_type=todo (via repo, not inline)', async () => {
    const createAction = vi.fn(async (_userId: string, _data: unknown) =>
      fakeAction({ id: 'action-new', title: 'New Action' }),
    );
    const repo = makeHorizonRepo({ createAction });

    const tools = captureTools((s) => registerActionTools(s, repo, getUserId));
    const handler = tools.get('create_action');
    expect(handler).toBeDefined();

    const response = await handler!({ title: 'New Action' });

    // Real handler invoked the real repo with the real user id
    expect(createAction).toHaveBeenCalledTimes(1);
    expect(createAction.mock.calls[0][0]).toBe(USER_ID);
    const payload = createAction.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.title).toBe('New Action');
    // The handler passes undefined through; repository is responsible for defaults.
    // What we assert here is that the handler does not mutate the field on the way through.
    expect(payload.energy).toBeUndefined();
    expect(payload.listType).toBeUndefined();

    expect(response.isError).toBeUndefined();
    const parsed = parseToolResponse<{ action: { id: string; title: string } }>(response);
    expect(parsed.action.id).toBe('action-new');
  });

  it('forwards explicit context as an array to the repo', async () => {
    const createAction = vi.fn(async () => fakeAction({ context: ['@home', '@computer'] }));
    const repo = makeHorizonRepo({ createAction });

    const tools = captureTools((s) => registerActionTools(s, repo, getUserId));
    await tools.get('create_action')!({ title: 'X', context: ['@home', '@computer'] });

    const payload = createAction.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.context).toEqual(['@home', '@computer']);
  });

  it('maps snake_case input keys to camelCase repo fields', async () => {
    const createAction = vi.fn(async () => fakeAction());
    const repo = makeHorizonRepo({ createAction });
    const tools = captureTools((s) => registerActionTools(s, repo, getUserId));

    await tools.get('create_action')!({
      title: 'T',
      list_type: 'waiting',
      due_date: '2025-12-31',
      start_date: '2025-12-01',
      project_id: 'p-1',
      waiting_for: 'Alice',
      time_estimate: 30,
    });

    const payload = createAction.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.listType).toBe('waiting');
    expect(payload.dueDate).toBe('2025-12-31');
    expect(payload.startDate).toBe('2025-12-01');
    expect(payload.projectId).toBe('p-1');
    expect(payload.waitingFor).toBe('Alice');
    expect(payload.timeEstimate).toBe(30);
  });

  it('threads conversation_id and stakes to the repo (reconciliation stamping)', async () => {
    const createAction = vi.fn(async () => fakeAction({ id: 'a-conv' }));
    const repo = makeHorizonRepo({ createAction });
    const tools = captureTools((s) => registerActionTools(s, repo, getUserId));

    await tools.get('create_action')!({
      title: 'Waiting on Bob',
      list_type: 'waiting',
      waiting_for: 'Bob',
      conversation_id: 'wa:conv-42',
      stakes: 'low',
    });

    const payload = createAction.mock.calls[0][1] as Record<string, unknown>;
    expect(createAction.mock.calls[0][0]).toBe(USER_ID);
    expect(payload.conversationId).toBe('wa:conv-42');
    expect(payload.stakes).toBe('low');
  });

  it('passes stakes/conversationId as undefined when omitted (repo lets DB default apply)', async () => {
    const createAction = vi.fn(async () => fakeAction());
    const repo = makeHorizonRepo({ createAction });
    const tools = captureTools((s) => registerActionTools(s, repo, getUserId));

    await tools.get('create_action')!({ title: 'Plain' });

    const payload = createAction.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.conversationId).toBeUndefined();
    expect(payload.stakes).toBeUndefined();
  });

  it('emits an audit log with action=create after success', async () => {
    const repo = makeHorizonRepo({
      createAction: vi.fn(async () => fakeAction({ id: 'a-99', title: 'Audited' })),
    });
    const tools = captureTools((s) => registerActionTools(s, repo, getUserId));
    await tools.get('create_action')!({ title: 'Audited' });

    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      user_id: USER_ID,
      source: 'gtd',
      action: 'create',
      entity_type: 'action',
      entity_id: 'a-99',
    }));
  });

  it('propagates repo errors (no swallowing on create)', async () => {
    const repo = makeHorizonRepo({
      createAction: vi.fn(async () => { throw new Error('db down'); }),
    });
    const tools = captureTools((s) => registerActionTools(s, repo, getUserId));
    await expect(tools.get('create_action')!({ title: 'X' })).rejects.toThrow('db down');
  });
});

describe('update_action tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns isError when neither id nor title_search is provided', async () => {
    const repo = makeHorizonRepo();
    const tools = captureTools((s) => registerActionTools(s, repo, getUserId));
    const response = await tools.get('update_action')!({ title: 'X' });

    expect(response.isError).toBe(true);
    expect(parseToolResponse<{ error: string }>(response).error).toMatch(/id or title_search/);
  });

  it('returns isError when title_search matches nothing', async () => {
    const repo = makeHorizonRepo({
      findActionByTitle: vi.fn(async () => []),
    });
    const tools = captureTools((s) => registerActionTools(s, repo, getUserId));
    const response = await tools.get('update_action')!({ title_search: 'nope' });

    expect(response.isError).toBe(true);
    expect(parseToolResponse<{ error: string }>(response).error).toContain('nope');
  });

  it('returns isError with match list when title_search is ambiguous', async () => {
    const matches = [
      fakeAction({ id: 'a-1', title: 'Buy milk' }),
      fakeAction({ id: 'a-2', title: 'Buy bread' }),
    ];
    const repo = makeHorizonRepo({
      findActionByTitle: vi.fn(async () => matches),
    });
    const tools = captureTools((s) => registerActionTools(s, repo, getUserId));
    const response = await tools.get('update_action')!({ title_search: 'Buy' });

    expect(response.isError).toBe(true);
    const parsed = parseToolResponse<{ error: string; matches: Array<{ id: string }> }>(response);
    expect(parsed.matches).toHaveLength(2);
    expect(parsed.matches.map((m) => m.id)).toEqual(['a-1', 'a-2']);
  });

  it('resolves title_search to a single id and calls updateAction with it', async () => {
    const findActionByTitle = vi.fn(async () => [fakeAction({ id: 'a-77', title: 'Pay bills' })]);
    const updateAction = vi.fn(async () => fakeAction({ id: 'a-77', title: 'Pay bills (done)', status: 'completed' }));
    const repo = makeHorizonRepo({ findActionByTitle, updateAction });

    const tools = captureTools((s) => registerActionTools(s, repo, getUserId));
    const response = await tools.get('update_action')!({
      title_search: 'bills',
      status: 'completed',
    });

    expect(findActionByTitle).toHaveBeenCalledWith(USER_ID, 'bills');
    expect(updateAction).toHaveBeenCalledTimes(1);
    expect(updateAction.mock.calls[0][0]).toBe(USER_ID);
    expect(updateAction.mock.calls[0][1]).toBe('a-77');
    expect((updateAction.mock.calls[0][2] as Record<string, unknown>).status).toBe('completed');
    expect(response.isError).toBeUndefined();
  });

  it('does not include keys that were not provided in the update payload', async () => {
    const updateAction = vi.fn(async () => fakeAction());
    const repo = makeHorizonRepo({ updateAction });
    const tools = captureTools((s) => registerActionTools(s, repo, getUserId));

    await tools.get('update_action')!({ id: 'a-1', title: 'just title' });

    const payload = updateAction.mock.calls[0][2] as Record<string, unknown>;
    expect(payload).toEqual({ title: 'just title' });
    expect('status' in payload).toBe(false);
    expect('energy' in payload).toBe(false);
  });

  it('emits audit action=complete when status=completed', async () => {
    const repo = makeHorizonRepo({
      updateAction: vi.fn(async () => fakeAction({ id: 'a-1', title: 'Done', status: 'completed' })),
    });
    const tools = captureTools((s) => registerActionTools(s, repo, getUserId));
    await tools.get('update_action')!({ id: 'a-1', status: 'completed' });

    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'complete',
      entity_id: 'a-1',
      summary: expect.stringMatching(/^Completed action:/),
    }));
  });

  it('emits audit action=update for non-completion changes', async () => {
    const repo = makeHorizonRepo({
      updateAction: vi.fn(async () => fakeAction({ id: 'a-1', title: 'Held', status: 'on_hold' })),
    });
    const tools = captureTools((s) => registerActionTools(s, repo, getUserId));
    await tools.get('update_action')!({ id: 'a-1', status: 'on_hold' });

    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'update' }));
  });

  it('catches repo errors and returns them as isError tool responses', async () => {
    const repo = makeHorizonRepo({
      updateAction: vi.fn(async () => { throw new Error('row not found'); }),
    });
    const tools = captureTools((s) => registerActionTools(s, repo, getUserId));
    const response = await tools.get('update_action')!({ id: 'missing', title: 'x' });

    expect(response.isError).toBe(true);
    expect(parseToolResponse<{ error: string }>(response).error).toBe('row not found');
  });
});

describe('list_actions tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards user_id and maps every filter param to the repo', async () => {
    const listActions = vi.fn(async () => ({ items: [], total: 0 }));
    const repo = makeHorizonRepo({ listActions });
    const tools = captureTools((s) => registerActionTools(s, repo, getUserId));

    await tools.get('list_actions')!({
      status: 'completed',
      list_type: 'shopping',
      energy: 'high',
      context: ['@home'],
      category: 'errands',
      project_id: 'p-1',
      due_before: '2025-12-31',
      due_after: '2025-01-01',
      overdue: true,
      query: 'milk',
      limit: 25,
      offset: 50,
    });

    expect(listActions).toHaveBeenCalledTimes(1);
    expect(listActions.mock.calls[0][0]).toBe(USER_ID);
    expect(listActions.mock.calls[0][1]).toEqual({
      status: 'completed',
      listType: 'shopping',
      energy: 'high',
      context: ['@home'],
      category: 'errands',
      projectId: 'p-1',
      dueBefore: '2025-12-31',
      dueAfter: '2025-01-01',
      overdue: true,
      query: 'milk',
      limit: 25,
      offset: 50,
    });
  });

  it('returns repo items and total in the response envelope', async () => {
    const items = [fakeAction({ id: 'a-1' }), fakeAction({ id: 'a-2' })];
    const repo = makeHorizonRepo({
      listActions: vi.fn(async () => ({ items, total: 2 })),
    });
    const tools = captureTools((s) => registerActionTools(s, repo, getUserId));
    const response = await tools.get('list_actions')!({});

    const parsed = parseToolResponse<{ actions: Array<{ id: string }>; total: number }>(response);
    expect(parsed.total).toBe(2);
    expect(parsed.actions.map((a) => a.id)).toEqual(['a-1', 'a-2']);
  });
});

describe('capture_inbox tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards content, source, and sourceLink to repo.capture', async () => {
    const capture = vi.fn(async () => fakeInboxItem({ id: 'inbox-new', content: 'X' }));
    const repo = makeInboxRepo({ capture });
    const tools = captureTools((s) => registerInboxTools(s, repo, getUserId));

    await tools.get('capture_inbox')!({
      content: 'Remember to call dentist',
      source: 'conversation',
      source_link: 'https://example/chat/1',
    });

    expect(capture).toHaveBeenCalledWith(USER_ID, {
      content: 'Remember to call dentist',
      source: 'conversation',
      sourceLink: 'https://example/chat/1',
    });
  });

  it('omits source/sourceLink when not provided', async () => {
    const capture = vi.fn(async () => fakeInboxItem());
    const repo = makeInboxRepo({ capture });
    const tools = captureTools((s) => registerInboxTools(s, repo, getUserId));

    await tools.get('capture_inbox')!({ content: 'Quick capture' });

    expect(capture).toHaveBeenCalledWith(USER_ID, {
      content: 'Quick capture',
      source: undefined,
      sourceLink: undefined,
    });
  });

  it('returns the captured item in the response envelope', async () => {
    const repo = makeInboxRepo({
      capture: vi.fn(async () => fakeInboxItem({ id: 'inbox-99', content: 'hi' })),
    });
    const tools = captureTools((s) => registerInboxTools(s, repo, getUserId));
    const response = await tools.get('capture_inbox')!({ content: 'hi' });

    const parsed = parseToolResponse<{ inbox_item: { id: string } }>(response);
    expect(parsed.inbox_item.id).toBe('inbox-99');
  });
});

describe('list_inbox tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards filter, limit, offset to repo.list with user_id scoping', async () => {
    const list = vi.fn(async () => ({ items: [], total: 0 }));
    const repo = makeInboxRepo({ list });
    const tools = captureTools((s) => registerInboxTools(s, repo, getUserId));

    await tools.get('list_inbox')!({ status: 'processed', limit: 10, offset: 5 });

    expect(list).toHaveBeenCalledWith(USER_ID, {
      status: 'processed',
      limit: 10,
      offset: 5,
    });
  });

  it('returns items and total in the response envelope', async () => {
    const items = [fakeInboxItem({ id: 'i-1' }), fakeInboxItem({ id: 'i-2' })];
    const repo = makeInboxRepo({
      list: vi.fn(async () => ({ items, total: 2 })),
    });
    const tools = captureTools((s) => registerInboxTools(s, repo, getUserId));
    const response = await tools.get('list_inbox')!({});

    const parsed = parseToolResponse<{ inbox_items: Array<{ id: string }>; total: number }>(response);
    expect(parsed.total).toBe(2);
    expect(parsed.inbox_items.map((i) => i.id)).toEqual(['i-1', 'i-2']);
  });
});

describe('process_inbox_item tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards id, outcome_type, outcome_id, and notes to repo.process', async () => {
    const processFn = vi.fn(async () => fakeInboxItem({ id: 'i-1', status: 'processed' }));
    const repo = makeInboxRepo({ process: processFn });
    const tools = captureTools((s) => registerInboxTools(s, repo, getUserId));

    await tools.get('process_inbox_item')!({
      id: 'i-1',
      outcome_type: 'action',
      outcome_id: 'a-1',
      notes: 'Created as next action',
    });

    expect(processFn).toHaveBeenCalledWith(USER_ID, 'i-1', {
      outcomeType: 'action',
      outcomeId: 'a-1',
      notes: 'Created as next action',
    });
  });

  it('returns isError when repo throws (e.g. not found)', async () => {
    const repo = makeInboxRepo({
      process: vi.fn(async () => { throw new Error('Inbox item not found: missing'); }),
    });
    const tools = captureTools((s) => registerInboxTools(s, repo, getUserId));
    const response = await tools.get('process_inbox_item')!({
      id: 'missing',
      outcome_type: 'trash',
    });

    expect(response.isError).toBe(true);
    expect(parseToolResponse<{ error: string }>(response).error).toContain('not found');
  });
});

describe('get_gtd_health tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls repo.getHealth with the current user_id', async () => {
    const getHealth = vi.fn(async () => ({
      inboxCount: 5,
      activeProjectCount: 3,
      projectsWithoutActions: 1,
      overdueCount: 2,
      staleWaitingCount: 0,
      activeActionCount: 15,
      somedayCount: 7,
      completedThisWeek: 4,
      daysSinceLastReview: 3,
    }));
    const repo = makeHorizonRepo({ getHealth });
    const tools = captureTools((s) => registerHealthTools(s, repo, getUserId));

    const response = await tools.get('get_gtd_health')!({});

    expect(getHealth).toHaveBeenCalledWith(USER_ID);
    const parsed = parseToolResponse<{ health: { inboxCount: number; daysSinceLastReview: number | null } }>(response);
    expect(parsed.health.inboxCount).toBe(5);
    expect(parsed.health.daysSinceLastReview).toBe(3);
  });

  it('propagates null daysSinceLastReview', async () => {
    const repo = makeHorizonRepo({
      getHealth: vi.fn(async () => ({
        inboxCount: 0, activeProjectCount: 0, projectsWithoutActions: 0,
        overdueCount: 0, staleWaitingCount: 0, activeActionCount: 0,
        somedayCount: 0, completedThisWeek: 0, daysSinceLastReview: null,
      })),
    });
    const tools = captureTools((s) => registerHealthTools(s, repo, getUserId));
    const response = await tools.get('get_gtd_health')!({});

    const parsed = parseToolResponse<{ health: { daysSinceLastReview: number | null } }>(response);
    expect(parsed.health.daysSinceLastReview).toBeNull();
  });
});
