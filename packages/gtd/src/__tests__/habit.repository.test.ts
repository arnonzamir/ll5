import { describe, it, expect, vi } from 'vitest';
import { PostgresHabitRepository } from '../repositories/postgres/habit.repository.js';
import { mapHabitRow, mapHabitLogRow } from '../repositories/postgres/base.repository.js';
import { makeMockPool } from './_helpers.js';

const USER_A = 'user-a';

/** Helper: extract the SQL + params from the Nth pool.query() call. */
function call(query: ReturnType<typeof vi.fn>, n: number): { sql: string; params: unknown[] } {
  const args = query.mock.calls[n] as [string, unknown[]];
  return { sql: args[0], params: args[1] };
}

const habitRow = (over: Record<string, unknown> = {}) => ({
  id: 'habit-1',
  user_id: USER_A,
  name: 'Ritalin AM',
  description: null,
  schedule: { days: 'daily', times: ['08:00'] },
  check_kind: 'gtd_action',
  check_config: {},
  escalation: [{ offset_minutes: 0, level: 'silent' }],
  status: 'active',
  timezone: 'Asia/Jerusalem',
  created_at: new Date('2026-07-01'),
  updated_at: new Date('2026-07-01'),
  ...over,
});

const logRow = (over: Record<string, unknown> = {}) => ({
  id: 'log-1',
  habit_id: 'habit-1',
  user_id: USER_A,
  due_date: '2026-07-02',
  due_time: '08:00',
  due_at: null,
  outcome: 'done',
  closed_at: new Date('2026-07-02T08:05:00Z'),
  note: null,
  steps_fired: [],
  created_at: new Date('2026-07-02'),
  ...over,
});

describe('PostgresHabitRepository.create', () => {
  it('inserts with user_id and serialized JSONB fields', async () => {
    const { pool, query } = makeMockPool([[habitRow()]]);
    const repo = new PostgresHabitRepository(pool);

    const habit = await repo.create(USER_A, {
      name: 'Ritalin AM',
      schedule: { days: 'daily', times: ['08:00'] },
      checkKind: 'gtd_action',
      checkConfig: { action_title: 'Take Ritalin AM' },
      escalation: [{ offset_minutes: 0, level: 'silent' }],
      timezone: 'Asia/Jerusalem',
    });

    const { sql, params } = call(query, 0);
    expect(sql).toMatch(/INSERT INTO gtd_habits/);
    expect(params[0]).toBe(USER_A);
    expect(params[1]).toBe('Ritalin AM');
    expect(params[3]).toBe(JSON.stringify({ days: 'daily', times: ['08:00'] }));
    expect(params[4]).toBe('gtd_action');
    expect(params[5]).toBe(JSON.stringify({ action_title: 'Take Ritalin AM' }));
    expect(params[6]).toBe(JSON.stringify([{ offset_minutes: 0, level: 'silent' }]));
    expect(params[7]).toBe('Asia/Jerusalem');
    expect(habit.userId).toBe(USER_A);
    expect(habit.checkKind).toBe('gtd_action');
  });

  it('defaults check_config to {} and escalation stays as given', async () => {
    const { pool, query } = makeMockPool([[habitRow()]]);
    const repo = new PostgresHabitRepository(pool);

    await repo.create(USER_A, {
      name: 'X',
      schedule: { days: [1, 3], times: ['07:00'] },
      checkKind: 'user_confirm',
      escalation: [],
    });

    const { params } = call(query, 0);
    expect(params[5]).toBe('{}');
    expect(params[6]).toBe('[]');
    expect(params[7]).toBeNull();
  });
});

