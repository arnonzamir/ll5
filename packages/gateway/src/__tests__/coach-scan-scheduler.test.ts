import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';

// insertSystemMessage is the side-effect we assert on.
const { insertSystemMessage } = vi.hoisted(() => ({
  insertSystemMessage: vi.fn(async () => 'msg-id'),
}));
vi.mock('../utils/system-message.js', () => ({
  insertSystemMessage,
  createSchedulerEvent: (name: string) => ({ scheduler: name, event_id: 'evt_test', fired_at: 'now' }),
}));

// Effective tz is forced to UTC so the local day/hour equal the (mocked) UTC clock.
vi.mock('../utils/timezone.js', () => ({
  getEffectiveTimezone: vi.fn(async () => 'UTC'),
}));

// withSchedulerHealth just wraps the tick body; run it directly.
vi.mock('../utils/scheduler-health.js', () => ({
  withSchedulerHealth: (_name: string, fn: () => Promise<void>) => fn(),
}));

import { CoachScanScheduler } from '../scheduler/coach-scan.js';

const USER = 'coach-user';
const pool = {} as Pool;

// Default config: Sunday (0) at 08:00.
function makeScheduler() {
  return new CoachScanScheduler(pool, { scanDay: 0, scanHour: 8, timezone: 'UTC', userId: USER });
}

async function runTick(s: CoachScanScheduler) {
  await (s as unknown as { tick: () => Promise<void> }).tick();
}

// A known Sunday 08:30 UTC (2026-06-21 is a Sunday) and other reference instants.
const SUNDAY_0830 = new Date('2026-06-21T08:30:00Z'); // day=0 (Sun), hour=8
const SUNDAY_0930 = new Date('2026-06-21T09:30:00Z'); // day=0 (Sun), hour=9
const MONDAY_0830 = new Date('2026-06-22T08:30:00Z'); // day=1 (Mon), hour=8
const NEXT_SUNDAY_0830 = new Date('2026-06-28T08:30:00Z'); // next ISO week, Sun, hour=8

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('CoachScanScheduler', () => {
  it('fires on the configured day + hour (Sunday 08:00)', async () => {
    vi.setSystemTime(SUNDAY_0830);
    const s = makeScheduler();
    await runTick(s);
    expect(insertSystemMessage).toHaveBeenCalledTimes(1);
    const body = insertSystemMessage.mock.calls[0][2] as string;
    expect(body).toContain('[Coach Scan]');
    expect(body).toContain('coach-scan skill');
  });

  it('does NOT fire on the right day but the wrong hour', async () => {
    vi.setSystemTime(SUNDAY_0930); // hour 9, configured 8
    const s = makeScheduler();
    await runTick(s);
    expect(insertSystemMessage).not.toHaveBeenCalled();
  });

  it('does NOT fire on the right hour but the wrong day', async () => {
    vi.setSystemTime(MONDAY_0830); // Monday, configured Sunday
    const s = makeScheduler();
    await runTick(s);
    expect(insertSystemMessage).not.toHaveBeenCalled();
  });

  it('fires only once per week (dedup within the same week)', async () => {
    const s = makeScheduler();
    vi.setSystemTime(SUNDAY_0830);
    await runTick(s); // fires
    await runTick(s); // same day+hour+week → deduped
    expect(insertSystemMessage).toHaveBeenCalledTimes(1);
  });

  it('fires again the following week', async () => {
    const s = makeScheduler();
    vi.setSystemTime(SUNDAY_0830);
    await runTick(s); // week N
    expect(insertSystemMessage).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NEXT_SUNDAY_0830);
    await runTick(s); // week N+1 → fires again
    expect(insertSystemMessage).toHaveBeenCalledTimes(2);
  });
});
