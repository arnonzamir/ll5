import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';

const insertSystemMessage = vi.fn(async () => 'msg-id');
vi.mock('../utils/system-message.js', () => ({
  insertSystemMessage: (...a: unknown[]) => insertSystemMessage(...a),
  createSchedulerEvent: (n: string) => ({ scheduler: n }),
}));
vi.mock('../utils/scheduler-health.js', () => ({
  withSchedulerHealth: (_n: string, fn: () => Promise<void>) => fn(),
}));
vi.mock('../utils/timezone.js', () => ({
  getEffectiveTimezone: async () => 'Asia/Jerusalem',
  // Local midnight of 2026-06-28 in Asia/Jerusalem (UTC+3 summer).
  startOfDayInTz: () => new Date('2026-06-27T21:00:00Z'),
}));

import { HabitScheduler } from '../scheduler/habit-scheduler.js';

// 2026-06-28T06:12:00Z = 09:12 Asia/Jerusalem, a Sunday (dow 0).
const NOW = '2026-06-28T06:12:00Z';

interface HabitDef {
  id?: string; name?: string; description?: string | null;
  schedule?: { days?: 'daily' | number[]; times?: string[] };
  check_kind?: string; check_config?: Record<string, unknown> | null;
  escalation?: Array<{ offset_minutes: number; level: string }>;
  timezone?: string | null;
}
interface LogDef { due_time: string; outcome: string | null; steps_fired: number[] }

const RITALIN: HabitDef = {
  id: 'h1', name: 'Ritalin AM', description: null,
  schedule: { days: 'daily', times: ['09:00'] },
  check_kind: 'gtd_action', check_config: { action_title: 'Ritalin AM dose' },
  escalation: [
    { offset_minutes: 0, level: 'silent' },
    { offset_minutes: 10, level: 'notify' },
    { offset_minutes: 30, level: 'alert' },
  ],
  timezone: null,
};

function poolWith(opts: {
  habits?: HabitDef[] | 'missing-table';
  logs?: LogDef[];
} = {}): Pool {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('UPDATE gtd_habit_log')) return { rows: [], rowCount: 0 };
    if (sql.includes('FROM gtd_habits')) {
      if (opts.habits === 'missing-table') {
        const err = new Error('relation "gtd_habits" does not exist') as Error & { code: string };
        err.code = '42P01';
        throw err;
      }
      return { rows: (opts.habits ?? []).map((h) => ({ ...RITALIN, ...h })) };
    }
    if (sql.includes('SELECT due_time, outcome, steps_fired')) return { rows: opts.logs ?? [] };
    if (sql.startsWith('INSERT INTO gtd_habit_log')) return { rows: [], rowCount: 1 };
    return { rows: [] };
  });
  return { query } as unknown as Pool;
}

const mk = (pool: Pool, enabled = true) =>
  new HabitScheduler(pool, { enabled, timezone: 'Asia/Jerusalem', userId: 'u1' });
const tick = (s: HabitScheduler) => (s as unknown as { tick: () => Promise<void> }).tick();
const queryOf = (pool: Pool) => (pool as unknown as { query: ReturnType<typeof vi.fn> }).query;
const contents = () => insertSystemMessage.mock.calls.map((c) => String(c[2]));
const upsertCalls = (pool: Pool) => queryOf(pool).mock.calls.filter((c) => String(c[0]).startsWith('INSERT INTO gtd_habit_log'));
const sweepCalls = (pool: Pool) => queryOf(pool).mock.calls.filter((c) => String(c[0]).includes('UPDATE gtd_habit_log'));