describe('PostgresHabitRepository.update', () => {
  it('updates only the provided fields and scopes by user_id', async () => {
    const { pool, query } = makeMockPool([[habitRow({ status: 'paused' })]]);
    const repo = new PostgresHabitRepository(pool);

    await repo.update(USER_A, 'habit-1', { status: 'paused' });

    const { sql, params } = call(query, 0);
    expect(sql).toMatch(/UPDATE gtd_habits/);
    expect(sql).toMatch(/updated_at = now\(\)/);
    expect(sql).toMatch(/status = \$1/);
    expect(sql).not.toMatch(/name =/);
    expect(sql).not.toMatch(/schedule =/);
    expect(sql).toMatch(/WHERE id = \$2 AND user_id = \$3/);
    expect(params).toEqual(['paused', 'habit-1', USER_A]);
  });

  it('serializes schedule/escalation on update', async () => {
    const { pool, query } = makeMockPool([[habitRow()]]);
    const repo = new PostgresHabitRepository(pool);

    await repo.update(USER_A, 'habit-1', {
      schedule: { days: 'daily', times: ['09:00'] },
      escalation: [{ offset_minutes: 15, level: 'notify' }],
    });

    const { params } = call(query, 0);
    expect(params[0]).toBe(JSON.stringify({ days: 'daily', times: ['09:00'] }));
    expect(params[1]).toBe(JSON.stringify([{ offset_minutes: 15, level: 'notify' }]));
  });

  it("throws when the habit does not exist (or belongs to another user)", async () => {
    const { pool } = makeMockPool([]); // scoped UPDATE matches no rows
    const repo = new PostgresHabitRepository(pool);

    await expect(repo.update(USER_A, 'habit-of-user-b', { status: 'retired' }))
      .rejects.toThrow('Habit not found: habit-of-user-b');
  });
});

describe('PostgresHabitRepository.findById / list', () => {
  it('findById binds id and user_id (cross-tenant scope)', async () => {
    const { pool, query } = makeMockPool([]);
    const repo = new PostgresHabitRepository(pool);

    const result = await repo.findById(USER_A, 'habit-of-user-b');

    expect(result).toBeNull();
    const { sql, params } = call(query, 0);
    expect(sql).toMatch(/WHERE id = \$1 AND user_id = \$2/);
    expect(params).toEqual(['habit-of-user-b', USER_A]);
  });

  it('list scopes by user_id and filters by status when given', async () => {
    const { pool, query } = makeMockPool([[habitRow()]]);
    const repo = new PostgresHabitRepository(pool);

    const habits = await repo.list(USER_A, { status: 'active' });

    expect(habits).toHaveLength(1);
    const { sql, params } = call(query, 0);
    expect(sql).toMatch(/WHERE user_id = \$1 AND status = \$2/);
    expect(params).toEqual([USER_A, 'active']);
  });

  it('list without filters returns all statuses for the user only', async () => {
    const { pool, query } = makeMockPool([[habitRow(), habitRow({ id: 'habit-2', status: 'retired' })]]);
    const repo = new PostgresHabitRepository(pool);

    const habits = await repo.list(USER_A);

    expect(habits).toHaveLength(2);
    const { sql, params } = call(query, 0);
    expect(sql).not.toMatch(/status =/);
    expect(params).toEqual([USER_A]);
  });
});

