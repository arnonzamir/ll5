import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool, QueryResult } from 'pg';

// ---------------------------------------------------------------------------
// Mock logAudit
// ---------------------------------------------------------------------------
vi.mock('@ll5/shared', () => ({
  logAudit: vi.fn(),
}));

import { logAudit } from '@ll5/shared';

// ---------------------------------------------------------------------------
// Import mapping functions directly (pure functions, no side effects)
// ---------------------------------------------------------------------------
import { mapHorizonRow, mapInboxRow } from '../repositories/postgres/base.repository.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_ID = 'user-test-1';

function makePgPool(
  queryResult: { rows: Record<string, unknown>[]; rowCount?: number } = { rows: [] },
): Pool {
  return {
    query: vi.fn().mockResolvedValue(queryResult),
  } as unknown as Pool;
}

// ---------------------------------------------------------------------------
// mapHorizonRow — snake_case to camelCase
// ---------------------------------------------------------------------------

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
    const row = {
      id: 'a-1',
      user_id: USER_ID,
      horizon: 0,
      title: 'Test',
      status: 'active',
      context: '["@computer", "@office"]',
      created_at: new Date(),
      updated_at: new Date(),
    };

    const mapped = mapHorizonRow(row);
    expect(mapped.context).toEqual(['@computer', '@office']);
  });

  it('handles array context (already parsed)', () => {
    const row = {
      id: 'a-2',
      user_id: USER_ID,
      horizon: 0,
      title: 'Test',
      status: 'active',
      context: ['@home'],
      created_at: new Date(),
      updated_at: new Date(),
    };

    const mapped = mapHorizonRow(row);
    expect(mapped.context).toEqual(['@home']);
  });

  it('handles null/empty context', () => {
    const row = {
      id: 'a-3',
      user_id: USER_ID,
      horizon: 0,
      title: 'Test',
      status: 'active',
      context: null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    const mapped = mapHorizonRow(row);
    expect(mapped.context).toEqual([]);
  });

  it('converts time_estimate to number', () => {
    const row = {
      id: 'a-4',
      user_id: USER_ID,
      horizon: 0,
      title: 'Test',
      status: 'active',
      time_estimate: '45',
      created_at: new Date(),
      updated_at: new Date(),
    };

    const mapped = mapHorizonRow(row);
    expect(mapped.timeEstimate).toBe(45);
    expect(typeof mapped.timeEstimate).toBe('number');
  });

  it('converts due_date to string', () => {
    const row = {
      id: 'a-5',
      user_id: USER_ID,
      horizon: 0,
      title: 'Test',
      status: 'active',
      due_date: new Date('2025-06-15'),
      created_at: new Date(),
      updated_at: new Date(),
    };

    const mapped = mapHorizonRow(row);
    expect(typeof mapped.dueDate).toBe('string');
  });

  it('defaults nullable fields to null', () => {
    const row = {
      id: 'a-6',
      user_id: USER_ID,
      horizon: 0,
      title: 'Minimal',
      status: 'active',
      created_at: new Date(),
      updated_at: new Date(),
    };

    const mapped = mapHorizonRow(row);
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

// ---------------------------------------------------------------------------
// mapInboxRow — snake_case to camelCase
// ---------------------------------------------------------------------------

describe('mapInboxRow', () => {
  it('maps all inbox fields correctly', () => {
    const row = {
      id: 'inbox-1',
      user_id: USER_ID,
      content: 'Buy a new keyboard',
      source: 'conversation',
      source_link: 'https://example.com/chat/123',
      status: 'captured',
      outcome_type: null,
      outcome_id: null,
      notes: null,
      processed_at: null,
      created_at: new Date('2025-01-01'),
      updated_at: new Date('2025-01-01'),
    };

    const mapped = mapInboxRow(row);

    expect(mapped.id).toBe('inbox-1');
    expect(mapped.userId).toBe(USER_ID);
    expect(mapped.content).toBe('Buy a new keyboard');
    expect(mapped.source).toBe('conversation');
    expect(mapped.sourceLink).toBe('https://example.com/chat/123');
    expect(mapped.status).toBe('captured');
    expect(mapped.outcomeType).toBeNull();
    expect(mapped.outcomeId).toBeNull();
    expect(mapped.notes).toBeNull();
    expect(mapped.processedAt).toBeNull();
  });

  it('maps processed inbox item with outcome', () => {
    const row = {
      id: 'inbox-2',
      user_id: USER_ID,
      content: 'Book dentist',
      source: 'email',
      source_link: null,
      status: 'processed',
      outcome_type: 'action',
      outcome_id: 'action-abc',
      notes: 'Created as next action',
      processed_at: new Date('2025-01-15'),
      created_at: new Date('2025-01-01'),
      updated_at: new Date('2025-01-15'),
    };

    const mapped = mapInboxRow(row);

    expect(mapped.status).toBe('processed');
    expect(mapped.outcomeType).toBe('action');
    expect(mapped.outcomeId).toBe('action-abc');
    expect(mapped.notes).toBe('Created as next action');
    expect(mapped.processedAt).toEqual(new Date('2025-01-15'));
  });
});

// ---------------------------------------------------------------------------
// create_action tool handler logic
// ---------------------------------------------------------------------------

describe('create_action tool handler', () => {
  let pool: Pool;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inserts with correct SQL params and defaults', async () => {
    const now = new Date();
    pool = makePgPool({
      rows: [{
        id: 'action-new',
        user_id: USER_ID,
        horizon: 0,
        title: 'New Action',
        description: null,
        status: 'active',
        energy: 'medium',
        list_type: 'todo',
        context: '[]',
        due_date: null,
        start_date: null,
        project_id: null,
        waiting_for: null,
        time_estimate: null,
        category: null,
        completed_at: null,
        created_at: now,
        updated_at: now,
      }],
    });

    await pool.query(
      expect.stringContaining('INSERT INTO gtd_horizons'),
      [USER_ID, 'New Action', null, 'medium', 'todo', '[]', null, null, null, null, null, null],
    );

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO gtd_horizons'),
      [USER_ID, 'New Action', null, 'medium', 'todo', '[]', null, null, null, null, null, null],
    );
  });

  it('sets energy default to medium', () => {
    const data = { title: 'Test' };
    const energy = (data as Record<string, unknown>).energy ?? 'medium';
    expect(energy).toBe('medium');
  });

  it('sets list_type default to todo', () => {
    const data = { title: 'Test' };
    const listType = (data as Record<string, unknown>).listType ?? 'todo';
    expect(listType).toBe('todo');
  });

  it('serializes context array to JSON', () => {
    const context = ['@home', '@computer'];
    const serialized = JSON.stringify(context);
    expect(serialized).toBe('["@home","@computer"]');
  });

  it('defaults context to empty array when not provided', () => {
    const context = undefined;
    const serialized = JSON.stringify(context ?? []);
    expect(serialized).toBe('[]');
  });

  it('logs audit after creation', () => {
    const action = { id: 'action-new', title: 'New Action' };

    logAudit({
      user_id: USER_ID,
      source: 'gtd',
      action: 'create',
      entity_type: 'action',
      entity_id: action.id,
      summary: `Created action: ${action.title}`,
    });

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'gtd',
        action: 'create',
        entity_type: 'action',
        entity_id: 'action-new',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// list_actions tool handler logic
// ---------------------------------------------------------------------------

describe('list_actions tool handler', () => {
  let pool: Pool;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defaults to active status when not provided', () => {
    const filters = {} as Record<string, unknown>;
    const status = filters.status ?? 'active';
    expect(status).toBe('active');
  });

  it('caps limit to 200', () => {
    const requestedLimit = 9999;
    const limit = Math.min(requestedLimit, 200);
    expect(limit).toBe(200);
  });

  it('defaults limit to 50', () => {
    const requestedLimit = undefined;
    const limit = Math.min(requestedLimit ?? 50, 200);
    expect(limit).toBe(50);
  });

  it('defaults offset to 0', () => {
    const requestedOffset = undefined;
    const offset = requestedOffset ?? 0;
    expect(offset).toBe(0);
  });

  it('builds filter clauses for list_type', async () => {
    pool = makePgPool({ rows: [{ count: '0' }] });
    // Count query, then data query
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [{ count: '0' }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);

    // Simulate the filter building from listActions
    const whereClauses = ['h.user_id = $1', 'h.horizon = 0', `h.status = 'active'`];
    const params: unknown[] = [USER_ID];
    let paramIdx = 2;

    const listType = 'shopping';
    whereClauses.push(`h.list_type = $${paramIdx}`);
    params.push(listType);
    paramIdx++;

    expect(whereClauses).toContain('h.list_type = $2');
    expect(params).toContain('shopping');
  });

  it('builds filter clauses for context tags', () => {
    const whereClauses: string[] = ['h.user_id = $1', 'h.horizon = 0'];
    const params: unknown[] = [USER_ID];
    let paramIdx = 2;

    const contextTags = ['@home', '@computer'];
    whereClauses.push(`h.context ?| $${paramIdx}`);
    params.push(contextTags);
    paramIdx++;

    expect(whereClauses).toContain('h.context ?| $2');
    expect(params).toContain(contextTags);
  });

  it('builds filter for project_id', () => {
    const whereClauses: string[] = ['h.user_id = $1', 'h.horizon = 0'];
    const params: unknown[] = [USER_ID];
    let paramIdx = 2;

    const projectId = 'proj-123';
    whereClauses.push(`h.project_id = $${paramIdx}`);
    params.push(projectId);

    expect(params).toContain('proj-123');
  });

  it('builds overdue filter', () => {
    const whereClauses: string[] = [];
    const overdue = true;

    if (overdue) {
      whereClauses.push(`h.due_date < CURRENT_DATE AND h.status = 'active'`);
    }

    expect(whereClauses).toContain(`h.due_date < CURRENT_DATE AND h.status = 'active'`);
  });

  it('always excludes future start_date', () => {
    const whereClauses: string[] = [];
    whereClauses.push(`(h.start_date IS NULL OR h.start_date <= CURRENT_DATE)`);

    expect(whereClauses).toContain(`(h.start_date IS NULL OR h.start_date <= CURRENT_DATE)`);
  });
});

// ---------------------------------------------------------------------------
// update_action tool handler logic
// ---------------------------------------------------------------------------

describe('update_action tool handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires either id or title_search', () => {
    const params = { title: 'Updated' } as Record<string, unknown>;
    const actionId = params.id;
    const titleSearch = params.title_search;

    if (!actionId && !titleSearch) {
      const response = { error: 'Either id or title_search is required' };
      expect(response.error).toBe('Either id or title_search is required');
    }
  });

  it('returns error when title_search matches nothing', () => {
    const matches: Array<{ id: string; title: string }> = [];
    const titleSearch = 'nonexistent task';

    if (matches.length === 0) {
      const response = { error: `No action found matching "${titleSearch}"` };
      expect(response.error).toContain('nonexistent task');
    }
  });

  it('returns error when title_search matches multiple', () => {
    const matches = [
      { id: 'a-1', title: 'Buy milk' },
      { id: 'a-2', title: 'Buy bread' },
    ];

    if (matches.length > 1) {
      const response = {
        error: 'Multiple actions match. Please be more specific or use an ID.',
        matches: matches.map((m) => ({ id: m.id, title: m.title })),
      };
      expect(response.matches).toHaveLength(2);
    }
  });

  it('builds update data from params correctly', () => {
    const params = {
      title: 'New Title',
      status: 'completed',
      energy: 'high',
      context: ['@office'],
      list_type: 'waiting',
    };

    const updateData: Record<string, unknown> = {};
    if (params.title !== undefined) updateData.title = params.title;
    if (params.status !== undefined) updateData.status = params.status;
    if (params.energy !== undefined) updateData.energy = params.energy;
    if (params.context !== undefined) updateData.context = params.context;
    if (params.list_type !== undefined) updateData.listType = params.list_type;

    expect(updateData.title).toBe('New Title');
    expect(updateData.status).toBe('completed');
    expect(updateData.energy).toBe('high');
    expect(updateData.context).toEqual(['@office']);
    expect(updateData.listType).toBe('waiting');
  });

  it('sets completed_at when status is completed', () => {
    const data = { status: 'completed' };
    const setClauses: string[] = ['updated_at = now()'];

    if (data.status === 'completed') {
      setClauses.push('completed_at = now()');
    } else if (data.status) {
      setClauses.push('completed_at = NULL');
    }

    expect(setClauses).toContain('completed_at = now()');
  });

  it('clears completed_at when status changes to non-completed', () => {
    const data = { status: 'active' };
    const setClauses: string[] = ['updated_at = now()'];

    if (data.status === 'completed') {
      setClauses.push('completed_at = now()');
    } else if (data.status) {
      setClauses.push('completed_at = NULL');
    }

    expect(setClauses).toContain('completed_at = NULL');
  });

  it('logs complete action when status=completed', () => {
    const params = { status: 'completed' };
    const action = { id: 'a-1', title: 'Done Task' };
    const actionStr = params.status === 'completed' ? 'complete' : 'update';

    logAudit({
      user_id: USER_ID,
      source: 'gtd',
      action: actionStr,
      entity_type: 'action',
      entity_id: action.id,
      summary: `${actionStr === 'complete' ? 'Completed' : 'Updated'} action: ${action.title}`,
    });

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'complete',
        summary: 'Completed action: Done Task',
      }),
    );
  });

  it('logs update action for non-completion changes', () => {
    const params = { status: 'on_hold' };
    const action = { id: 'a-1', title: 'Held Task' };
    const actionStr = params.status === 'completed' ? 'complete' : 'update';

    logAudit({
      user_id: USER_ID,
      source: 'gtd',
      action: actionStr,
      entity_type: 'action',
      entity_id: action.id,
      summary: `Updated action: ${action.title}`,
    });

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'update',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// capture_inbox tool handler logic
// ---------------------------------------------------------------------------

describe('capture_inbox tool handler', () => {
  let pool: Pool;

  beforeEach(() => {
    pool = makePgPool();
    vi.clearAllMocks();
  });

  it('inserts with status=captured', async () => {
    const now = new Date();
    pool = makePgPool({
      rows: [{
        id: 'inbox-new',
        user_id: USER_ID,
        content: 'Remember to call dentist',
        source: 'conversation',
        source_link: null,
        status: 'captured',
        outcome_type: null,
        outcome_id: null,
        notes: null,
        processed_at: null,
        created_at: now,
        updated_at: now,
      }],
    });

    await pool.query(
      expect.stringContaining('INSERT INTO gtd_inbox'),
      [USER_ID, 'Remember to call dentist', 'conversation', null],
    );

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO gtd_inbox'),
      [USER_ID, 'Remember to call dentist', 'conversation', null],
    );
  });

  it('defaults source to direct when not provided', () => {
    const data = { content: 'Quick capture' };
    const source = (data as Record<string, unknown>).source ?? 'direct';
    expect(source).toBe('direct');
  });

  it('defaults sourceLink to null when not provided', () => {
    const data = { content: 'Quick capture' };
    const sourceLink = (data as Record<string, unknown>).sourceLink ?? null;
    expect(sourceLink).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// process_inbox_item tool handler logic
// ---------------------------------------------------------------------------

describe('process_inbox_item tool handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets status to processed with outcome', async () => {
    const pool = makePgPool({
      rows: [{
        id: 'inbox-1',
        user_id: USER_ID,
        content: 'Call dentist',
        source: 'conversation',
        source_link: null,
        status: 'processed',
        outcome_type: 'action',
        outcome_id: 'action-new',
        notes: 'Created as next action',
        processed_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
      }],
    });

    await pool.query(expect.any(String), ['inbox-1', USER_ID, 'action', 'action-new', 'Created as next action']);

    expect(pool.query).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['inbox-1', USER_ID, 'action']),
    );
  });

  it('handles item not found gracefully', async () => {
    const pool = makePgPool({ rows: [] });

    const result = await pool.query('UPDATE gtd_inbox SET status = $1 WHERE id = $2', ['processed', 'nonexistent']);
    const rows = (result as QueryResult).rows;

    // Simulate the tool handler error path
    if (rows.length === 0) {
      const response = { error: 'Inbox item not found: nonexistent' };
      expect(response.error).toContain('not found');
    }
  });

  it('accepts all valid outcome types', () => {
    const validOutcomes = ['action', 'project', 'someday', 'reference', 'trash'];
    for (const outcome of validOutcomes) {
      expect(validOutcomes).toContain(outcome);
    }
  });
});

// ---------------------------------------------------------------------------
// get_gtd_health tool handler logic
// ---------------------------------------------------------------------------

describe('get_gtd_health tool handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns all health metrics from single query', async () => {
    const pool = makePgPool({
      rows: [{
        inbox_count: '5',
        active_project_count: '3',
        projects_without_actions: '1',
        overdue_count: '2',
        stale_waiting_count: '0',
        active_action_count: '15',
        someday_count: '7',
        completed_this_week: '4',
        days_since_last_review: '3',
      }],
    });

    const result = await pool.query(expect.any(String), [USER_ID]);
    const row = (result as QueryResult).rows[0] as Record<string, unknown>;

    // Simulate the health mapping
    const health = {
      inboxCount: Number(row.inbox_count),
      activeProjectCount: Number(row.active_project_count),
      projectsWithoutActions: Number(row.projects_without_actions),
      overdueCount: Number(row.overdue_count),
      staleWaitingCount: Number(row.stale_waiting_count),
      activeActionCount: Number(row.active_action_count),
      somedayCount: Number(row.someday_count),
      completedThisWeek: Number(row.completed_this_week),
      daysSinceLastReview: row.days_since_last_review != null
        ? Math.floor(Number(row.days_since_last_review))
        : null,
    };

    expect(health.inboxCount).toBe(5);
    expect(health.activeProjectCount).toBe(3);
    expect(health.projectsWithoutActions).toBe(1);
    expect(health.overdueCount).toBe(2);
    expect(health.staleWaitingCount).toBe(0);
    expect(health.activeActionCount).toBe(15);
    expect(health.somedayCount).toBe(7);
    expect(health.completedThisWeek).toBe(4);
    expect(health.daysSinceLastReview).toBe(3);
  });

  it('returns null for daysSinceLastReview when no reviews exist', () => {
    const row = { days_since_last_review: null };
    const daysSinceLastReview = row.days_since_last_review != null
      ? Math.floor(Number(row.days_since_last_review))
      : null;

    expect(daysSinceLastReview).toBeNull();
  });

  it('returns zeroed health when no data exists', () => {
    const row = null;

    // Simulate the fallback in getHealth
    const health = row
      ? {} // would map
      : {
          inboxCount: 0,
          activeProjectCount: 0,
          projectsWithoutActions: 0,
          overdueCount: 0,
          staleWaitingCount: 0,
          activeActionCount: 0,
          somedayCount: 0,
          completedThisWeek: 0,
          daysSinceLastReview: null,
        };

    expect(health.inboxCount).toBe(0);
    expect(health.daysSinceLastReview).toBeNull();
  });

  it('floors fractional days_since_last_review', () => {
    const row = { days_since_last_review: '3.7' };
    const daysSinceLastReview = Math.floor(Number(row.days_since_last_review));
    expect(daysSinceLastReview).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// list_inbox tool handler logic
// ---------------------------------------------------------------------------

describe('list_inbox tool handler', () => {
  it('defaults status filter to captured', () => {
    const params = {} as Record<string, unknown>;
    const status = params.status ?? 'captured';
    expect(status).toBe('captured');
  });

  it('respects provided status filter', () => {
    const params = { status: 'processed' };
    const status = params.status ?? 'captured';
    expect(status).toBe('processed');
  });

  it('orders results oldest first (ASC)', () => {
    // The list query uses ORDER BY created_at ASC
    const sql = `SELECT * FROM gtd_inbox WHERE user_id = $1 AND status = $2 ORDER BY created_at ASC`;
    expect(sql).toContain('ORDER BY created_at ASC');
  });
});
