import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @ll5/shared.logAudit so we can assert audit emissions without writing
// to ES. This must be hoisted before the tool modules import it.
// ---------------------------------------------------------------------------
vi.mock('@ll5/shared', () => ({
  logAudit: vi.fn(),
}));

import { logAudit } from '@ll5/shared';
import { registerHabitTools } from '../tools/habits.js';
import {
  validateSchedule,
  validateEscalation,
  nearestScheduledTime,
  computeHabitTrend,
  localNow,
} from '../utils/habits.js';
import { captureTools, parseToolResponse } from './_helpers.js';
import type { HabitRepository } from '../repositories/interfaces/habit.repository.js';
import type { Habit, HabitLogEntry } from '../types/index.js';

const USER_ID = 'user-test-1';
const getUserId = () => USER_ID;

// ---------------------------------------------------------------------------
// Repository stub factory — tests override only the methods they exercise.
// ---------------------------------------------------------------------------

function makeHabitRepo(overrides: Partial<HabitRepository> = {}): HabitRepository {
  const unimpl = (name: string) => vi.fn(() => {
    throw new Error(`HabitRepository.${name} not stubbed for this test`);
  });
  return {
    create: unimpl('create'),
    update: unimpl('update'),
    findById: unimpl('findById'),
    list: unimpl('list'),
    logOutcome: unimpl('logOutcome'),
    listLog: unimpl('listLog'),
    ...overrides,
  } as HabitRepository;
}

