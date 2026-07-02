import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';

const raiseAlert = vi.fn(async () => {});
const clearAlert = vi.fn(async () => {});
vi.mock('../utils/alerting.js', () => ({
  raiseAlert: (...a: unknown[]) => raiseAlert(...a),
  clearAlert: (...a: unknown[]) => clearAlert(...a),
}));
vi.mock('../utils/scheduler-health.js', () => ({
  withSchedulerHealth: (_n: string, fn: () => Promise<void>) => fn(),
}));

import { AnomalyMonitor } from '../scheduler/anomaly-monitor.js';

const pool = {} as Pool;
const mk = (es: Client) => new AnomalyMonitor(pool, es, { intervalMinutes: 15, userId: 'u1' });
type Priv = {
  runStaleness: (c: unknown) => Promise<boolean>;
  runRateShift: (c: unknown) => Promise<boolean>;
};
const priv = (m: AnomalyMonitor) => m as unknown as Priv;
const lastArg = () => raiseAlert.mock.calls[0][1] as Record<string, unknown>;

const staleCheck = (age: number | null, max = 45) => ({
  kind: 'staleness', key: 'loop.x', label: 'Loop', maxMinutes: max,
  severity: 'warning', suggestion: 's', ageMinutes: async () => age,
});

function esCount(seq: number[]): Client {
  const count = vi.fn();
  seq.forEach((v) => count.mockResolvedValueOnce({ count: v }));
  return { count } as unknown as Client;
}
const rsCheck = {
  kind: 'rateShift', key: 'tp.msgs', label: 'Msgs', severity: 'warning', suggestion: 's',
  windowMinutes: 120, direction: 'drop', minBaseline: 8, minChangePct: 0.8, index: 'i', timestampField: 'timestamp',
};
const riseCheck = {
  kind: 'rateShift', key: 'behavior.suppress_spike', label: 'Suppress', severity: 'warning', suggestion: 's',
  windowMinutes: 180, direction: 'rise', minBaseline: 12, minChangePct: 1.0, index: 'll5_eval_moments', timestampField: 'timestamp',
};

describe('AnomalyMonitor — staleness detector', () => {
  beforeEach(() => { raiseAlert.mockClear(); clearAlert.mockClear(); });

  it('alerts when age exceeds maxMinutes', async () => {
    expect(await priv(mk({} as Client)).runStaleness(staleCheck(60))).toBe(true);
    expect(raiseAlert).toHaveBeenCalledTimes(1);
    expect(lastArg().key).toBe('loop.x');
    expect(String(lastArg().value)).toContain('60m');
  });
  it('does NOT alert within maxMinutes', async () => {
    expect(await priv(mk({} as Client)).runStaleness(staleCheck(10))).toBe(false);
    expect(raiseAlert).not.toHaveBeenCalled();
  });
  it('does NOT alert when there is no baseline (null age)', async () => {
    expect(await priv(mk({} as Client)).runStaleness(staleCheck(null))).toBe(false);
    expect(raiseAlert).not.toHaveBeenCalled();
  });
});

describe('AnomalyMonitor — rate-shift detector (same window, same weekday, 3-week median)', () => {
  beforeEach(() => { raiseAlert.mockClear(); clearAlert.mockClear(); });
  // count call order: current, then 3 baseline samples (1/2/3 weeks back).

  it('alerts on a big drop vs the same-weekday median', async () => {
    // current=2, baseline=median(20,22,21)=21 → 2 <= 21*0.2=4.2 → alert
    expect(await priv(mk(esCount([2, 20, 22, 21]))).runRateShift(rsCheck)).toBe(true);
    expect(String(lastArg().value)).toContain('2 in the last');
    expect(String(lastArg().value)).toContain('21 median for this window over the last 3 same weekdays');
  });
  it('does NOT alert when current is near the same-weekday median', async () => {
    expect(await priv(mk(esCount([18, 20, 22, 21]))).runRateShift(rsCheck)).toBe(false);
    expect(raiseAlert).not.toHaveBeenCalled();
  });
  it('does NOT alert when the baseline median is too quiet to judge', async () => {
    expect(await priv(mk(esCount([0, 3, 4, 2]))).runRateShift(rsCheck)).toBe(false); // median 3 < minBaseline 8
  });
  it('does NOT alert when the current-window query fails (negative)', async () => {
    expect(await priv(mk(esCount([-1, 20, 22, 21]))).runRateShift(rsCheck)).toBe(false);
  });
  it('is robust to a single fluke-busy week (median ignores the outlier)', async () => {
    // last week was an anomalous burst (116), the prior two were normal (10, 12).
    // median(116,10,12)=12, current=18 → 18 > 12*0.2 → NO alert (old "vs yesterday" would have fired).
    expect(await priv(mk(esCount([18, 116, 10, 12]))).runRateShift(rsCheck)).toBe(false);
    expect(raiseAlert).not.toHaveBeenCalled();
  });
  it('still alerts on a real dead feed despite one missing week (0) in history', async () => {
    // current=0; samples = [0 (missing/quiet week), 30, 28] → median 28 ≥ minBaseline, 0 <= 5.6 → alert
    expect(await priv(mk(esCount([0, 0, 30, 28]))).runRateShift(rsCheck)).toBe(true);
  });

  it('rise: alerts when current spikes >= (1+minChangePct)*median', async () => {
    // current=40, baseline=median(15,15,15)=15 → 40 >= 15*2=30 → suppress spike
    expect(await priv(mk(esCount([40, 15, 15, 15]))).runRateShift(riseCheck)).toBe(true);
    expect(String(lastArg().summary)).toContain('spiked');
  });
  it('rise: no alert when current is only modestly above the median', async () => {
    // current=20, baseline=15 → 20 < 30 → no alert
    expect(await priv(mk(esCount([20, 15, 15, 15]))).runRateShift(riseCheck)).toBe(false);
  });
});

