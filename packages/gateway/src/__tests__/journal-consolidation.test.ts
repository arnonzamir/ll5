import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';

const insertSystemMessage = vi.fn(async () => {});
const createSchedulerEvent = vi.fn(() => ({ kind: 'journal_consolidation' }));
vi.mock('../utils/system-message.js', () => ({
  insertSystemMessage: (...a: unknown[]) => insertSystemMessage(...a),
  createSchedulerEvent: (...a: unknown[]) => createSchedulerEvent(...a),
}));

import { JournalConsolidationScheduler } from '../scheduler/journal-consolidation.js';

const pool = {} as Pool;
const tick = (m: JournalConsolidationScheduler) => (m as unknown as { tick: () => Promise<void> }).tick();
const msg = () => String(insertSystemMessage.mock.calls[0][2]);

describe('JournalConsolidationScheduler — nightly nudge', () => {
  beforeEach(() => {
    insertSystemMessage.mockClear();
    vi.useFakeTimers();
    // 02:30 UTC → hour 2 in the UTC-configured scheduler
    vi.setSystemTime(new Date('2026-07-01T02:30:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('fires at the consolidation hour and points at the skill FILE, not a slash-command', async () => {
    const m = new JournalConsolidationScheduler(pool, { consolidationHour: 2, timezone: 'UTC', userId: 'u1' });
    await tick(m);
    expect(insertSystemMessage).toHaveBeenCalledTimes(1);
    const text = msg();
    // The regression that skipped consolidation: "Run /consolidate" tried as a Skill → "Unknown skill".
    expect(text).not.toMatch(/run \/consolidate/i);
    expect(text).toContain('.claude/skills/consolidate.md');
    // Anti-skip hardening must be present.
    expect(text).toMatch(/never skip|MUST complete|inline/i);
    // The post-steps are preserved.
    expect(text).toContain('read_user_model()');
    expect(text).toContain('push_to_user');
  });

  it('does not fire outside the consolidation hour', async () => {
    const m = new JournalConsolidationScheduler(pool, { consolidationHour: 5, timezone: 'UTC', userId: 'u1' });
    await tick(m);
    expect(insertSystemMessage).not.toHaveBeenCalled();
  });

  it('fires once per day (dedupes on the same date)', async () => {
    const m = new JournalConsolidationScheduler(pool, { consolidationHour: 2, timezone: 'UTC', userId: 'u1' });
    await tick(m);
    await tick(m);
    expect(insertSystemMessage).toHaveBeenCalledTimes(1);
  });
});