describe('HabitScheduler', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(NOW)); insertSystemMessage.mockClear(); });
  afterEach(() => { vi.useRealTimers(); });

  it('fires each due escalation step at its offset with a [Habit Check] instruction', async () => {
    // 09:12: step 1 (09:00) and step 2 (09:10) are due; step 3 (09:30) is not.
    const pool = poolWith({ habits: [RITALIN] });
    await tick(mk(pool));
    expect(insertSystemMessage).toHaveBeenCalledTimes(2);
    const [first, second] = contents();
    expect(first).toContain('[Habit Check] Ritalin AM');
    expect(first).toContain('step 1/3');
    expect(first).toContain('level: silent');
    expect(first).toContain('gtd_action');
    expect(first).toContain('Ritalin AM dose');
    expect(first).toContain('Check idempotently: if already done, log_habit_outcome done and stay silent; otherwise act at this step\'s level; log the outcome when known.');
    expect(second).toContain('step 2/3');
    expect(second).toContain('level: notify');
    // Both steps were recorded in steps_fired via the upsert.
    const upserts = upsertCalls(pool);
    expect(upserts).toHaveLength(2);
    expect(upserts[0][1]).toEqual(expect.arrayContaining(['h1', 'u1', '2026-06-28', '09:00', 0]));
    expect(upserts[1][1]).toEqual(expect.arrayContaining([1]));
  });

  it('is idempotent: never re-fires a step already in steps_fired', async () => {
    const pool = poolWith({ habits: [RITALIN], logs: [{ due_time: '09:00', outcome: null, steps_fired: [0] }] });
    await tick(mk(pool));
    expect(insertSystemMessage).toHaveBeenCalledTimes(1); // only step 2
    expect(contents()[0]).toContain('step 2/3');
  });

  it('a logged outcome closes the occurrence and silences later steps', async () => {
    const pool = poolWith({ habits: [RITALIN], logs: [{ due_time: '09:00', outcome: 'done', steps_fired: [0] }] });
    await tick(mk(pool));
    expect(insertSystemMessage).not.toHaveBeenCalled();
    expect(upsertCalls(pool)).toHaveLength(0);
  });

  it('respects day-of-week scheduling (no fire on a non-scheduled day)', async () => {
    // NOW is a Sunday (dow 0); habit only runs Mondays.
    const pool = poolWith({ habits: [{ ...RITALIN, schedule: { days: [1], times: ['09:00'] } }] });
    await tick(mk(pool));
    expect(insertSystemMessage).not.toHaveBeenCalled();
  });

  it('never fires stale steps beyond the catch-up cap', async () => {
    // Occurrence at 07:00 → step offsets 0/10/30 are all >90 min past at 09:12.
    const pool = poolWith({ habits: [{ ...RITALIN, schedule: { days: 'daily', times: ['07:00'] } }] });
    await tick(mk(pool));
    expect(insertSystemMessage).not.toHaveBeenCalled();
  });

  it('sweeps yesterday\'s open occurrences to missed on the first tick of a new day, once', async () => {
    const pool = poolWith({ habits: [] });
    const s = mk(pool);
    await tick(s);
    await tick(s);
    const sweeps = sweepCalls(pool);
    expect(sweeps).toHaveLength(1);
    expect(String(sweeps[0][0])).toContain("outcome = 'missed'");
    expect(String(sweeps[0][0])).toContain('due_date < $2');
    expect(sweeps[0][1]).toEqual(['u1', '2026-06-28']);
  });

  it('does not start when disabled via the knob', async () => {
    const pool = poolWith({ habits: [RITALIN] });
    const s = mk(pool, false);
    s.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(insertSystemMessage).not.toHaveBeenCalled();
    expect(queryOf(pool)).not.toHaveBeenCalled();
    s.stop();
  });

  it('survives the habit tables not existing yet (pre-migration deploy)', async () => {
    const pool = poolWith({ habits: 'missing-table' });
    await expect(tick(mk(pool))).resolves.toBeUndefined();
    expect(insertSystemMessage).not.toHaveBeenCalled();
  });

  it('uses the habit\'s own timezone when set', async () => {
    // 06:12Z is 09:12 in Asia/Jerusalem but 08:12 in Europe/Berlin (UTC+2) —
    // a 09:00 Berlin occurrence is not due yet.
    const pool = poolWith({ habits: [{ ...RITALIN, timezone: 'Europe/Berlin' }] });
    await tick(mk(pool));
    expect(insertSystemMessage).not.toHaveBeenCalled();
  });
});
