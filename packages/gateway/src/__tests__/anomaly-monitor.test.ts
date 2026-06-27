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

describe('AnomalyMonitor — rate-shift detector (same window yesterday)', () => {
  beforeEach(() => { raiseAlert.mockClear(); clearAlert.mockClear(); });

  it('alerts on a big drop vs the same window yesterday', async () => {
    // current=2, baseline=20 → 2 <= 20*(1-0.8)=4 → alert
    expect(await priv(mk(esCount([2, 20]))).runRateShift(rsCheck)).toBe(true);
    expect(String(lastArg().value)).toContain('2 in the last');
    expect(String(lastArg().value)).toContain('20 same window yesterday');
  });
  it('does NOT alert when current is near the baseline', async () => {
    expect(await priv(mk(esCount([18, 20]))).runRateShift(rsCheck)).toBe(false);
    expect(raiseAlert).not.toHaveBeenCalled();
  });
  it('does NOT alert when the baseline is too quiet to judge', async () => {
    expect(await priv(mk(esCount([0, 3]))).runRateShift(rsCheck)).toBe(false); // baseline 3 < minBaseline 8
  });
  it('does NOT alert when a count query fails (negative)', async () => {
    expect(await priv(mk(esCount([-1, 20]))).runRateShift(rsCheck)).toBe(false);
  });

  it('rise: alerts when current spikes >= (1+minChangePct)*baseline', async () => {
    // current=40, baseline=15 → 40 >= 15*2=30 → suppress spike
    expect(await priv(mk(esCount([40, 15]))).runRateShift(riseCheck)).toBe(true);
    expect(String(lastArg().summary)).toContain('spiked');
  });
  it('rise: no alert when current is only modestly above baseline', async () => {
    // current=20, baseline=15 → 20 < 30 → no alert
    expect(await priv(mk(esCount([20, 15]))).runRateShift(riseCheck)).toBe(false);
  });
});
