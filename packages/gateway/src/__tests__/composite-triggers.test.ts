import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import type { Client } from '@elastic/elasticsearch';
import type { GoogleCalendarClient } from '../scheduler/google-calendar-client.js';

const { insertSystemMessage } = vi.hoisted(() => ({
  insertSystemMessage: vi.fn(async () => 'msg-id'),
}));
vi.mock('../utils/system-message.js', () => ({
  insertSystemMessage,
  createSchedulerEvent: (name: string) => ({ scheduler: name, event_id: 'evt_test', fired_at: 'now' }),
}));
vi.mock('../utils/timezone.js', () => ({
  getEffectiveTimezone: vi.fn(async () => 'UTC'),
}));
vi.mock('../utils/scheduler-health.js', () => ({
  withSchedulerHealth: (_name: string, fn: () => Promise<void>) => fn(),
}));

import { ArrivalCompositeEvaluator } from '../utils/composite-triggers.js';
import { CompositeTriggerScheduler } from '../scheduler/composite-triggers.js';

const USER = 'composite-user';
const HOUR_MS = 60 * 60 * 1000;

async function runTick(s: CompositeTriggerScheduler) {
  await (s as unknown as { tick: () => Promise<void> }).tick();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  // Fixed instant: a high-energy morning hour (10:00 UTC) so the free-block
  // energy gate passes by default.
  vi.setSystemTime(new Date('2026-06-21T10:00:00Z'));
});
afterEach(() => vi.useRealTimers());