function fakeHabit(over: Partial<Habit> = {}): Habit {
  const now = new Date();
  return {
    id: 'habit-stub',
    userId: USER_ID,
    name: 'Stub habit',
    description: null,
    schedule: { days: 'daily', times: ['08:00'] },
    checkKind: 'user_confirm',
    checkConfig: {},
    escalation: [{ offset_minutes: 0, level: 'notify' }],
    status: 'active',
    timezone: 'UTC',
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function fakeLogEntry(over: Partial<HabitLogEntry> = {}): HabitLogEntry {
  return {
    id: 'log-stub',
    habitId: 'habit-stub',
    userId: USER_ID,
    dueDate: '2026-07-02',
    dueTime: '08:00',
    dueAt: null,
    outcome: 'done',
    closedAt: new Date(),
    note: null,
    stepsFired: [],
    createdAt: new Date(),
    ...over,
  };
}

// ===========================================================================
// PURE HELPER TESTS — validation, nearest-time resolution, trends math.
// ===========================================================================

describe('validateSchedule', () => {
  it('accepts daily with valid times', () => {
    expect(validateSchedule({ days: 'daily', times: ['08:00', '23:59'] })).toBeNull();
  });

  it('accepts day-of-week arrays', () => {
    expect(validateSchedule({ days: [0, 6], times: ['07:30'] })).toBeNull();
  });

  it('rejects empty times', () => {
    expect(validateSchedule({ days: 'daily', times: [] })).toMatch(/non-empty/);
  });

  it('rejects malformed times', () => {
    expect(validateSchedule({ days: 'daily', times: ['8:00'] })).toMatch(/invalid time/);
    expect(validateSchedule({ days: 'daily', times: ['24:00'] })).toMatch(/invalid time/);
    expect(validateSchedule({ days: 'daily', times: ['08:60'] })).toMatch(/invalid time/);
  });

  it('rejects invalid day values and empty day arrays', () => {
    expect(validateSchedule({ days: [7], times: ['08:00'] })).toMatch(/invalid day/);
    expect(validateSchedule({ days: [1.5], times: ['08:00'] })).toMatch(/invalid day/);
    expect(validateSchedule({ days: [], times: ['08:00'] })).toMatch(/"daily" or a non-empty array/);
  });

  it('rejects non-object schedules', () => {
    expect(validateSchedule(null)).toMatch(/must be an object/);
    expect(validateSchedule('daily')).toMatch(/must be an object/);
  });
});

describe('validateEscalation', () => {
  it('accepts an ordered step list and the empty list', () => {
    expect(validateEscalation([
      { offset_minutes: -10, level: 'silent' },
      { offset_minutes: 0, level: 'notify' },
      { offset_minutes: 30, level: 'alert' },
      { offset_minutes: 60, level: 'critical' },
    ])).toBeNull();
    expect(validateEscalation([])).toBeNull();
  });

  it('rejects unknown levels', () => {
    expect(validateEscalation([{ offset_minutes: 0, level: 'shout' }])).toMatch(/unknown level/);
  });

  it('rejects non-integer offsets', () => {
    expect(validateEscalation([{ offset_minutes: 1.5, level: 'notify' }])).toMatch(/offset_minutes/);
    expect(validateEscalation([{ level: 'notify' }])).toMatch(/offset_minutes/);
  });

  it('rejects non-array escalation', () => {
    expect(validateEscalation({ offset_minutes: 0, level: 'notify' })).toMatch(/must be an array/);
  });
});

describe('nearestScheduledTime', () => {
  it('returns the single time regardless of now', () => {
    expect(nearestScheduledTime(['08:00'], '23:00')).toBe('08:00');
  });

  it('picks the nearest of several times', () => {
    expect(nearestScheduledTime(['08:00', '14:00', '21:00'], '13:00')).toBe('14:00');
    expect(nearestScheduledTime(['08:00', '14:00', '21:00'], '09:30')).toBe('08:00');
  });

  it('returns null on an exact tie (ambiguous)', () => {
    expect(nearestScheduledTime(['08:00', '12:00'], '10:00')).toBeNull();
  });
});

describe('computeHabitTrend', () => {
  const habit = { id: 'h-1', name: 'Training', status: 'active' as const };
  const entry = (dueDate: string, outcome: HabitLogEntry['outcome'], over: Partial<HabitLogEntry> = {}) =>
    fakeLogEntry({ habitId: 'h-1', dueDate, outcome, ...over });

  it('computes weekly completion rate as done/(done+missed+skipped), excluding excused', () => {
    const today = '2026-07-02';
    const entries = [
      entry('2026-07-02', 'done'),
      entry('2026-07-01', 'missed'),
      entry('2026-06-30', 'skipped_deliberate'),
      entry('2026-06-29', 'excused'),
      entry('2026-06-28', 'done'),
    ];
    const trend = computeHabitTrend(habit, entries, 1, today);

    expect(trend.weekly).toHaveLength(1);
    const week = trend.weekly[0];
    expect(week.weekStart).toBe('2026-06-26');
    expect(week.weekEnd).toBe('2026-07-02');
    expect(week.done).toBe(2);
    expect(week.missed).toBe(1);
    expect(week.skipped).toBe(1);
    expect(week.excused).toBe(1);
    expect(week.completionRate).toBe(0.5); // 2 / (2+1+1)
  });

  it('reports null completion rate for weeks with no closed occurrences', () => {
    const trend = computeHabitTrend(habit, [], 2, '2026-07-02');
    expect(trend.weekly).toHaveLength(2);
    expect(trend.weekly[0].completionRate).toBeNull();
    expect(trend.weekly[1].completionRate).toBeNull();
    // Oldest-first ordering.
    expect(trend.weekly[0].weekEnd < trend.weekly[1].weekStart).toBe(true);
  });

  it('counts a streak of all-done days and breaks it on a miss', () => {
    const entries = [
      entry('2026-07-02', 'done'),
      entry('2026-07-01', 'done'),
      entry('2026-06-30', 'missed'),
      entry('2026-06-29', 'done'),
    ];
    const trend = computeHabitTrend(habit, entries, 4, '2026-07-02');
    expect(trend.currentStreakDays).toBe(2);
  });

  it('breaks the streak on skipped_deliberate even when another occurrence is done that day', () => {
    const entries = [
      entry('2026-07-02', 'done', { dueTime: '08:00' }),
      entry('2026-07-02', 'skipped_deliberate', { dueTime: '20:00' }),
      entry('2026-07-01', 'done'),
    ];
    const trend = computeHabitTrend(habit, entries, 4, '2026-07-02');
    expect(trend.currentStreakDays).toBe(0);
  });

  it('treats excused occurrences and gap days as neutral (streak continues past them)', () => {
    const entries = [
      entry('2026-07-02', 'done'),
      entry('2026-07-01', 'excused'), // excused-only day: neutral, not a break
      // 2026-06-30: no occurrence at all (not scheduled): neutral
      entry('2026-06-29', 'done'),
      entry('2026-06-28', 'missed'),
    ];
    const trend = computeHabitTrend(habit, entries, 4, '2026-07-02');
    expect(trend.currentStreakDays).toBe(2); // Jul 2 + Jun 29; excused/gap days don't count or break
  });

  it('does not let an open (unclosed) occurrence break a streak', () => {
    const entries = [
      entry('2026-07-02', null, { dueTime: '20:00' }), // tonight, still open
      entry('2026-07-02', 'done', { dueTime: '08:00' }),
      entry('2026-07-01', 'done'),
    ];
    const trend = computeHabitTrend(habit, entries, 4, '2026-07-02');
    expect(trend.currentStreakDays).toBe(2);
  });

  it('lists the last 10 misses/skips most-recent-first with notes', () => {
    const entries = [
      entry('2026-07-01', 'missed', { note: null }),
      entry('2026-06-20', 'skipped_deliberate', { note: 'second skip this week' }),
      entry('2026-07-02', 'done'),
      ...Array.from({ length: 12 }, (_, i) =>
        entry(`2026-06-${String(i + 1).padStart(2, '0')}`, 'missed')),
    ];
    const trend = computeHabitTrend(habit, entries, 6, '2026-07-02');

    expect(trend.recentMisses).toHaveLength(10);
    expect(trend.recentMisses[0].dueDate).toBe('2026-07-01');
    expect(trend.recentMisses[1]).toMatchObject({
      dueDate: '2026-06-20',
      outcome: 'skipped_deliberate',
      note: 'second skip this week',
    });
    expect(trend.recentMisses.every((m) => m.outcome !== 'done')).toBe(true);
  });
});

// ===========================================================================
// TOOL HANDLER TESTS
// ===========================================================================

describe('create_habit tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  const validParams = {
    name: 'Ritalin AM',
    schedule: { days: 'daily', times: ['08:00'] },
    check_kind: 'gtd_action',
    check_config: { action_title: 'Take Ritalin AM' },
    escalation: [
      { offset_minutes: -10, level: 'silent' },
      { offset_minutes: 30, level: 'critical' },
    ],
    timezone: 'Asia/Jerusalem',
  };

  it('creates a habit, forwarding camelCase fields with the user id', async () => {
    const create = vi.fn(async () => fakeHabit({ id: 'habit-new', name: 'Ritalin AM' }));
    const repo = makeHabitRepo({ create });
    const tools = captureTools((s) => registerHabitTools(s, repo, getUserId));

    const response = await tools.get('create_habit')!(validParams);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toBe(USER_ID);
    expect(create.mock.calls[0][1]).toEqual({
      name: 'Ritalin AM',
      description: undefined,
      schedule: { days: 'daily', times: ['08:00'] },
      checkKind: 'gtd_action',
      checkConfig: { action_title: 'Take Ritalin AM' },
      escalation: validParams.escalation,
      timezone: 'Asia/Jerusalem',
    });
    expect(response.isError).toBeUndefined();
    expect(parseToolResponse<{ habit: { id: string } }>(response).habit.id).toBe('habit-new');
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      user_id: USER_ID,
      source: 'gtd',
      action: 'create',
      entity_type: 'habit',
      entity_id: 'habit-new',
    }));
  });

  it('rejects an empty times array without touching the repo', async () => {
    const create = vi.fn();
    const repo = makeHabitRepo({ create: create as never });
    const tools = captureTools((s) => registerHabitTools(s, repo, getUserId));

    const response = await tools.get('create_habit')!({
      ...validParams,
      schedule: { days: 'daily', times: [] },
    });

    expect(response.isError).toBe(true);
    expect(parseToolResponse<{ error: string }>(response).error).toMatch(/times/);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects unknown escalation levels', async () => {
    const create = vi.fn();
    const repo = makeHabitRepo({ create: create as never });
    const tools = captureTools((s) => registerHabitTools(s, repo, getUserId));

    const response = await tools.get('create_habit')!({
      ...validParams,
      escalation: [{ offset_minutes: 0, level: 'yell' }],
    });

    expect(response.isError).toBe(true);
    expect(parseToolResponse<{ error: string }>(response).error).toMatch(/unknown level/);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects invalid days and invalid timezones', async () => {
    const repo = makeHabitRepo();
    const tools = captureTools((s) => registerHabitTools(s, repo, getUserId));

    const badDays = await tools.get('create_habit')!({
      ...validParams,
      schedule: { days: [8], times: ['08:00'] },
    });
    expect(badDays.isError).toBe(true);

    const badTz = await tools.get('create_habit')!({
      ...validParams,
      timezone: 'Mars/Olympus_Mons',
    });
    expect(badTz.isError).toBe(true);
    expect(parseToolResponse<{ error: string }>(badTz).error).toMatch(/timezone/i);
  });
});

