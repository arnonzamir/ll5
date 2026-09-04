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
  runPercentileRegression: (c: unknown) => Promise<boolean>;
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

// A count-only rate shift cannot separate "the agent changed behavior" from "the
// agent got twice the events and behaved identically". The share gate keeps BOTH
// metrics: the count says something moved, the share says whether it was behavior.
// count call order with a share gate: current numerator, then per baseline week
// (numerator, denominator), then the current denominator.
describe('AnomalyMonitor — rate-shift share gate', () => {
  beforeEach(() => { raiseAlert.mockClear(); clearAlert.mockClear(); });

  const gated = { ...riseCheck, shareGate: { minPoints: 20, minDenominator: 12 } };

  it('replays 2026-08-19: count 2.46x but the share barely moved → NO alert', async () => {
    // Real numbers from ll5_eval_moments, window 09:10-12:10Z:
    //   now      32 suppress / 37 moments = 86.5%
    //   -1 week  13 / 18 = 72.2%
    //   -2 weeks  2 /  5  → denominator 5 < 12, sample skipped
    //   -3 weeks 23 / 28 = 82.1%
    // count: 32 vs median(13,2,23)=13 → 2.46x, trips. share: 86.5% vs 77.2% median
    // = +9.3pp < 20 → held. (ping_now was 5 on every one of those days.)
    expect(await priv(mk(esCount([32, 13, 18, 2, 5, 23, 28, 37]))).runRateShift(gated)).toBe(false);
    expect(raiseAlert).not.toHaveBeenCalled();
  });

  it('alerts when the share genuinely shifts, and reports both metrics', async () => {
    // now 30/33 = 90.9%; baselines 13/26, 14/28, 12/24 = 50% each → +40.9pp.
    expect(await priv(mk(esCount([30, 13, 26, 14, 28, 12, 24, 33]))).runRateShift(gated)).toBe(true);
    const v = String(lastArg().value);
    expect(v).toContain('30 in the last 180m');   // count metric kept
    expect(v).toContain('13 median');
    expect(v).toContain('90.9% of 33');           // share metric added
    expect(v).toContain('50.0% median');
    expect(v).toContain('+40.9pp');
  });

  it('does NOT alert when the current denominator query fails', async () => {
    // Denominator -1 (ES hiccup) < minDenominator → self-arming skip rather than
    // an alert computed off a share we could not measure.
    expect(await priv(mk(esCount([30, 12, 60, 2, 5, 15, 50, -1]))).runRateShift(gated)).toBe(false);
    expect(raiseAlert).not.toHaveBeenCalled();
  });

  it('does NOT alert when every baseline denominator query fails', async () => {
    // No usable share history → no baseline to judge the share against → skip.
    expect(await priv(mk(esCount([30, 12, -1, 13, -1, 14, -1, 50]))).runRateShift(gated)).toBe(false);
    expect(raiseAlert).not.toHaveBeenCalled();
  });

  it('averages an even number of share samples without integer-rounding them', async () => {
    // Two usable baselines at 20% and 30% → 25% median. The plain `median` helper
    // rounds, which would collapse that to 0% and let a 60% share read as +60pp.
    // now 30/50 = 60% vs 25% → +35pp → alert, and the median must print 25.0%.
    expect(await priv(mk(esCount([30, 12, 60, 2, 5, 15, 50, 50]))).runRateShift(gated)).toBe(true);
    expect(String(lastArg().value)).toContain('25.0% median');
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
    const suppress = checkByKey(m, 'behavior.suppress_spike');
    expect(suppress.shareGate).toEqual({ minPoints: 20, minDenominator: 12 });
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

  it('pencil_reflex_stalled: 72h staleness filtered on pencil_count>0; stale → alert, fresh/never → no alert', async () => {
    // registration
    const reg = mk({ search: vi.fn(async () => ({ hits: { hits: [] } })) } as unknown as Client);
    const check = checkByKey(reg, 'behavior.pencil_reflex_stalled');
    expect(check.kind).toBe('staleness');
    expect(check.maxMinutes).toBe(4320);

    // stale (>72h) → alert, and the query filters pencil_count > 0 (self-arming: a
    // range gt:0 filter never matches docs written before the field shipped)
    const staleTs = new Date(Date.now() - 100 * 3_600_000).toISOString();
    const search = vi.fn(async () => ({ hits: { hits: [{ _source: { timestamp: staleTs } }] } }));
    const stale = mk({ search } as unknown as Client);
    expect(await priv(stale).runStaleness(checkByKey(stale, 'behavior.pencil_reflex_stalled'))).toBe(true);
    const q = search.mock.calls[0][0] as { query: { bool: { filter: unknown[] } } };
    expect(q.query.bool.filter).toContainEqual({ range: { pencil_count: { gt: 0 } } });

    // fresh pencil → no alert; never penciled (null age) → no alert
    const freshTs = new Date(Date.now() - 60 * 60_000).toISOString();
    const fresh = mk({ search: vi.fn(async () => ({ hits: { hits: [{ _source: { timestamp: freshTs } }] } })) } as unknown as Client);
    expect(await priv(fresh).runStaleness(checkByKey(fresh, 'behavior.pencil_reflex_stalled'))).toBe(false);
    const empty = mk({ search: vi.fn(async () => ({ hits: { hits: [] } })) } as unknown as Client);
    expect(await priv(empty).runStaleness(checkByKey(empty, 'behavior.pencil_reflex_stalled'))).toBe(false);
  });

  it('eval_moments_stale: 12h liveness on the eval WRITER, unfiltered (catches a dead recorder that would make every behavior.* check lie)', async () => {
    const reg = mk({ search: vi.fn(async () => ({ hits: { hits: [] } })) } as unknown as Client);
    const check = checkByKey(reg, 'telemetry.eval_moments_stale');
    expect(check.kind).toBe('staleness');
    expect(check.maxMinutes).toBe(720);

    // The 2026-07-13 outage shape: index frozen 33h (hooks unwired) while the agent was fine.
    const staleTs = new Date(Date.now() - 33 * 3_600_000).toISOString();
    const search = vi.fn(async () => ({ hits: { hits: [{ _source: { timestamp: staleTs } }] } }));
    const stale = mk({ search } as unknown as Client);
    expect(await priv(stale).runStaleness(checkByKey(stale, 'telemetry.eval_moments_stale'))).toBe(true);
    expect(lastArg().key).toBe('telemetry.eval_moments_stale');
    // Unfiltered: ANY eval moment counts as liveness (only user_id scoping).
    const q = search.mock.calls[0][0] as { index: string; query: { bool: { filter: unknown[] } } };
    expect(q.index).toBe('ll5_eval_moments');
    expect(q.query.bool.filter).toEqual([{ term: { user_id: 'u1' } }]);

    // A normal overnight quiet stretch (worst observed real gap was 8.7h) must NOT fire.
    const quietTs = new Date(Date.now() - 9 * 3_600_000).toISOString();
    const quiet = mk({ search: vi.fn(async () => ({ hits: { hits: [{ _source: { timestamp: quietTs } }] } })) } as unknown as Client);
    expect(await priv(quiet).runStaleness(checkByKey(quiet, 'telemetry.eval_moments_stale'))).toBe(false);

    // Empty index (never armed) → no alert.
    const empty = mk({ search: vi.fn(async () => ({ hits: { hits: [] } })) } as unknown as Client);
    expect(await priv(empty).runStaleness(checkByKey(empty, 'telemetry.eval_moments_stale'))).toBe(false);
  });

  it('observations_stale (ISS-002) and daily_restart_missing (ISS-016): registered with the right index/filter and thresholds, self-arming', async () => {
    const reg = mk({ search: vi.fn(async () => ({ hits: { hits: [] } })) } as unknown as Client);
    const obs = checkByKey(reg, 'knowledge.observations_stale');
    expect(obs.kind).toBe('staleness');
    expect(obs.maxMinutes).toBe(1440);
    const restart = checkByKey(reg, 'agent.daily_restart_missing');
    expect(restart.kind).toBe('staleness');
    expect(restart.maxMinutes).toBe(1560);

    // A 3-day observation drought fires; the query is the knowledge observations index.
    const oldTs = new Date(Date.now() - 3 * 24 * 3_600_000).toISOString();
    const search = vi.fn(async () => ({ hits: { hits: [{ _source: { created_at: oldTs } }] } }));
    const stale = mk({ search } as unknown as Client);
    expect(await priv(stale).runStaleness(checkByKey(stale, 'knowledge.observations_stale'))).toBe(true);
    expect((search.mock.calls[0][0] as { index: string }).index).toBe('ll5_knowledge_observations');

    // Restart check filters the journal on topic.keyword = session-restart; a fresh entry is quiet.
    const search2 = vi.fn(async () => ({ hits: { hits: [{ _source: { created_at: new Date(Date.now() - 3_600_000).toISOString() } }] } }));
    const fresh = mk({ search: search2 } as unknown as Client);
    expect(await priv(fresh).runStaleness(checkByKey(fresh, 'agent.daily_restart_missing'))).toBe(false);
    const q = search2.mock.calls[0][0] as { index: string; query: { bool: { filter: unknown[] } } };
    expect(q.index).toBe('ll5_agent_journal');
    expect(q.query.bool.filter).toEqual([{ term: { user_id: 'u1' } }, { term: { 'topic.keyword': 'session-restart' } }]);

    // Never restarted (no entry) → not armed → no alert.
    const empty = mk({ search: vi.fn(async () => ({ hits: { hits: [] } })) } as unknown as Client);
    expect(await priv(empty).runStaleness(checkByKey(empty, 'agent.daily_restart_missing'))).toBe(false);
  });

  it('session_save_stale (ISS-014): 24h liveness on ll5_session_history.indexed_at, scoped on user_id.keyword (dynamic-mapped index)', async () => {
    const reg = mk({ search: vi.fn(async () => ({ hits: { hits: [] } })) } as unknown as Client);
    const check = checkByKey(reg, 'agent.session_save_stale');
    expect(check.kind).toBe('staleness');
    expect(check.maxMinutes).toBe(1440);

    // The Aug 2026 shape: the live session's doc frozen for 8 days while the agent kept running.
    const staleTs = new Date(Date.now() - 8 * 24 * 3_600_000).toISOString();
    const search = vi.fn(async () => ({ hits: { hits: [{ _source: { indexed_at: staleTs } }] } }));
    const stale = mk({ search } as unknown as Client);
    expect(await priv(stale).runStaleness(checkByKey(stale, 'agent.session_save_stale'))).toBe(true);
    expect(lastArg().key).toBe('agent.session_save_stale');
    // Must query the keyword subfield — a term on the analyzed `user_id` never matches a
    // uuid on this index, which would make the check silently never arm.
    const q = search.mock.calls[0][0] as { index: string; sort: unknown[]; query: { bool: { filter: unknown[] } } };
    expect(q.index).toBe('ll5_session_history');
    expect(q.sort).toEqual([{ indexed_at: { order: 'desc' } }]);
    expect(q.query.bool.filter).toEqual([{ term: { 'user_id.keyword': 'u1' } }]);

    // A save within the last day → quiet.
    const freshTs = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const fresh = mk({ search: vi.fn(async () => ({ hits: { hits: [{ _source: { indexed_at: freshTs } }] } })) } as unknown as Client);
    expect(await priv(fresh).runStaleness(checkByKey(fresh, 'agent.session_save_stale'))).toBe(false);

    // No doc at all (fresh tenant) → not armed → no alert.
    const empty = mk({ search: vi.fn(async () => ({ hits: { hits: [] } })) } as unknown as Client);
    expect(await priv(empty).runStaleness(checkByKey(empty, 'agent.session_save_stale'))).toBe(false);
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

// ============================================================================
// DECISION-025 B3 — reconciliation observability + narrative non-degradation
// ============================================================================

type WithChecks = { checks: Array<Record<string, unknown>> };
const byKey = (m: AnomalyMonitor, key: string) =>
  (m as unknown as WithChecks).checks.find((c) => c.key === key)!;
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
/** ES mock whose `search` returns a fixed hit list (or a per-call sequence). */
const esSearch = (...seq: Array<{ hits: { hits: unknown[] } }>): Client => {
  const search = vi.fn();
  seq.forEach((r) => search.mockResolvedValueOnce(r));
  return { search } as unknown as Client;
};
const searchMock = (es: Client) => (es as unknown as { search: ReturnType<typeof vi.fn> }).search;
/** Every filter clause set across all search calls must scope to user_id: 'u1'. */
const assertAllScopedToU1 = (es: Client) => {
  const calls = searchMock(es).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    const filter = (call[0] as { query: { bool: { filter: unknown[] } } }).query.bool.filter;
    expect(filter).toContainEqual({ term: { user_id: 'u1' } });
  }
};

describe('AnomalyMonitor — DECISION-025 narrative non-degradation (percentileRegression)', () => {
  beforeEach(() => { raiseAlert.mockClear(); clearAlert.mockClear(); });
  // Ascending-timestamp hits spaced `gapMin` apart. `count` points → count-1 gaps.
  const spaced = (count: number, gapMin: number) => ({
    hits: { hits: Array.from({ length: count }, (_, i) => ({ _source: { timestamp: ago((count - 1 - i) * gapMin) } })) },
  });

  it('registers loop.narrative_cadence_regressed (gap) + loop.narrative_cost_regressed (duration_ms field)', () => {
    const m = mk({} as Client);
    const cad = byKey(m, 'loop.narrative_cadence_regressed');
    expect(cad.kind).toBe('percentileRegression');
    expect(cad.signal).toBe('gap');
    expect(cad.toolName).toBe('list_narrative_work');
    const cost = byKey(m, 'loop.narrative_cost_regressed');
    expect(cost.signal).toBe('field');
    expect(cost.field).toBe('duration_ms');
  });

  it('normal cadence → no alert (recent p95 gap below floor)', async () => {
    // recent then baseline: both ~20m gaps → recent p95 ~20 < 35m floor → no alert.
    const m = mk(esSearch(spaced(8, 20), spaced(12, 20)));
    expect(await priv(m).runPercentileRegression(byKey(m, 'loop.narrative_cadence_regressed'))).toBe(false);
    expect(raiseAlert).not.toHaveBeenCalled();
  });

  it('degraded cadence → alert (recent p95 gap blown out vs baseline)', async () => {
    // recent gaps ~60m (p95 60 > 35 floor, >= 20*1.75), baseline ~20m.
    const m = mk(esSearch(spaced(8, 60), spaced(12, 20)));
    expect(await priv(m).runPercentileRegression(byKey(m, 'loop.narrative_cadence_regressed'))).toBe(true);
    expect(lastArg().key).toBe('loop.narrative_cadence_regressed');
    expect(String(lastArg().summary)).toContain('degraded');
  });

  it('insufficient data → no alert (too few gaps in a window)', async () => {
    const few = mk(esSearch(spaced(2, 60), spaced(12, 20))); // recent: 1 gap < minSamples 5
    expect(await priv(few).runPercentileRegression(byKey(few, 'loop.narrative_cadence_regressed'))).toBe(false);
    const noneRecent = mk(esSearch({ hits: { hits: [] } }, spaced(12, 20)));
    expect(await priv(noneRecent).runPercentileRegression(byKey(noneRecent, 'loop.narrative_cadence_regressed'))).toBe(false);
    expect(raiseAlert).not.toHaveBeenCalled();
  });

  it('cross-tenant: both regression-window queries are user_id-scoped', async () => {
    const es = esSearch(spaced(8, 60), spaced(12, 20));
    const m = mk(es);
    await priv(m).runPercentileRegression(byKey(m, 'loop.narrative_cadence_regressed'));
    assertAllScopedToU1(es);
    // both calls also filter to the list_narrative_work tool_call rows.
    for (const call of searchMock(es).mock.calls) {
      const filter = (call[0] as { query: { bool: { filter: unknown[] } } }).query.bool.filter;
      expect(filter).toContainEqual({ term: { tool_name: 'list_narrative_work' } });
      expect(filter).toContainEqual({ term: { action: 'tool_call' } });
    }
  });
});