// ---------------------------------------------------------------------------
// Composite #1 — Arrived + items here (event-driven, via the evaluator)
// ---------------------------------------------------------------------------
describe('ArrivalCompositeEvaluator — arrived + items here', () => {
  /** pool whose gtd_horizons context-match returns `actions` and inbox returns `inbox`. */
  function makePool(actions: number, inbox: number): Pool {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('gtd_horizons')) return { rows: [{ count: String(actions) }] };
      if (sql.includes('gtd_inbox')) return { rows: [{ count: String(inbox) }] };
      return { rows: [] };
    });
    return { query } as unknown as Pool;
  }

  it('fires [Situation] when there are context-matched actions for the place', async () => {
    const ev = new ArrivalCompositeEvaluator(makePool(2, 3));
    const fired = await ev.onArrival(USER, 'Office');
    expect(fired).toBe(true);
    expect(insertSystemMessage).toHaveBeenCalledTimes(1);
    const body = insertSystemMessage.mock.calls[0][2] as string;
    expect(body).toContain('[Situation] Arrived at Office');
    expect(body).toContain('2 items here');
    expect(body).toContain('@office');
    expect(body).toContain('3 in inbox');
  });

  it('does NOT fire when there are no context-matched actions (avoids doubling the location wake)', async () => {
    const ev = new ArrivalCompositeEvaluator(makePool(0, 5));
    const fired = await ev.onArrival(USER, 'Office');
    expect(fired).toBe(false);
    expect(insertSystemMessage).not.toHaveBeenCalled();
  });

  it('dedups: does not re-fire for the same place on the same day', async () => {
    const ev = new ArrivalCompositeEvaluator(makePool(2, 0));
    expect(await ev.onArrival(USER, 'Office')).toBe(true);
    expect(await ev.onArrival(USER, 'Office')).toBe(false); // deduped
    expect(insertSystemMessage).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Composite #2 — Free block opened
// ---------------------------------------------------------------------------
describe('CompositeTriggerScheduler — free block opened', () => {
  function makeConfig() {
    return { intervalMinutes: 3, startHour: 0, endHour: 24, timezone: 'UTC', userId: USER };
  }
  // pool with no escalations / no important contacts (so R1 stays quiet).
  function quietPool(): Pool {
    const query = vi.fn(async () => ({ rows: [] }));
    return { query } as unknown as Pool;
  }
  const emptyEs = { search: vi.fn(async () => ({ hits: { hits: [] } })) } as unknown as Client;

  /** google client whose next event starts `minsAhead` minutes from now. */
  function makeGoogle(minsAhead: number | null): GoogleCalendarClient {
    return {
      getEvents: vi.fn(async () => {
        if (minsAhead == null) return [];
        return [{
          event_id: 'ev-next',
          title: 'Standup',
          start: new Date(Date.now() + minsAhead * 60_000).toISOString(),
          end: new Date(Date.now() + (minsAhead + 30) * 60_000).toISOString(),
          all_day: false,
          location: null,
        }];
      }),
    } as unknown as GoogleCalendarClient;
  }

  it('fires when there is a >=45min gap before the next event (medium/high energy hour)', async () => {
    const s = new CompositeTriggerScheduler(quietPool(), emptyEs, makeGoogle(90), makeConfig());
    await runTick(s);
    const calls = insertSystemMessage.mock.calls.filter((c) => (c[2] as string).includes('Free block'));
    expect(calls.length).toBe(1);
    expect(calls[0][2] as string).toContain('until Standup');
  });

  it('does NOT fire when the gap is shorter than 45min', async () => {
    const s = new CompositeTriggerScheduler(quietPool(), emptyEs, makeGoogle(20), makeConfig());
    await runTick(s);
    const calls = insertSystemMessage.mock.calls.filter((c) => (c[2] as string).includes('Free block'));
    expect(calls.length).toBe(0);
  });

  it('does NOT fire in a low-energy hour even with a big gap', async () => {
    vi.setSystemTime(new Date('2026-06-21T22:00:00Z')); // hour 22 → low energy
    const s = new CompositeTriggerScheduler(quietPool(), emptyEs, makeGoogle(120), makeConfig());
    await runTick(s);
    const calls = insertSystemMessage.mock.calls.filter((c) => (c[2] as string).includes('Free block'));
    expect(calls.length).toBe(0);
  });

  it('dedups per next-event: re-ticking the same gap does not re-fire', async () => {
    const s = new CompositeTriggerScheduler(quietPool(), emptyEs, makeGoogle(90), makeConfig());
    await runTick(s);
    // advance past the interval gate so the second tick actually evaluates.
    vi.setSystemTime(new Date(Date.now() + 5 * 60_000));
    await runTick(s);
    const calls = insertSystemMessage.mock.calls.filter((c) => (c[2] as string).includes('Free block'));
    expect(calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Composite #3 — Important contact unanswered > 2h
// ---------------------------------------------------------------------------
describe('CompositeTriggerScheduler — important contact unanswered >2h', () => {
  function makeConfig() {
    return { intervalMinutes: 3, startHour: 0, endHour: 24, timezone: 'UTC', userId: USER };
  }
  // google client with no events → free-block stays quiet.
  const noEvents = { getEvents: vi.fn(async () => []) } as unknown as GoogleCalendarClient;

  /** pool that reports CONV as an escalated (important) conversation. */
  function importantPool(convId: string): Pool {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('active_escalations')) {
        return { rows: [{ esc: [{ id: 'e1', platform: 'whatsapp', conversation_id: convId, conversation_name: 'Boss', original_priority: 'batch', started_at: 'x', expires_at: '2999-01-01T00:00:00Z' }] }] };
      }
      if (sql.includes('contact_settings')) return { rows: [] };
      return { rows: [] };
    });
    return { query } as unknown as Pool;
  }

  /** ES returning one inbound from `convId`, `inboundMsAgo` ago, with no outbound after. */
  function makeEs(convId: string, inboundMsAgo: number, withOutboundAfter = false): Client {
    const hits: Array<{ _id: string; _source: Record<string, unknown> }> = [
      { _id: 'm1', _source: { conversation_id: convId, conversation_name: 'Boss', from_me: false, content: 'you around?', timestamp: new Date(Date.now() - inboundMsAgo).toISOString() } },
    ];
    if (withOutboundAfter) {
      hits.push({ _id: 'm2', _source: { conversation_id: convId, conversation_name: 'Boss', from_me: true, content: 'yes!', timestamp: new Date(Date.now() - inboundMsAgo + 60_000).toISOString() } });
    }
    return { search: vi.fn(async () => ({ hits: { hits } })) } as unknown as Client;
  }

  it('fires when an important contact has been unanswered for >2h', async () => {
    const conv = 'boss@s.whatsapp.net';
    const s = new CompositeTriggerScheduler(importantPool(conv), makeEs(conv, 3 * HOUR_MS), noEvents, makeConfig());
    await runTick(s);
    const calls = insertSystemMessage.mock.calls.filter((c) => (c[2] as string).includes('unanswered'));
    expect(calls.length).toBe(1);
    expect(calls[0][2] as string).toContain('Boss unanswered for 3h');
  });

  it('does NOT fire when the inbound is < 2h old', async () => {
    const conv = 'boss@s.whatsapp.net';
    const s = new CompositeTriggerScheduler(importantPool(conv), makeEs(conv, 1 * HOUR_MS), noEvents, makeConfig());
    await runTick(s);
    const calls = insertSystemMessage.mock.calls.filter((c) => (c[2] as string).includes('unanswered'));
    expect(calls.length).toBe(0);
  });

  it('does NOT fire when the user already replied after the inbound', async () => {
    const conv = 'boss@s.whatsapp.net';
    const s = new CompositeTriggerScheduler(importantPool(conv), makeEs(conv, 3 * HOUR_MS, true), noEvents, makeConfig());
    await runTick(s);
    const calls = insertSystemMessage.mock.calls.filter((c) => (c[2] as string).includes('unanswered'));
    expect(calls.length).toBe(0);
  });

  it('does NOT fire for a non-important conversation', async () => {
    const conv = 'boss@s.whatsapp.net';
    // important pool tracks a DIFFERENT conversation id → conv is not important.
    const s = new CompositeTriggerScheduler(importantPool('someone-else'), makeEs(conv, 3 * HOUR_MS), noEvents, makeConfig());
    await runTick(s);
    const calls = insertSystemMessage.mock.calls.filter((c) => (c[2] as string).includes('unanswered'));
    expect(calls.length).toBe(0);
  });

  it('dedups per conversation/day: re-ticking does not re-fire', async () => {
    const conv = 'boss@s.whatsapp.net';
    const s = new CompositeTriggerScheduler(importantPool(conv), makeEs(conv, 3 * HOUR_MS), noEvents, makeConfig());
    await runTick(s);
    vi.setSystemTime(new Date(Date.now() + 5 * 60_000)); // past interval gate
    await runTick(s);
    const calls = insertSystemMessage.mock.calls.filter((c) => (c[2] as string).includes('unanswered'));
    expect(calls.length).toBe(1);
  });
});
