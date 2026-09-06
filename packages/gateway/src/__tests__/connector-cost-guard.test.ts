import { describe, it, expect, beforeEach } from 'vitest';
import { decide, noteBurstFlushed, newCostGuardState, ConnectorCostGuard, FANOUT_ALERT_PER_DAY } from '../connectors/cost-guard.js';
import { GroupCoalescer, type CoalescedItem } from '../utils/group-coalescer.js';
import { recordConnectorEvent, connectorEventAgeMinutes, getConnectorLastEventAt, resetConnectorLiveness } from '../connectors/liveness.js';

const H = 3_600_000;
const T0 = Date.UTC(2026, 8, 6, 12, 0, 0); // on the hour, mid-day UTC

describe('cost guard — pure decision', () => {
  it('first 3 hits in an hour are immediate, then coalesce, then digest_only after the burst flushed', () => {
    const s = newCostGuardState(T0);
    expect(decide(s, T0 + 1)).toBe('immediate');
    expect(decide(s, T0 + 2)).toBe('immediate');
    expect(decide(s, T0 + 3)).toBe('immediate');
    expect(decide(s, T0 + 4)).toBe('coalesce');
    expect(decide(s, T0 + 5)).toBe('coalesce');
    noteBurstFlushed(s, T0 + 6);
    expect(decide(s, T0 + 7)).toBe('digest_only');
    expect(decide(s, T0 + 8)).toBe('digest_only');
    expect(s.immediateToday).toBe(4); // 3 immediates + 1 burst
    expect(s.coalescedToday).toBe(2);
    expect(s.digestOnlyToday).toBe(2);
  });
  it('the hour counter resets on the next clock hour, the day counter does not', () => {
    const s = newCostGuardState(T0);
    for (let i = 0; i < 5; i++) decide(s, T0 + i);
    noteBurstFlushed(s, T0 + 10);
    expect(decide(s, T0 + 11)).toBe('digest_only');
    expect(decide(s, T0 + H)).toBe('immediate');
    expect(s.immediateThisHour).toBe(1);
    expect(s.immediateToday).toBe(5);
  });
  it('day counters reset on the next UTC day', () => {
    const s = newCostGuardState(T0);
    decide(s, T0);
    expect(s.immediateToday).toBe(1);
    decide(s, T0 + 24 * H);
    expect(s.immediateToday).toBe(1);
    expect(s.coalescedToday).toBe(0);
  });
  it('maxPerHour is configurable, including 0 (everything coalesces)', () => {
    const s = newCostGuardState(T0);
    expect(decide(s, T0, 1)).toBe('immediate');
    expect(decide(s, T0 + 1, 1)).toBe('coalesce');
    const z = newCostGuardState(T0);
    expect(decide(z, T0, 0)).toBe('coalesce');
  });
  it('20 hits in an hour → 3 immediate + 1 burst, the rest silent (the Phase 1 acceptance criterion)', () => {
    const s = newCostGuardState(T0);
    const out: string[] = [];
    for (let i = 0; i < 20; i++) {
      const d = decide(s, T0 + i * 60_000);
      out.push(d);
      if (d === 'coalesce' && out.filter((x) => x === 'coalesce').length === 12) noteBurstFlushed(s, T0 + i * 60_000); // window hit maxItems
    }
    expect(out.filter((x) => x === 'immediate')).toHaveLength(3);
    expect(out.filter((x) => x === 'coalesce')).toHaveLength(12);
    expect(out.filter((x) => x === 'digest_only')).toHaveLength(5);
    expect(s.immediateToday).toBe(4);
  });
});

describe('ConnectorCostGuard — per user:connector state', () => {
  it('keys are independent and stats expose the counters', () => {
    const g = new ConnectorCostGuard(1);
    expect(g.decide('u1', 'cal', T0)).toBe('immediate');
    expect(g.decide('u1', 'cal', T0)).toBe('coalesce');
    expect(g.decide('u1', 'max', T0)).toBe('immediate');
    expect(g.decide('u2', 'cal', T0)).toBe('immediate');
    expect(ConnectorCostGuard.key('u1', 'cal')).toBe('u1:connector:cal');
    const stats = g.stats().sort((a, b) => a.key.localeCompare(b.key));
    expect(stats.map((s) => [s.key, s.immediate_this_hour, s.coalesced_today])).toEqual([
      ['u1:connector:cal', 1, 1], ['u1:connector:max', 1, 0], ['u2:connector:cal', 1, 0],
    ]);
  });
  it('immediateToday crosses the fanout tripwire only through real immediates', () => {
    const g = new ConnectorCostGuard(100);
    for (let i = 0; i <= FANOUT_ALERT_PER_DAY; i++) g.decide('u', 'cal', T0 + i);
    expect(g.immediateToday('u', 'cal', T0 + 100)).toBe(FANOUT_ALERT_PER_DAY + 1);
  });
});

describe('overflow through GroupCoalescer (15 min / 12 items)', () => {
  it('delivers one burst at maxItems and one at window end', async () => {
    const flushed: Array<{ key: string; n: number }> = [];
    let timerFn: (() => void) | null = null;
    const c = new GroupCoalescer<{ id: string }>({
      onFlush: (key, _m, items) => { flushed.push({ key, n: items.length }); },
      windowMs: 15 * 60_000,
      maxItems: 12,
      setTimer: (fn) => { timerFn = fn; return 1; },
      clearTimer: () => { timerFn = null; },
    });
    const item = (i: number): CoalescedItem => ({ ts: T0 + i, sender: 'Cal', text: `[Card] ${i} ILS`, mediaInfo: '', quotedInfo: '', fromMe: false });
    for (let i = 0; i < 12; i++) c.push('u:connector:cal', { id: 'cal' }, item(i));
    expect(flushed).toEqual([{ key: 'u:connector:cal', n: 12 }]);
    c.push('u:connector:cal', { id: 'cal' }, item(12));
    expect(c.size('u:connector:cal')).toBe(1);
    timerFn!();
    await Promise.resolve();
    expect(flushed).toEqual([{ key: 'u:connector:cal', n: 12 }, { key: 'u:connector:cal', n: 1 }]);
  });
});

describe('connector liveness (in-memory last-event map)', () => {
  beforeEach(() => resetConnectorLiveness());
  it('null until an event is seen, then the age in minutes, per user and connector', () => {
    expect(connectorEventAgeMinutes('u', 'cal', T0)).toBeNull();
    expect(getConnectorLastEventAt('u', 'cal')).toBeNull();
    recordConnectorEvent('u', 'cal', T0);
    expect(connectorEventAgeMinutes('u', 'cal', T0 + 30 * 60_000)).toBe(30);
    expect(connectorEventAgeMinutes('u', 'max', T0 + 30 * 60_000)).toBeNull();
    expect(connectorEventAgeMinutes('v', 'cal', T0 + 30 * 60_000)).toBeNull();
    expect(getConnectorLastEventAt('u', 'cal')).toBe(new Date(T0).toISOString());
  });
});