describe('update_habit tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards only the provided fields (pause via status)', async () => {
    const update = vi.fn(async () => fakeHabit({ id: 'h-1', status: 'paused' }));
    const repo = makeHabitRepo({ update });
    const tools = captureTools((s) => registerHabitTools(s, repo, getUserId));

    const response = await tools.get('update_habit')!({ id: 'h-1', status: 'paused' });

    expect(update).toHaveBeenCalledWith(USER_ID, 'h-1', { status: 'paused' });
    expect(response.isError).toBeUndefined();
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'update', entity_type: 'habit' }));
  });

  it('validates a replacement schedule before calling the repo', async () => {
    const update = vi.fn();
    const repo = makeHabitRepo({ update: update as never });
    const tools = captureTools((s) => registerHabitTools(s, repo, getUserId));

    const response = await tools.get('update_habit')!({
      id: 'h-1',
      schedule: { days: 'daily', times: ['25:00'] },
    });

    expect(response.isError).toBe(true);
    expect(update).not.toHaveBeenCalled();
  });

  it('returns isError when the habit is missing (repo throws)', async () => {
    const repo = makeHabitRepo({
      update: vi.fn(async () => { throw new Error('Habit not found: h-x'); }),
    });
    const tools = captureTools((s) => registerHabitTools(s, repo, getUserId));

    const response = await tools.get('update_habit')!({ id: 'h-x', status: 'retired' });

    expect(response.isError).toBe(true);
    expect(parseToolResponse<{ error: string }>(response).error).toMatch(/not found/);
  });
});

