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
}));

import { WakeScheduler } from '../scheduler/wake-scheduler.js';

// 2026-06-28T06:12:00Z = 09:12 Asia/Jerusalem (UTC+3 summer), a Sunday (dow 0).
const NOW = '2026-06-28T06:12:00Z';

interface W { id?: string; [k: string]: unknown }
function esWith(wakes: W[]): Client {
  return {
    search: vi.fn(async () => ({ hits: { hits: wakes.map((w, i) => ({ _id: w.id ?? `w${i}`, _source: w })) } })),
    update: vi.fn(async () => ({})),
  } as unknown as Client;
}
const pool = {} as Pool;
const mk = (es: Client) => new WakeScheduler(pool, es, { userId: 'u1', timezone: 'Asia/Jerusalem' });
const tick = (s: WakeScheduler) => (s as unknown as { tick: () => Promise<void> }).tick();
const lastContent = () => String(insertSystemMessage.mock.calls.at(-1)?.[2] ?? '');
const updateOf = (es: Client) => (es as unknown as { update: ReturnType<typeof vi.fn> }).update;

describe('WakeScheduler', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(NOW)); insertSystemMessage.mockClear(); });
  afterEach(() => { vi.useRealTimers(); });

  it('fires a due one-off and marks it fired', async () => {
    const es = esWith([{ id: 'a', recurrence: 'none', kind: 'instruction', payload: 'do X', status: 'pending', fire_at: '2026-06-28T06:00:00Z' }]);
    await tick(mk(es));
    expect(insertSystemMessage).toHaveBeenCalledTimes(1);
    expect(lastContent()).toContain('[Agent Instruction]');
    expect(lastContent()).toContain('do X');
    expect(updateOf(es)).toHaveBeenCalledWith(expect.objectContaining({ id: 'a', doc: expect.objectContaining({ status: 'fired' }) }));
  });

  it('does NOT fire a future one-off', async () => {
    const es = esWith([{ recurrence: 'none', payload: 'later', status: 'pending', fire_at: '2026-06-28T07:00:00Z' }]);
    await tick(mk(es));
    expect(insertSystemMessage).not.toHaveBeenCalled();
  });

  it('expires a one-off missed by > catch-up window without delivering', async () => {
    const es = esWith([{ id: 'old', recurrence: 'none', payload: 'stale', status: 'pending', fire_at: '2026-06-27T20:00:00Z' }]);
    await tick(mk(es));
    expect(insertSystemMessage).not.toHaveBeenCalled();
    expect(updateOf(es)).toHaveBeenCalledWith(expect.objectContaining({ id: 'old', doc: expect.objectContaining({ status: 'fired' }) }));
  });

  it('fires a daily recurring wake at/just-after its local time and stamps last_fired_date', async () => {
    const es = esWith([{ id: 'd', recurrence: 'daily', payload: 'check dose', status: 'pending', fire_local: '09:10', tz: 'Asia/Jerusalem' }]);
    await tick(mk(es));
    expect(insertSystemMessage).toHaveBeenCalledTimes(1);
    expect(updateOf(es)).toHaveBeenCalledWith(expect.objectContaining({ doc: expect.objectContaining({ last_fired_date: '2026-06-28' }) }));
  });

  it('does NOT re-fire a daily wake already fired today', async () => {
    const es = esWith([{ recurrence: 'daily', payload: 'x', status: 'pending', fire_local: '09:10', tz: 'Asia/Jerusalem', last_fired_date: '2026-06-28' }]);
    await tick(mk(es));
    expect(insertSystemMessage).not.toHaveBeenCalled();
  });

  it('does NOT fire a daily wake whose local time has not arrived', async () => {
    const es = esWith([{ recurrence: 'daily', payload: 'x', status: 'pending', fire_local: '09:30', tz: 'Asia/Jerusalem' }]);
    await tick(mk(es));
    expect(insertSystemMessage).not.toHaveBeenCalled();
  });

  it('does NOT fire a daily wake long past its time (stale, beyond catch-up)', async () => {
    const es = esWith([{ recurrence: 'daily', payload: 'x', status: 'pending', fire_local: '07:00', tz: 'Asia/Jerusalem' }]);
    await tick(mk(es));
    expect(insertSystemMessage).not.toHaveBeenCalled();
  });

  it('skips a weekdays wake on the weekend (Sunday)', async () => {
    const es = esWith([{ recurrence: 'weekdays', payload: 'x', status: 'pending', fire_local: '09:10', tz: 'Asia/Jerusalem' }]);
    await tick(mk(es));
    expect(insertSystemMessage).not.toHaveBeenCalled();
  });

  it('fires a weekly wake on its matching day', async () => {
    const es = esWith([{ recurrence: 'weekly', weekly_dow: 0, payload: 'sunday thing', status: 'pending', fire_local: '09:10', tz: 'Asia/Jerusalem' }]);
    await tick(mk(es));
    expect(insertSystemMessage).toHaveBeenCalledTimes(1);
  });

  it('delivers a reminder-kind wake as a user-facing [Reminder]', async () => {
    const es = esWith([{ recurrence: 'none', kind: 'reminder', payload: 'take meds', status: 'pending', fire_at: '2026-06-28T06:00:00Z' }]);
    await tick(mk(es));
    expect(lastContent()).toContain('[Reminder]');
    expect(lastContent()).toContain('take meds');
  });
});
