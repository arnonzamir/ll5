import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Client } from '@elastic/elasticsearch';
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

import { EveningCloseScheduler } from '../scheduler/evening-close.js';

// 2026-06-28T17:35:00Z = 20:35 Asia/Jerusalem — inside the 20:30+60min window.
const IN_WINDOW = '2026-06-28T17:35:00Z';

interface StagedRow { content: string; created_at: string; level: string | null }
interface HabitRow { name: string; due_time: string; outcome: string | null }

function poolWith(opts: {
  alreadySent?: number;
  staged?: StagedRow[];
  habits?: HabitRow[] | 'missing-table';
} = {}): Pool {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('COUNT(*)')) return { rows: [{ count: String(opts.alreadySent ?? 0) }] };
    if (sql.includes("m.role = 'assistant'")) return { rows: opts.staged ?? [] };
    if (sql.includes('gtd_habit_log')) {
      if (opts.habits === 'missing-table') {
        const err = new Error('relation "gtd_habit_log" does not exist') as Error & { code: string };
        err.code = '42P01';
        throw err;
      }
      return { rows: opts.habits ?? [] };
    }
    return { rows: [] };
  });
  return { query } as unknown as Pool;
}

function esWithJournal(entries: Array<{ topic?: string; content?: string }>): Client {
  return {
    search: vi.fn(async () => ({ hits: { hits: entries.map((e, i) => ({ _id: `j${i}`, _source: e })) } })),
  } as unknown as Client;
}

const mk = (pool: Pool, es: Client, enabled = true) =>
  new EveningCloseScheduler(pool, es, { enabled, closeHour: 20, closeMinute: 30, timezone: 'Asia/Jerusalem', userId: 'u1' });
const tick = (s: EveningCloseScheduler) => (s as unknown as { tick: () => Promise<void> }).tick();
const lastContent = () => String(insertSystemMessage.mock.calls.at(-1)?.[2] ?? '');

describe('EveningCloseScheduler', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(IN_WINDOW)); insertSystemMessage.mockClear(); });
  afterEach(() => { vi.useRealTimers(); });

  it('fires in the window with the [Evening Close] label and the skill contract', async () => {
    await tick(mk(poolWith(), esWithJournal([])));
    expect(insertSystemMessage).toHaveBeenCalledTimes(1);
    const text = lastContent();
    expect(text).toContain('[Evening Close]');
    expect(text).toContain('Run your evening-close skill: ONE message at notify level — max 3 loose ends, tomorrow\'s ONE thing, today\'s habit outcomes, and an explicit pick-up/drop call on each staged item below. A silent staging is a deferral, not a delivery. If the skill is unavailable, do the close inline from this instruction — never skip.');
  });

  it('embeds the collection: staged messages, open journal entries, habit outcomes', async () => {
    const pool = poolWith({
      staged: [{ content: 'Free block at 15:00 — want me to line up the Hen prep?', created_at: '2026-06-28T11:03:00Z', level: 'silent' }],
      habits: [{ name: 'Ritalin AM', due_time: '09:00', outcome: 'done' }, { name: 'Training', due_time: '17:00', outcome: null }],
    });
    const es = esWithJournal([{ topic: 'sitter thread', content: 'proposal staged, awaiting pickup' }]);
    await tick(mk(pool, es));
    const text = lastContent();
    expect(text).toContain('Free block at 15:00');
    expect(text).toContain('silent');
    expect(text).toContain('sitter thread');
    expect(text).toContain('Ritalin AM @ 09:00 — done');
    expect(text).toContain('Training @ 17:00 — OPEN (no outcome logged yet)');
    expect(text).toContain('4 items');
  });

  it('caps the collection at 10 items and notes the overflow count', async () => {
    const staged = Array.from({ length: 13 }, (_, i) => ({
      content: `staged proposal number ${i}`, created_at: '2026-06-28T11:00:00Z', level: null,
    }));
    await tick(mk(poolWith({ staged }), esWithJournal([])));
    const text = lastContent();
    expect(text).toContain('(+3 more item');
    expect(text).toContain('staged proposal number 9');
    expect(text).not.toContain('staged proposal number 10');
  });

  it('does not fire before the window opens', async () => {
    vi.setSystemTime(new Date('2026-06-28T16:00:00Z')); // 19:00 local
    await tick(mk(poolWith(), esWithJournal([])));
    expect(insertSystemMessage).not.toHaveBeenCalled();
  });

  it('does not fire once the catch-up window has passed (no stale close at night)', async () => {
    vi.setSystemTime(new Date('2026-06-28T18:45:00Z')); // 21:45 local, 75 min past
    await tick(mk(poolWith(), esWithJournal([])));
    expect(insertSystemMessage).not.toHaveBeenCalled();
  });

  it('fires once per day (in-memory dedup on the local date)', async () => {
    const s = mk(poolWith(), esWithJournal([]));
    await tick(s);
    await tick(s);
    expect(insertSystemMessage).toHaveBeenCalledTimes(1);
  });

  it('does not double-fire after a restart (durable already-sent check)', async () => {
    // Fresh instance (restart) but an [Evening Close] row already landed today.
    await tick(mk(poolWith({ alreadySent: 1 }), esWithJournal([])));
    expect(insertSystemMessage).not.toHaveBeenCalled();
  });

  it('does not start when disabled via the knob', async () => {
    const pool = poolWith();
    const s = mk(pool, esWithJournal([]), false);
    s.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(insertSystemMessage).not.toHaveBeenCalled();
    expect((pool as unknown as { query: ReturnType<typeof vi.fn> }).query).not.toHaveBeenCalled();
    s.stop();
  });

  it('still fires when the habit tables are missing (pre-migration resilience)', async () => {
    const pool = poolWith({
      staged: [{ content: 'a staged thing', created_at: '2026-06-28T11:00:00Z', level: null }],
      habits: 'missing-table',
    });
    await tick(mk(pool, esWithJournal([])));
    expect(insertSystemMessage).toHaveBeenCalledTimes(1);
    expect(lastContent()).toContain('a staged thing');
  });

  it('still delivers the close instruction when the collection is empty', async () => {
    await tick(mk(poolWith(), esWithJournal([])));
    const text = lastContent();
    expect(text).toContain('collection is empty');
    expect(text).toContain('Still deliver the close');
  });
});