describe('log_habit_outcome tool handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // 2026-07-02 (Thursday) 09:30 UTC.
    vi.setSystemTime(new Date('2026-07-02T09:30:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('returns isError for a habit the user does not own', async () => {
    const findById = vi.fn(async () => null);
    const repo = makeHabitRepo({ findById });
    const tools = captureTools((s) => registerHabitTools(s, repo, getUserId));

    const response = await tools.get('log_habit_outcome')!({ habit_id: 'h-other', outcome: 'done' });

    expect(findById).toHaveBeenCalledWith(USER_ID, 'h-other');
    expect(response.isError).toBe(true);
    expect(parseToolResponse<{ error: string }>(response).error).toMatch(/not found/);
  });

  it('defaults due_date to today in the habit timezone and due_time to the single scheduled time', async () => {
    const logOutcome = vi.fn(async () => fakeLogEntry());
    const repo = makeHabitRepo({
      findById: vi.fn(async () => fakeHabit({ id: 'h-1', timezone: 'UTC', schedule: { days: 'daily', times: ['08:00'] } })),
      logOutcome,
    });
    const tools = captureTools((s) => registerHabitTools(s, repo, getUserId));

    const response = await tools.get('log_habit_outcome')!({ habit_id: 'h-1', outcome: 'done' });

    expect(logOutcome).toHaveBeenCalledWith(USER_ID, {
      habitId: 'h-1',
      dueDate: '2026-07-02',
      dueTime: '08:00',
      outcome: 'done',
      note: undefined,
    });
    expect(response.isError).toBeUndefined();
  });

  it('resolves the timezone-local date (already tomorrow east of UTC)', async () => {
    vi.setSystemTime(new Date('2026-07-02T22:30:00Z')); // 01:30 Jul 3 in Jerusalem (UTC+3)
    const logOutcome = vi.fn(async () => fakeLogEntry());
    const repo = makeHabitRepo({
      findById: vi.fn(async () => fakeHabit({ timezone: 'Asia/Jerusalem', schedule: { days: 'daily', times: ['08:00'] } })),
      logOutcome,
    });
    const tools = captureTools((s) => registerHabitTools(s, repo, getUserId));

    await tools.get('log_habit_outcome')!({ habit_id: 'h-1', outcome: 'done' });

    expect((logOutcome.mock.calls[0][1] as { dueDate: string }).dueDate).toBe('2026-07-03');
  });

  it('picks the nearest scheduled time when there are several', async () => {
    const logOutcome = vi.fn(async () => fakeLogEntry());
    const repo = makeHabitRepo({
      // now = 09:30 UTC; nearest of 08:00 / 14:00 / 21:00 is 08:00.
      findById: vi.fn(async () => fakeHabit({ timezone: 'UTC', schedule: { days: 'daily', times: ['08:00', '14:00', '21:00'] } })),
      logOutcome,
    });
    const tools = captureTools((s) => registerHabitTools(s, repo, getUserId));

    await tools.get('log_habit_outcome')!({ habit_id: 'h-1', outcome: 'done' });

    expect((logOutcome.mock.calls[0][1] as { dueTime: string }).dueTime).toBe('08:00');
  });

  it('requires an explicit due_time on an exact tie', async () => {
    vi.setSystemTime(new Date('2026-07-02T10:00:00Z')); // equidistant from 08:00 and 12:00
    const logOutcome = vi.fn();
    const repo = makeHabitRepo({
      findById: vi.fn(async () => fakeHabit({ timezone: 'UTC', schedule: { days: 'daily', times: ['08:00', '12:00'] } })),
      logOutcome: logOutcome as never,
    });
    const tools = captureTools((s) => registerHabitTools(s, repo, getUserId));

    const response = await tools.get('log_habit_outcome')!({ habit_id: 'h-1', outcome: 'done' });

    expect(response.isError).toBe(true);
    const parsed = parseToolResponse<{ error: string; scheduled_times: string[] }>(response);
    expect(parsed.error).toMatch(/due_time/);
    expect(parsed.scheduled_times).toEqual(['08:00', '12:00']);
    expect(logOutcome).not.toHaveBeenCalled();
  });

  it('honors explicit due_date/due_time and forwards the note (early confirm / reconciliation)', async () => {
    const logOutcome = vi.fn(async () => fakeLogEntry({ outcome: 'excused', note: 'travel day' }));
    const repo = makeHabitRepo({
      findById: vi.fn(async () => fakeHabit()),
      logOutcome,
    });
    const tools = captureTools((s) => registerHabitTools(s, repo, getUserId));

    const response = await tools.get('log_habit_outcome')!({
      habit_id: 'h-1',
      due_date: '2026-07-01',
      due_time: '20:00',
      outcome: 'excused',
      note: 'travel day',
    });

    expect(logOutcome).toHaveBeenCalledWith(USER_ID, {
      habitId: 'habit-stub',
      dueDate: '2026-07-01',
      dueTime: '20:00',
      outcome: 'excused',
      note: 'travel day',
    });
    const parsed = parseToolResponse<{ occurrence: { outcome: string } }>(response);
    expect(parsed.occurrence.outcome).toBe('excused');
  });

  it('rejects malformed due_date / due_time', async () => {
    const repo = makeHabitRepo({ findById: vi.fn(async () => fakeHabit()) });
    const tools = captureTools((s) => registerHabitTools(s, repo, getUserId));

    const badDate = await tools.get('log_habit_outcome')!({ habit_id: 'h-1', due_date: 'yesterday', outcome: 'done' });
    expect(badDate.isError).toBe(true);

    const badTime = await tools.get('log_habit_outcome')!({ habit_id: 'h-1', due_time: '8pm', outcome: 'done' });
    expect(badTime.isError).toBe(true);
  });
});