describe('PostgresHabitRepository.logOutcome', () => {
  it('upserts on (habit_id, due_date, due_time) updating only outcome/closed_at/note', async () => {
    const { pool, query } = makeMockPool([[logRow()]]);
    const repo = new PostgresHabitRepository(pool);

    const entry = await repo.logOutcome(USER_A, {
      habitId: 'habit-1',
      dueDate: '2026-07-02',
      dueTime: '08:00',
      outcome: 'done',
    });

    const { sql, params } = call(query, 0);
    expect(sql).toMatch(/INSERT INTO gtd_habit_log/);
    expect(sql).toMatch(/ON CONFLICT \(habit_id, due_date, due_time\)/);
    expect(sql).toMatch(/outcome = EXCLUDED\.outcome/);
    expect(sql).toMatch(/closed_at = now\(\)/);
    // Omitted note must not wipe an existing one.
    expect(sql).toMatch(/note = COALESCE\(EXCLUDED\.note, gtd_habit_log\.note\)/);
    // steps_fired stays scheduler-owned.
    expect(sql).not.toMatch(/steps_fired = /);
    // Defense-in-depth: conflicting row must belong to the same user.
    expect(sql).toMatch(/WHERE gtd_habit_log\.user_id = \$2/);
    expect(params).toEqual(['habit-1', USER_A, '2026-07-02', '08:00', 'done', null]);
    expect(entry.outcome).toBe('done');
    expect(entry.dueDate).toBe('2026-07-02');
  });

  it('passes the note through when provided', async () => {
    const { pool, query } = makeMockPool([[logRow({ outcome: 'skipped_deliberate', note: 'skipping km today' })]]);
    const repo = new PostgresHabitRepository(pool);

    const entry = await repo.logOutcome(USER_A, {
      habitId: 'habit-1',
      dueDate: '2026-07-02',
      dueTime: '18:00',
      outcome: 'skipped_deliberate',
      note: 'skipping km today',
    });

    const { params } = call(query, 0);
    expect(params[5]).toBe('skipping km today');
    expect(entry.note).toBe('skipping km today');
  });

  it("throws when the conflict row belongs to another user (guarded upsert returns nothing)", async () => {
    const { pool } = makeMockPool([]);
    const repo = new PostgresHabitRepository(pool);

    await expect(repo.logOutcome(USER_A, {
      habitId: 'habit-of-user-b',
      dueDate: '2026-07-02',
      dueTime: '08:00',
      outcome: 'done',
    })).rejects.toThrow(/not writable/);
  });
});

describe('PostgresHabitRepository.listLog', () => {
  it('scopes by user_id and applies habit/date filters', async () => {
    const { pool, query } = makeMockPool([[logRow()]]);
    const repo = new PostgresHabitRepository(pool);

    await repo.listLog(USER_A, { habitId: 'habit-1', fromDate: '2026-06-01', toDate: '2026-07-02' });

    const { sql, params } = call(query, 0);
    expect(sql).toMatch(/WHERE user_id = \$1 AND habit_id = \$2 AND due_date >= \$3 AND due_date <= \$4/);
    expect(params).toEqual([USER_A, 'habit-1', '2026-06-01', '2026-07-02']);
  });

  it('works with no filters (user scope only)', async () => {
    const { pool, query } = makeMockPool([[]]);
    const repo = new PostgresHabitRepository(pool);

    await repo.listLog(USER_A);

    const { sql, params } = call(query, 0);
    expect(sql).toMatch(/WHERE user_id = \$1\s+ORDER BY/);
    expect(params).toEqual([USER_A]);
  });
});

describe('mapHabitRow / mapHabitLogRow', () => {
  it('parses JSONB fields whether pre-parsed or strings', async () => {
    const parsed = mapHabitRow(habitRow({
      schedule: '{"days":[0,3],"times":["08:00","20:00"]}',
      escalation: '[{"offset_minutes":0,"level":"notify"}]',
      check_config: '{"action_title":"X"}',
    }));
    expect(parsed.schedule).toEqual({ days: [0, 3], times: ['08:00', '20:00'] });
    expect(parsed.escalation).toEqual([{ offset_minutes: 0, level: 'notify' }]);
    expect(parsed.checkConfig).toEqual({ action_title: 'X' });

    const preParsed = mapHabitRow(habitRow());
    expect(preParsed.schedule).toEqual({ days: 'daily', times: ['08:00'] });
  });

  it('normalizes pg DATE values (local-midnight Date objects) to YYYY-MM-DD', () => {
    // pg returns DATE columns as a Date at *local* midnight.
    const asDate = mapHabitLogRow(logRow({ due_date: new Date(2026, 6, 2) }));
    expect(asDate.dueDate).toBe('2026-07-02');

    const asString = mapHabitLogRow(logRow({ due_date: '2026-07-02' }));
    expect(asString.dueDate).toBe('2026-07-02');
  });

  it('maps nullable log fields to null and keeps steps_fired as an array', () => {
    const mapped = mapHabitLogRow(logRow({ outcome: null, closed_at: null, steps_fired: '[{"level":"silent"}]' }));
    expect(mapped.outcome).toBeNull();
    expect(mapped.closedAt).toBeNull();
    expect(mapped.stepsFired).toEqual([{ level: 'silent' }]);
  });
});
