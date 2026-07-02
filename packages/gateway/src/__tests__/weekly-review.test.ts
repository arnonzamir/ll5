import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';

const insertSystemMessage = vi.fn(async () => 'msg-id');
vi.mock('../utils/system-message.js', () => ({
  insertSystemMessage: (...a: unknown[]) => insertSystemMessage(...a),
  createSchedulerEvent: (n: string) => ({ scheduler: n }),
}));
vi.mock('../utils/timezone.js', () => ({
  getEffectiveTimezone: async () => 'Asia/Jerusalem',
}));

import { WeeklyReviewReminder } from '../scheduler/weekly-review.js';

// 2026-06-26T11:30:00Z = 14:30 Asia/Jerusalem (UTC+3 summer), a Friday (dow 5).
const NOW = '2026-06-26T11:30:00Z';

function esWith(pendingFallbacks = 0): Client {
  return {
    search: vi.fn(async () => ({
      hits: { hits: Array.from({ length: pendingFallbacks }, (_, i) => ({ _id: `w${i}`, _source: {} })) },
    })),
    index: vi.fn(async () => ({ _id: 'new-wake' })),
  } as unknown as Client;
}

const pool = {} as Pool;
const mk = (es: Client, reviewDay = 5, reviewHour = 14) =>
  new WeeklyReviewReminder(pool, es, { reviewDay, reviewHour, timezone: 'Asia/Jerusalem', userId: 'u1' });
const tick = (s: WeeklyReviewReminder) => (s as unknown as { tick: () => Promise<void> }).tick();
const lastContent = () => String(insertSystemMessage.mock.calls.at(-1)?.[2] ?? '');
const indexOf = (es: Client) => (es as unknown as { index: ReturnType<typeof vi.fn> }).index;

describe('WeeklyReviewReminder — session opening + solo fallback', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(NOW)); insertSystemMessage.mockClear(); });
  afterEach(() => { vi.useRealTimers(); });

  it('fires on the review day/hour and opens with the first concrete question (never options)', async () => {
    await tick(mk(esWith()));
    expect(insertSystemMessage).toHaveBeenCalledTimes(1);
    const text = lastContent();
    expect(text).toContain('[Weekly Review]');
    expect(text).toContain('OPEN BY ASKING THE FIRST CONCRETE QUESTION');
    expect(text).toMatch(/NEVER open with "want to do the review\?"/);
    // The 5 phases survive the rewrite.
    expect(text).toContain('Inbox → zero');
    expect(text).toContain('Horizons');
  });

  it('tells the agent to book the visible calendar block itself (gateway has no tickler write path)', async () => {
    await tick(mk(esWith()));
    const text = lastContent();
    expect(text).toContain('create_tickler');
    expect(text).toMatch(/30-45 min calendar block/);
  });

  it('books a durable +45 min solo-fallback wake in ll5_scheduled_wakes', async () => {
    const es = esWith();
    await tick(mk(es));
    expect(indexOf(es)).toHaveBeenCalledTimes(1);
    const call = indexOf(es).mock.calls[0][0] as { index: string; document: Record<string, unknown> };
    expect(call.index).toBe('ll5_scheduled_wakes');
    const doc = call.document;
    expect(doc.user_id).toBe('u1');
    expect(doc.kind).toBe('instruction');
    expect(doc.recurrence).toBe('none');
    expect(doc.status).toBe('pending');
    expect(doc.source).toBe('weekly-review-fallback');
    expect(doc.fire_at).toBe(new Date(new Date(NOW).getTime() + 45 * 60_000).toISOString());
    const payload = String(doc.payload);
    expect(payload.startsWith('[Weekly Review — Solo Fallback]')).toBe(true);
    // The fallback carries the full solo one-pager contract.
    expect(payload).toContain('run the weekly review SOLO');
    expect(payload).toContain('30+ days');
    expect(payload).toContain('someday');
    expect(payload).toContain('shopping list');
    expect(payload).toContain('suggestible pool');
    expect(payload).toContain('at most 3 decisions');
  });

  it('does not double-book the fallback when one is already pending', async () => {
    const es = esWith(1);
    await tick(mk(es));
    expect(insertSystemMessage).toHaveBeenCalledTimes(1);
    expect(indexOf(es)).not.toHaveBeenCalled();
  });

  it('fires only once per week', async () => {
    const es = esWith();
    const s = mk(es);
    await tick(s);
    await tick(s);
    expect(insertSystemMessage).toHaveBeenCalledTimes(1);
    expect(indexOf(es)).toHaveBeenCalledTimes(1);
  });

  it('does not fire on the wrong day or hour', async () => {
    const es = esWith();
    await tick(mk(es, 4, 14)); // Thursday
    await tick(mk(es, 5, 9));  // Friday 09:00
    expect(insertSystemMessage).not.toHaveBeenCalled();
    expect(indexOf(es)).not.toHaveBeenCalled();
  });
});