describe('list_habits tool handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-02T09:30:00Z')); // Thursday (dow 4)
  });
  afterEach(() => vi.useRealTimers());

  it('forwards the status filter and returns [] with no repo log call when empty', async () => {
    const list = vi.fn(async () => []);
    const listLog = vi.fn();
    const repo = makeHabitRepo({ list, listLog: listLog as never });
    const tools = captureTools((s) => registerHabitTools(s, repo, getUserId));

    const response = await tools.get('list_habits')!({ status: 'active' });

    expect(list).toHaveBeenCalledWith(USER_ID, { status: 'active' });
    expect(listLog).not.toHaveBeenCalled();
    expect(parseToolResponse<{ habits: unknown[] }>(response).habits).toEqual([]);
  });

  it('merges today\'s log rows into per-occurrence states (open vs logged)', async () => {
    const habit = fakeHabit({
      id: 'h-1',
      timezone: 'UTC',
      schedule: { days: 'daily', times: ['08:00', '20:00'] },
    });
    const repo = makeHabitRepo({
      list: vi.fn(async () => [habit]),
      listLog: vi.fn(async () => [
        fakeLogEntry({ habitId: 'h-1', dueDate: '2026-07-02', dueTime: '08:00', outcome: 'done' }),
        // Yesterday's row must not leak into today's states.
        fakeLogEntry({ habitId: 'h-1', dueDate: '2026-07-01', dueTime: '20:00', outcome: 'missed' }),
      ]),
    });
    const tools = captureTools((s) => registerHabitTools(s, repo, getUserId));

    const response = await tools.get('list_habits')!({});
    const parsed = parseToolResponse<{ habits: Array<{ today: string; today_occurrences: Array<{ due_time: string; outcome: string }> }> }>(response);

    expect(parsed.habits[0].today).toBe('2026-07-02');
    expect(parsed.habits[0].today_occurrences).toEqual([
      { due_time: '08:00', outcome: 'done', note: null },
      { due_time: '20:00', outcome: 'open', note: null },
    ]);
  });

  it('shows no open occurrences for days the schedule does not cover, or for paused habits', async () => {
    const notToday = fakeHabit({
      id: 'h-weekend',
      timezone: 'UTC',
      schedule: { days: [0, 6], times: ['10:00'] }, // Sun/Sat only; today is Thursday
    });
    const paused = fakeHabit({ id: 'h-paused', status: 'paused' });
    const repo = makeHabitRepo({
      list: vi.fn(async () => [notToday, paused]),
      listLog: vi.fn(async () => []),
    });
    const tools = captureTools((s) => registerHabitTools(s, repo, getUserId));

    const response = await tools.get('list_habits')!({});
    const parsed = parseToolResponse<{ habits: Array<{ id: string; today_occurrences: unknown[] }> }>(response);

    expect(parsed.habits[0].today_occurrences).toEqual([]);
    expect(parsed.habits[1].today_occurrences).toEqual([]);
  });

  it('queries the log once for all habits (single date-span query, user-scoped)', async () => {
    const listLog = vi.fn(async () => []);
    const repo = makeHabitRepo({
      list: vi.fn(async () => [fakeHabit({ id: 'h-1' }), fakeHabit({ id: 'h-2' })]),
      listLog,
    });
    const tools = captureTools((s) => registerHabitTools(s, repo, getUserId));

    await tools.get('list_habits')!({});

    expect(listLog).toHaveBeenCalledTimes(1);
    expect(listLog.mock.calls[0][0]).toBe(USER_ID);
    expect(listLog.mock.calls[0][1]).toEqual({ fromDate: '2026-07-02', toDate: '2026-07-02' });
  });
});