describe('AnomalyMonitor — behavior checks (DECISION-018/020)', () => {
  beforeEach(() => { raiseAlert.mockClear(); clearAlert.mockClear(); });

  type WithChecks = { checks: Array<Record<string, unknown>> };
  const checkByKey = (m: AnomalyMonitor, key: string) =>
    (m as unknown as WithChecks).checks.find((c) => c.key === key)!;

  it('registers behavior.forward_work_stalled (48h staleness) and behavior.ungrounded_pings (rise)', () => {
    const m = mk({} as Client);
    const stalled = checkByKey(m, 'behavior.forward_work_stalled');
    expect(stalled.kind).toBe('staleness');
    expect(stalled.maxMinutes).toBe(2880);
    const ungrounded = checkByKey(m, 'behavior.ungrounded_pings');
    expect(ungrounded.kind).toBe('rateShift');
    expect(ungrounded.direction).toBe('rise');
    expect(ungrounded.index).toBe('ll5_eval_moments');
    expect(ungrounded.timestampField).toBe('timestamp');
    expect(ungrounded.minBaseline).toBe(8);
    expect(ungrounded.filter).toEqual([
      { term: { decision: 'ping_now' } },
      { term: { grounding_calls: 0 } },
    ]);
  });

  it('forward_work_stalled: alerts when the newest ping_later moment is older than 48h', async () => {
    const staleTs = new Date(Date.now() - 72 * 3_600_000).toISOString(); // 3 days ago
    const search = vi.fn(async () => ({ hits: { hits: [{ _source: { timestamp: staleTs } }] } }));
    const m = mk({ search } as unknown as Client);
    const check = checkByKey(m, 'behavior.forward_work_stalled');
    expect(await priv(m).runStaleness(check)).toBe(true);
    expect(lastArg().key).toBe('behavior.forward_work_stalled');
    // The query targets ping_later moments on the `timestamp` field (NOT @timestamp).
    const q = search.mock.calls[0][0] as { index: string; sort: unknown[]; query: { bool: { filter: unknown[] } } };
    expect(q.index).toBe('ll5_eval_moments');
    expect(q.sort).toEqual([{ timestamp: { order: 'desc' } }]);
    expect(q.query.bool.filter).toContainEqual({ term: { decision: 'ping_later' } });
  });

  it('forward_work_stalled: fresh ping_later → no alert; no ping_later at all → no alert (no baseline)', async () => {
    const freshTs = new Date(Date.now() - 60 * 60_000).toISOString(); // 1h ago
    const fresh = mk({ search: vi.fn(async () => ({ hits: { hits: [{ _source: { timestamp: freshTs } }] } })) } as unknown as Client);
    expect(await priv(fresh).runStaleness(checkByKey(fresh, 'behavior.forward_work_stalled'))).toBe(false);
    const empty = mk({ search: vi.fn(async () => ({ hits: { hits: [] } })) } as unknown as Client);
    expect(await priv(empty).runStaleness(checkByKey(empty, 'behavior.forward_work_stalled'))).toBe(false);
    expect(raiseAlert).not.toHaveBeenCalled();
  });

  it('ungrounded_pings: alerts when zero-grounding pings double vs the same-weekday median', async () => {
    // count call order: current, then 3 baseline samples (1/2/3 weeks back).
    const es = esCount([20, 9, 8, 8]); // current=20 >= median(8,8,9)=8 * 2
    const m = mk(es);
    expect(await priv(m).runRateShift(checkByKey(m, 'behavior.ungrounded_pings'))).toBe(true);
    expect(String(lastArg().summary)).toContain('spiked');
    // Every count query carries the decision + grounding_calls filter.
    const countMock = (es as unknown as { count: ReturnType<typeof vi.fn> }).count;
    for (const call of countMock.mock.calls) {
      const filters = (call[0] as { query: { bool: { filter: unknown[] } } }).query.bool.filter;
      expect(filters).toContainEqual({ term: { decision: 'ping_now' } });
      expect(filters).toContainEqual({ term: { grounding_calls: 0 } });
    }
  });

  it('ungrounded_pings: stays silent while the baseline is below the floor (old docs lack grounding_calls)', async () => {
    // Pre-field history: baseline windows count 0 (term filter matches nothing) →
    // median 0 < minBaseline 8 → never alert, however big the current window looks.
    const m = mk(esCount([25, 0, 0, 0]));
    expect(await priv(m).runRateShift(checkByKey(m, 'behavior.ungrounded_pings'))).toBe(false);
    expect(raiseAlert).not.toHaveBeenCalled();
  });
});