describe('habit_trends tool handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-02T09:30:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('computes per-habit trends over the default 4 weeks from one log query', async () => {
    const habit = fakeHabit({ id: 'h-1', name: 'Training', timezone: 'UTC' });
    const listLog = vi.fn(async () => [
      fakeLogEntry({ habitId: 'h-1', dueDate: '2026-07-01', dueTime: '18:00', outcome: 'done' }),
      fakeLogEntry({ habitId: 'h-1', dueDate: '2026-06-30', dueTime: '18:00', outcome: 'skipped_deliberate', note: 'skip km' }),
    ]);
    const repo = makeHabitRepo({ list: vi.fn(async () => [habit]), listLog });
    const tools = captureTools((s) => registerHabitTools(s, repo, getUserId));

    const response = await tools.get('habit_trends')!({});
    const parsed = parseToolResponse<{ trends: Array<{ habitId: string; weekly: Array<{ completionRate: number | null }>; currentStreakDays: number; recentMisses: Array<{ note: string | null }> }>; weeks: number }>(response);

    expect(parsed.weeks).toBe(4);
    expect(listLog).toHaveBeenCalledTimes(1);
    expect(listLog.mock.calls[0][1]).toEqual({ fromDate: '2026-06-04' }); // 28 days back
    expect(parsed.trends).toHaveLength(1);
    expect(parsed.trends[0].habitId).toBe('h-1');
    expect(parsed.trends[0].weekly).toHaveLength(4);
    expect(parsed.trends[0].weekly[3].completionRate).toBe(0.5); // current week: 1 done / (1+1)
    expect(parsed.trends[0].currentStreakDays).toBe(1); // Jul 1 done, Jun 30 skip breaks
    expect(parsed.trends[0].recentMisses[0].note).toBe('skip km');
  });

  it('scopes to one habit when habit_id is given and errors when missing', async () => {
    const habit = fakeHabit({ id: 'h-1', timezone: 'UTC' });
    const listLog = vi.fn(async () => []);
    const findById = vi.fn(async (_u: string, id: string) => (id === 'h-1' ? habit : null));
    const repo = makeHabitRepo({ findById: findById as never, listLog });
    const tools = captureTools((s) => registerHabitTools(s, repo, getUserId));

    const ok = await tools.get('habit_trends')!({ habit_id: 'h-1', weeks: 2 });
    expect(ok.isError).toBeUndefined();
    expect(findById).toHaveBeenCalledWith(USER_ID, 'h-1');
    expect(listLog.mock.calls[0][1]).toEqual({ fromDate: '2026-06-18', habitId: 'h-1' });

    const missing = await tools.get('habit_trends')!({ habit_id: 'h-nope' });
    expect(missing.isError).toBe(true);
  });
});

describe('localNow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-02T22:30:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('resolves date, time, and day-of-week in the given timezone', () => {
    const utc = localNow('UTC');
    expect(utc).toEqual({ date: '2026-07-02', time: '22:30', dayOfWeek: 4 });

    const jlm = localNow('Asia/Jerusalem'); // UTC+3 in July -> already Friday
    expect(jlm).toEqual({ date: '2026-07-03', time: '01:30', dayOfWeek: 5 });
  });
});
