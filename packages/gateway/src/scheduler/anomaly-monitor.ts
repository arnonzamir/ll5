import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { raiseAlert, clearAlert, type AlertSeverity } from '../utils/alerting.js';
import { withSchedulerHealth } from '../utils/scheduler-health.js';

interface AnomalyMonitorConfig {
  intervalMinutes: number;
  userId: string;
}

/** Median of a non-empty list (even length → rounded mean of the middle two). */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/**
 * Median WITHOUT the integer rounding `median` applies — for fractional values.
 * `median` rounds because its callers compare document counts; feeding it shares
 * would round a two-sample median of 0.72/0.82 to 1.0 and make every share gate
 * unsatisfiable.
 */
function medianFraction(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Nearest-rank percentile (p in [0,100]) of a non-empty numeric list. */
function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * s.length);
  return s[Math.min(s.length - 1, Math.max(0, rank - 1))];
}

/** Compare a numeric value against a bound with a small op set (for gauge gates). */
function cmp(v: number, op: '>' | '<' | '>=' | '<=', bound: number): boolean {
  switch (op) {
    case '>': return v > bound;
    case '<': return v < bound;
    case '>=': return v >= bound;
    case '<=': return v <= bound;
  }
}

// --- DECISION-025 B3 reconcile-gauge thresholds (named + defensible) ----------
/** missed_close is designed to settle to 0 each ~15-min cycle, so a single LATEST doc
 *  > 0 is an acceptable trip (no multi-cycle sustain needed given the cadence): it means
 *  the worker isn't keeping up / a loop's inbound isn't being reviewed. */
const MISSED_CLOSE_MAX = 0;
/** Any wrong_close (a close with ZERO grounding on its thread) is a real problem. */
const WRONG_CLOSE_MAX = 0;
/** Coverage target: below this, too many candidate closes went ungrounded. */
const MIN_COVERAGE = 0.8;
/** Don't judge coverage on a tiny denominator (null coverage / few candidates = noise). */
const MIN_CANDIDATES_FOR_COVERAGE = 3;

// --- DECISION-025 B3 narrative non-degradation (ALIVE but SLOW) ---------------
// The ~20-min narrative loop's healthy p95 inter-arrival gap is ~20–25m. We trip when the
// RECENT p95 gap materially exceeds the trailing BASELINE p95 — a regression the plain
// liveness (dead-at-45m) check can't see. Conservative on both axes: an absolute floor
// (above healthy cadence, below the 45m liveness line) AND a relative factor vs baseline.
const NARR_CADENCE_RECENT_MIN = 180;    // 3h recent window
const NARR_CADENCE_BASELINE_MIN = 1440; // 24h trailing baseline
const NARR_CADENCE_FACTOR = 1.75;       // recent p95 must exceed 1.75× baseline p95
const NARR_CADENCE_FLOOR_MIN = 35;      // …and exceed 35m absolute (>healthy ~20m, <45m dead-line)
const NARR_CADENCE_MIN_SAMPLES = 5;     // need a real distribution in each window
// Per-tick COST companion: ll5_app_log tool_call rows carry `duration_ms` (server.ts),
// so a cost-regression IS available (not deferred). A list_narrative_work call whose recent
// p95 duration blows out vs baseline signals the loop getting expensive/slow under load.
const NARR_COST_FLOOR_MS = 5000;        // 5s: only fire on a genuinely slow p95 call
const CADENCE_PCT = 95;

/**
 * A "did it stop?" check: a metric that should keep moving is stale if its newest
 * data point is older than `maxMinutes`. The most robust simple anomaly — no
 * seasonality to fight. Returns null age → no data/baseline → never alert.
 */
interface StalenessCheck {
  kind: 'staleness';
  key: string;
  label: string;
  maxMinutes: number;
  severity: AlertSeverity;
  suggestion: string;
  /** How to read the age (minutes since the newest relevant event), or null if there's no baseline. */
  ageMinutes: (m: AnomalyMonitor) => Promise<number | null>;
}

/**
 * A throughput rate-shift: compare the count in the current window to the SAME
 * window yesterday (a simple, seasonality-proof baseline — 14:00–15:00 today vs
 * 14:00–15:00 yesterday). Alerts on a big DROP (a feed/agent went quiet) when the
 * baseline itself was meaningfully active. No ML, no rolling stats.
 */
interface RateShiftCheck {
  kind: 'rateShift';
  key: string;
  label: string;
  severity: AlertSeverity;
  suggestion: string;
  windowMinutes: number;
  /** 'drop' (a feed went quiet) or 'rise' (a spike, e.g. over-suppressing). Default 'drop'. */
  direction?: 'drop' | 'rise';
  /** Min baseline count to bother comparing (avoid judging tiny numbers). */
  minBaseline: number;
  /** Fractional change vs same-window-yesterday to trip:
   *  drop → current <= baseline*(1-minChangePct); rise → current >= baseline*(1+minChangePct). */
  minChangePct: number;
  index: string;
  timestampField: string;
  filter?: Record<string, unknown>[];
  /**
   * Optional SHARE gate: the metric must ALSO move as a fraction of a denominator
   * population, not just in absolute count. Both metrics are then reported in the
   * alert value.
   *
   * Why: a count-only rate shift cannot tell "the agent changed behavior" from
   * "the agent got twice as many events and behaved identically". Measured on the
   * 2026-08-19 `behavior.suppress_spike` firing: suppress count 32 vs a 13 median
   * (2.46x — tripped) while the suppress SHARE was 86.5% vs a 72.2% median
   * (+14.3pp) and `ping_now` was 5 on every comparable day. The agent's behavior
   * barely moved; a new-phone provisioning burst had doubled the event volume.
   *
   * The margin is in absolute PERCENTAGE POINTS, not a multiplier: a share is
   * bounded at 100%, so "2x" is unsatisfiable once the baseline share is past 50%
   * (72.2% x 2 = 144%) — a multiplicative gate would silently never fire.
   */
  shareGate?: {
    /** Filter selecting the denominator population (omit → every doc in the window). */
    denominator?: Record<string, unknown>[];
    /** Absolute percentage-point move required, in the check's direction. */
    minPoints: number;
    /** Don't judge a share computed off fewer than this many denominator docs. */
    minDenominator: number;
  };
}

/**
 * A GAUGE on the newest doc of an index (user-scoped, sorted by `timestampField` desc,
 * size 1): read one numeric `field` and alert when it breaches `bound` under `op`. An
 * optional `gate` (a second numeric field/op/bound) must hold for the alert to fire (e.g.
 * "coverage < 0.8 AND candidate_count >= 3" — never judge a tiny denominator). Self-arming:
 * absent doc / absent-or-non-numeric field (incl. `null` coverage) / unmet gate → NO alert.
 */
interface LatestGaugeCheck {
  kind: 'latestGauge';
  key: string;
  label: string;
  severity: AlertSeverity;
  suggestion: string;
  index: string;
  timestampField: string;
  field: string;
  op: '>' | '<';
  bound: number;
  gate?: { field: string; op: '>' | '<' | '>=' | '<='; bound: number };
}

/**
 * A NON-DEGRADATION regression: the loop is ALIVE but SLOWER. Over a RECENT window and a
 * longer BASELINE window, take a percentile of a per-call signal — either the inter-arrival
 * GAP (minutes between consecutive tool_call rows) or a numeric FIELD on each row (e.g.
 * duration_ms cost). Trip when the recent pXX exceeds the baseline pXX by `regressionFactor`
 * AND clears an absolute `floor` (avoids flapping when both windows are tiny/fast). Best-
 * effort: <`minSamples` in either window, or any query failure → NO alert.
 */
interface PercentileRegressionCheck {
  kind: 'percentileRegression';
  key: string;
  label: string;
  severity: AlertSeverity;
  suggestion: string;
  toolName: string;
  /** 'gap' → inter-arrival minutes between calls; 'field' → a numeric field on each call row. */
  signal: 'gap' | 'field';
  field?: string; // required when signal === 'field'
  recentWindowMinutes: number;
  baselineWindowMinutes: number;
  percentile: number;
  regressionFactor: number;
  /** Absolute floor the recent pXX must exceed to trip (units match the signal). */
  floor: number;
  minSamples: number;
}

type Check = StalenessCheck | RateShiftCheck | LatestGaugeCheck | PercentileRegressionCheck;

export class AnomalyMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private active = new Set<string>();
  private checks: Check[];

  constructor(
    private pool: Pool,
    private es: Client,
    private config: AnomalyMonitorConfig,
  ) {
    this.checks = buildChecks();
  }

  start(): void {
    logger.info('[AnomalyMonitor][start] Started', {
      userId: this.config.userId,
      intervalMinutes: this.config.intervalMinutes,
      checks: this.checks.map((c) => c.key),
    });
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.intervalMinutes * 60 * 1000);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  // --- shared query helpers (used by check definitions) --------------------

  /** Minutes since the last `tool_call` for a tool in ll5_app_log, or null if never. */
  async toolCallAgeMinutes(toolName: string): Promise<number | null> {
    return this.lastDocAgeMinutes('ll5_app_log', 'timestamp', [
      { term: { action: 'tool_call' } },
      { term: { tool_name: toolName } },
    ]);
  }

  /** Minutes since the newest doc matching the filter, or null if none. */
  async lastDocAgeMinutes(index: string, tsField: string, filter: Record<string, unknown>[]): Promise<number | null> {
    try {
      const res = await this.es.search<Record<string, unknown>>({
        index,
        size: 1,
        _source: [tsField],
        sort: [{ [tsField]: { order: 'desc' } }],
        query: { bool: { filter: [{ term: { user_id: this.config.userId } }, ...filter] } },
      });
      const src = res.hits.hits?.[0]?._source as Record<string, unknown> | undefined;
      const ts = src?.[tsField] as string | undefined;
      if (!ts) return null;
      return (Date.now() - new Date(ts).getTime()) / 60_000;
    } catch (err) {
      logger.debug('[AnomalyMonitor] lastDocAge query failed', { index, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  /** Newest doc's _source (user-scoped, sorted by tsField desc), or null if none / on failure. */
  async latestDoc(index: string, tsField: string, fields: string[]): Promise<Record<string, unknown> | null> {
    try {
      const res = await this.es.search<Record<string, unknown>>({
        index,
        size: 1,
        _source: fields,
        sort: [{ [tsField]: { order: 'desc' } }],
        query: { bool: { filter: [{ term: { user_id: this.config.userId } }] } },
      });
      return (res.hits.hits?.[0]?._source as Record<string, unknown> | undefined) ?? null;
    } catch (err) {
      logger.debug('[AnomalyMonitor] latestDoc query failed', { index, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  /** Ascending timestamps (ms) of a tool's tool_call rows in the last window (user-scoped),
   *  or null on query failure. Empty array when there are simply no calls. */
  private async toolCallTimestamps(toolName: string, windowMinutes: number): Promise<number[] | null> {
    try {
      const gte = new Date(Date.now() - windowMinutes * 60_000).toISOString();
      const res = await this.es.search<Record<string, unknown>>({
        index: 'll5_app_log',
        size: 2000,
        _source: ['timestamp'],
        sort: [{ timestamp: { order: 'asc' } }],
        query: { bool: { filter: [
          { term: { user_id: this.config.userId } },
          { term: { action: 'tool_call' } },
          { term: { tool_name: toolName } },
          { range: { timestamp: { gte } } },
        ] } },
      });
      return (res.hits.hits ?? [])
        .map((h) => new Date((h._source as Record<string, unknown> | undefined)?.timestamp as string).getTime())
        .filter((t) => !Number.isNaN(t));
    } catch {
      return null;
    }
  }

  /** Consecutive inter-arrival GAPS (minutes) between a tool's tool_call rows over the window,
   *  or null when the query fails or there are < 2 calls (insufficient data → no alert). */
  async toolCallGapsMinutes(toolName: string, windowMinutes: number): Promise<number[] | null> {
    const ts = await this.toolCallTimestamps(toolName, windowMinutes);
    if (!ts || ts.length < 2) return null;
    const gaps: number[] = [];
    for (let i = 1; i < ts.length; i++) gaps.push((ts[i] - ts[i - 1]) / 60_000);
    return gaps;
  }

  /** Numeric FIELD values (e.g. duration_ms) across a tool's tool_call rows over the window
   *  (user-scoped), or null on query failure. Rows missing/with a non-numeric field are skipped. */
  async toolCallFieldValues(toolName: string, field: string, windowMinutes: number): Promise<number[] | null> {
    try {
      const gte = new Date(Date.now() - windowMinutes * 60_000).toISOString();
      const res = await this.es.search<Record<string, unknown>>({
        index: 'll5_app_log',
        size: 2000,
        _source: [field],
        sort: [{ timestamp: { order: 'asc' } }],
        query: { bool: { filter: [
          { term: { user_id: this.config.userId } },
          { term: { action: 'tool_call' } },
          { term: { tool_name: toolName } },
          { range: { timestamp: { gte } } },
        ] } },
      });
      return (res.hits.hits ?? [])
        .map((h) => (h._source as Record<string, unknown> | undefined)?.[field])
        .filter((v): v is number => typeof v === 'number' && !Number.isNaN(v));
    } catch {
      return null;
    }
  }

  /** Count docs in [gte, lte) for a window. */
  async countInWindow(index: string, tsField: string, gte: string, lte: string, filter: Record<string, unknown>[] = []): Promise<number> {
    try {
      const res = await this.es.count({
        index,
        query: { bool: { filter: [{ term: { user_id: this.config.userId } }, { range: { [tsField]: { gte, lt: lte } } }, ...filter] } },
      });
      return res.count ?? 0;
    } catch {
      return -1; // signal "query failed" so the caller skips (don't false-alert)
    }
  }

  // --- detectors -----------------------------------------------------------

  private async runStaleness(c: StalenessCheck): Promise<boolean> {
    const age = await c.ageMinutes(this);
    if (age === null) return false; // no baseline → never alert
    if (age <= c.maxMinutes) return false;
    await raiseAlert(this.pool, {
      userId: this.config.userId, key: c.key, severity: c.severity,
      summary: `${c.label} stalled`,
      value: `no activity for ${Math.round(age)}m`,
      expected: `< ${c.maxMinutes}m`,
      suggestion: c.suggestion,
    });
    return true;
  }

  private async runRateShift(c: RateShiftCheck): Promise<boolean> {
    const w = c.windowMinutes * 60_000;
    const now = Date.now();
    const curGte = new Date(now - w).toISOString();
    const curLt = new Date(now).toISOString();
    const current = await this.countInWindow(c.index, c.timestampField, curGte, curLt, c.filter);
    if (current < 0) return false;                          // query failed → skip
    // Baseline: the SAME window on the SAME weekday, over the last 3 weeks (7/14/21d back).
    // Weekly seasonality dominates daily — this Friday looks like last Friday, not like
    // yesterday. "Same window yesterday" crosses the weekday/weekend (Shabbat) boundary and
    // false-fired overnight (a quiet pre-dawn vs a fluke-busy one). Median over 3 same-weekday
    // samples is robust to a single anomalous week.
    const WEEK = 7 * 86_400_000;
    const samples: number[] = [];
    const shareSamples: number[] = [];
    for (const weeksBack of [1, 2, 3]) {
      const off = weeksBack * WEEK;
      const gte = new Date(now - off - w).toISOString();
      const lt = new Date(now - off).toISOString();
      const n = await this.countInWindow(c.index, c.timestampField, gte, lt, c.filter);
      if (n >= 0) samples.push(n);
      if (c.shareGate && n >= 0) {
        const denom = await this.countInWindow(c.index, c.timestampField, gte, lt, c.shareGate.denominator);
        // Skip a sample whose denominator is too small to carry a meaningful share
        // (a near-empty window would otherwise contribute a wild 0% or 100%).
        if (denom >= c.shareGate.minDenominator) shareSamples.push(n / denom);
      }
    }
    if (samples.length === 0) return false;                 // no usable history → skip
    const baseline = median(samples);
    if (baseline < c.minBaseline) return false;             // baseline too quiet to judge
    const dir = c.direction ?? 'drop';
    const tripped = dir === 'drop'
      ? current <= baseline * (1 - c.minChangePct)
      : current >= baseline * (1 + c.minChangePct);
    if (!tripped) return false;

    // Share gate: the count moved, but did the RATE? Both metrics are kept — the
    // count decides there is something to look at, the share decides whether it is
    // a behavior change or just more input. Self-arming: any missing piece (failed
    // query, denominator too small, no usable share history) → no alert, matching
    // the rest of this monitor's "never alert without a baseline" discipline.
    let shareNote = '';
    if (c.shareGate) {
      const curDenom = await this.countInWindow(c.index, c.timestampField, curGte, curLt, c.shareGate.denominator);
      if (curDenom < c.shareGate.minDenominator) return false;
      if (shareSamples.length === 0) return false;
      const curShare = current / curDenom;
      const baseShare = medianFraction(shareSamples);
      const points = (curShare - baseShare) * 100;
      const shareMoved = dir === 'drop' ? points <= -c.shareGate.minPoints : points >= c.shareGate.minPoints;
      if (!shareMoved) return false;
      shareNote = `; share ${(curShare * 100).toFixed(1)}% of ${curDenom} vs ${(baseShare * 100).toFixed(1)}% median (${points >= 0 ? '+' : ''}${points.toFixed(1)}pp)`;
    }

    await raiseAlert(this.pool, {
      userId: this.config.userId, key: c.key, severity: c.severity,
      summary: `${c.label} ${dir === 'drop' ? 'dropped' : 'spiked'}`,
      value: `${current} in the last ${c.windowMinutes}m vs ${baseline} median for this window over the last ${samples.length} same weekdays${shareNote}`,
      expected: `≈ ${baseline}`,
      suggestion: c.suggestion,
    });
    return true;
  }

  /** Gauge on the newest doc: absent doc / non-numeric (incl. null) field / unmet gate → no alert. */
  private async runLatestGauge(c: LatestGaugeCheck): Promise<boolean> {
    const fields = c.gate ? [c.field, c.gate.field] : [c.field];
    const doc = await this.latestDoc(c.index, c.timestampField, fields);
    if (!doc) return false; // no baseline doc yet (index empty / not created) → never alert
    const v = doc[c.field];
    if (typeof v !== 'number' || Number.isNaN(v)) return false; // absent / null coverage → never alert
    if (c.gate) {
      const g = doc[c.gate.field];
      if (typeof g !== 'number' || Number.isNaN(g)) return false; // gate field absent → never alert
      if (!cmp(g, c.gate.op, c.gate.bound)) return false;         // gate not satisfied (tiny denominator)
    }
    if (!cmp(v, c.op, c.bound)) return false;
    await raiseAlert(this.pool, {
      userId: this.config.userId, key: c.key, severity: c.severity,
      summary: `${c.label} out of bounds`,
      value: `${c.field}=${v}`,
      expected: `${c.op === '>' ? `<= ${c.bound}` : `>= ${c.bound}`}`,
      suggestion: c.suggestion,
    });
    return true;
  }

  /** Non-degradation regression: recent pXX of the signal (gap|field) materially exceeds baseline. */
  private async runPercentileRegression(c: PercentileRegressionCheck): Promise<boolean> {
    const load = (win: number): Promise<number[] | null> => c.signal === 'gap'
      ? this.toolCallGapsMinutes(c.toolName, win)
      : this.toolCallFieldValues(c.toolName, c.field as string, win);
    const recent = await load(c.recentWindowMinutes);
    const baseline = await load(c.baselineWindowMinutes);
    if (!recent || !baseline) return false;                                    // query failed / no data → no alert
    if (recent.length < c.minSamples || baseline.length < c.minSamples) return false; // too few samples → no alert
    const rP = percentile(recent, c.percentile);
    const bP = percentile(baseline, c.percentile);
    if (rP < c.floor) return false;                                            // recent still within healthy absolute bound
    if (rP < bP * c.regressionFactor) return false;                            // not materially worse than baseline
    await raiseAlert(this.pool, {
      userId: this.config.userId, key: c.key, severity: c.severity,
      summary: `${c.label} degraded`,
      value: `recent p${c.percentile} ${Math.round(rP)} vs baseline p${c.percentile} ${Math.round(bP)}`,
      expected: `< ${Math.round(bP * c.regressionFactor)}`,
      suggestion: c.suggestion,
    });
    return true;
  }

  private async runCheck(c: Check): Promise<boolean> {
    switch (c.kind) {
      case 'staleness': return this.runStaleness(c);
      case 'rateShift': return this.runRateShift(c);
      case 'latestGauge': return this.runLatestGauge(c);
      case 'percentileRegression': return this.runPercentileRegression(c);
    }
  }

  private async check(): Promise<void> {
    const firing = new Set<string>();
    for (const c of this.checks) {
      const tripped = await this.runCheck(c);
      if (tripped) { firing.add(c.key); this.active.add(c.key); }
    }
    for (const key of [...this.active]) {
      if (!firing.has(key)) {
        await clearAlert(this.pool, this.config.userId, key);
        this.active.delete(key);
      }
    }
  }

  private async tick(): Promise<void> {
    try {
      await withSchedulerHealth('anomaly_monitor', () => this.check());
    } catch {
      // withSchedulerHealth already recorded + logged the failure.
    }
  }
}

/**
 * The starter metric set (Freshness + Throughput). Agent-behavior (suppress/prep/
 * mismatch) is added once record_moment moments are shipped to ES (Phase B).
 * Add a metric = push one object here.
 */
function buildChecks(): Check[] {
  return [
    // FRESHNESS — "did it stop". The narrative loop calls list_narrative_work
    // every ~20 min (Claude Code variant) or ~60 min (opencode variant, sleep 3600s).
    // maxMinutes=90 accommodates the opencode cadence (catches a double-missed cycle).
    {
      kind: 'staleness',
      key: 'loop.narrative_consolidation',
      label: 'Narrative-maintenance loop',
      maxMinutes: 90,
      severity: 'warning',
      suggestion: 'The in-container narrative loop stopped calling list_narrative_work — check scripts/narrative-loop.sh / the agent container.',
      ageMinutes: (m) => m.toolCallAgeMinutes('list_narrative_work'),
    },
    // The agent should journal regularly while active; a full day of silence is a real stall.
    {
      kind: 'staleness',
      key: 'agent.journaling',
      label: 'Agent journaling',
      maxMinutes: 18 * 60,
      severity: 'warning',
      suggestion: 'No new journal entries for most of a day — the agent may be stuck or not processing events.',
      ageMinutes: (m) => m.lastDocAgeMinutes('ll5_agent_journal', 'created_at', []),
    },
    // THROUGHPUT — a big drop vs the same window on prior same-weekdays means the agent
    // suddenly went quiet (a feed died, or it's stuck). Seasonality-proof on BOTH axes:
    // same time-of-day AND same day-of-week (median over the last 3 weeks).
    {
      kind: 'rateShift',
      key: 'throughput.inbound_messages',
      label: 'Inbound message volume',
      severity: 'warning',
      suggestion: 'Far fewer inbound messages than the same time yesterday — a phone listener / channel may be down.',
      windowMinutes: 120,
      direction: 'drop',
      minBaseline: 8,
      minChangePct: 0.8, // current is < 20% of yesterday's same window
      index: 'll5_awareness_messages',
      timestampField: 'timestamp',
      filter: [{ term: { from_me: false } }],
    },
    // AGENT BEHAVIOR (Phase B) — reads ll5_eval_moments (shipped from the eval
    // recorder). Catches the regime change the inspect_image breakage caused: the
    // agent suddenly suppressing far more proactive turns than the day before.
    {
      kind: 'rateShift',
      key: 'behavior.suppress_spike',
      label: 'Proactive-turn suppression',
      severity: 'warning',
      suggestion: 'The agent is suppressing a far larger SHARE of its proactive moments than usual, on top of a raised count — a behavior change, not just a busier window. Often a downstream symptom of a broken tool (it can\'t act, so it suppresses): check recent tool failures first.',
      windowMinutes: 180,
      direction: 'rise',
      minBaseline: 12,
      minChangePct: 1.0, // doubled vs same window yesterday
      index: 'll5_eval_moments',
      timestampField: 'timestamp',
      filter: [{ term: { decision: 'suppress' } }],
      // Both metrics must move. 20 points is calibrated off real data: the
      // 2026-08-19 false positive sat at +9.3pp against its usable baselines
      // (86.5% vs a 77.2% median) while its COUNT was 2.46x, whereas a genuine
      // can't-act regime drives the share toward ~100% (a 72% baseline → +23pp
      // or more). Denominator = every eval moment in the window.
      shareGate: { minPoints: 20, minDenominator: 12 },
    },
    // Self-consistency degrading: the agent's claimed decision disagrees with what
    // it actually did, far more than yesterday.
    {
      kind: 'rateShift',
      key: 'behavior.mismatch_spike',
      label: 'Decision self-mismatch',
      severity: 'warning',
      suggestion: 'The agent\'s claimed vs actual proactive decision is disagreeing more than usual — a quality/grounding signal worth a look.',
      windowMinutes: 180,
      direction: 'rise',
      minBaseline: 4,
      minChangePct: 1.0,
      index: 'll5_eval_moments',
      timestampField: 'timestamp',
      filter: [{ term: { decision_mismatch: true } }],
    },
    // TELEMETRY LIVENESS — the eval WRITER itself (2026-07-14). Every behavior.* check below
    // reads ll5_eval_moments, so a dead eval recorder makes them lie: they report "the agent
    // stopped booking / stopped penciling" when the agent is fine and only the telemetry died.
    // That is exactly what happened when the variant image shipped the hook scripts without
    // their wiring — no eval moment for 33h, two false behavior alerts, no alert on the actual
    // fault. Threshold: over the 16 days before that outage the worst inter-arrival gap was
    // 8.7h (p99 = 1h), so 12h clears every real quiet stretch (nights included) with margin.
    // Self-arming: index empty → null age → no alert.
    {
      kind: 'staleness',
      key: 'telemetry.eval_moments_stale',
      label: 'Eval-moment recorder',
      maxMinutes: 12 * 60,
      severity: 'warning',
      suggestion: 'No ll5_eval_moments doc in 12h — the eval recorder (Stop hook eval-record.sh → eval_record.py) is not writing. While this fires, treat every behavior.* alert as UNRELIABLE (they read this index). Check the agent\'s hook wiring first: `docker exec <agent> node -e \'console.log(Object.keys(require("/workspace/.claude/settings.json").hooks))\'` — an empty/missing hooks block means the image lost it.',
      ageMinutes: (m) => m.lastDocAgeMinutes('ll5_eval_moments', 'timestamp', []),
    },
    // Forward work stalled (DECISION-018 §4): the daily loop should be BOOKING
    // prep (decision=ping_later, ground truth since 2026-07-01). No ping_later
    // moment for 48h means the calendar-review prep obligation isn't being
    // honored. Staleness convention: no ping_later doc at ALL → null age → never
    // alert (no baseline yet — the check arms itself once the first booking lands).
    {
      kind: 'staleness',
      key: 'behavior.forward_work_stalled',
      label: 'Forward work (ping_later bookings)',
      maxMinutes: 2880, // 48h
      severity: 'warning',
      suggestion: 'No ping_later eval moment in 48h — the daily loop isn\'t booking prep. Re-read the calendar-review prep obligation: for each prep-needing event in the next 48h, BOOK the prep THIS TURN (create_wake/tickler); naming it is not enough.',
      ageMinutes: (m) => m.lastDocAgeMinutes('ll5_eval_moments', 'timestamp', [{ term: { decision: 'ping_later' } }]),
    },
    // Pencil-the-timeline reflex went dormant: no calendar write (create_tickler /
    // create_event → pencil_count>0) in 72h. Any time-anchored thought/plan/deadline
    // should land on the LL5 System calendar the same turn; a multi-day silence for
    // an active user means the capture reflex regressed. Same null-age convention:
    // docs written before pencil_count shipped lack the field, a `range gt:0` filter
    // doesn't match absent fields, and no matching doc → null age → NO alert until
    // the first pencil ever lands (self-arming).
    {
      kind: 'staleness',
      key: 'behavior.pencil_reflex_stalled',
      label: 'Pencil-the-timeline reflex',
      maxMinutes: 4320, // 72h
      severity: 'warning',
      suggestion: 'No calendar pencil (create_tickler / create_event) in 72h — the pencil-the-timeline reflex may be dormant. Every time-anchored thought/plan/expectation/deadline should be penciled onto the LL5 System calendar the same turn (create_tickler kind:instruction). Check the persona rule fired and that create_tickler is working.',
      ageMinutes: (m) => m.lastDocAgeMinutes('ll5_eval_moments', 'timestamp', [{ range: { pencil_count: { gt: 0 } } }]),
    },
    // Ungrounded pings rising (DECISION-020 §5): ping_now turns with ZERO
    // lookup-class tool calls — asserting/acting without consulting the sensors
    // and stores. Defensive by construction: `grounding_calls` is absent on docs
    // written before the field shipped, and a `term: 0` filter simply doesn't
    // match absent fields — old docs never count toward current or baseline, so
    // the minBaseline gate holds the check silent until real history accrues.
    {
      kind: 'rateShift',
      key: 'behavior.ungrounded_pings',
      label: 'Ungrounded pings',
      severity: 'warning',
      suggestion: 'ping_now turns with zero grounding lookups are rising vs baseline — the agent is pinging without consulting its sensors/stores first. Re-read the sensor-before-assertion rule and the claim-class lookup map.',
      windowMinutes: 180,
      direction: 'rise',
      minBaseline: 8,
      minChangePct: 1.0,
      index: 'll5_eval_moments',
      timestampField: 'timestamp',
      filter: [{ term: { decision: 'ping_now' } }, { term: { grounding_calls: 0 } }],
    },
    // ---- RECONCILIATION (DECISION-025 B3) --------------------------------------
    // Observe the reconcile subsystem via the governor's ll5_reconcile_metrics docs and
    // the worker's list_reconcile_work tool calls. EVERY check here is self-arming: null/
    // absent → NO alert, so nothing fires before the (not-yet-deployed) worker/governor live.

    // Reconcile-worker liveness: the worker calls list_reconcile_work each tick; >45m with
    // no call → the loop (or agent) is dead. Same null-age convention as forward_work_stalled:
    // the tool was NEVER called yet (worker not deployed) → toolCallAgeMinutes returns null →
    // runStaleness returns false → NO alert. Arms itself once the worker first runs.
    // maxMinutes=90 accommodates the opencode variant's ~60-min cadence (sleep 3520s after each
    // cycle) while still catching a double-missed cycle.
    {
      kind: 'staleness',
      key: 'loop.reconcile_worker',
      label: 'Reconciliation worker loop',
      maxMinutes: 90,
      severity: 'warning',
      suggestion: 'The reconcile worker stopped calling list_reconcile_work — check the reconcile loop / the agent container.',
      ageMinutes: (m) => m.toolCallAgeMinutes('list_reconcile_work'),
    },
    // Governor freshness: the governor writes one ll5_reconcile_metrics doc every ~15m;
    // >45m stale → the governor scheduler died. No docs yet (index empty / not created) →
    // null age → NO alert.
    {
      kind: 'staleness',
      key: 'loop.reconcile_governor',
      label: 'Reconciliation governor',
      maxMinutes: 45,
      severity: 'warning',
      suggestion: 'No new ll5_reconcile_metrics doc in 45m — the reconcile governor scheduler stopped writing metrics.',
      ageMinutes: (m) => m.lastDocAgeMinutes('ll5_reconcile_metrics', 'timestamp', []),
    },
    // GAUGES on the LATEST ll5_reconcile_metrics doc. Absent doc / null field → never alert.
    // missed_close is designed to settle to 0 each ~15-min cycle → a single latest doc > 0
    // is an acceptable trip (the 15-min cadence makes a one-cycle read non-flappy).
    {
      kind: 'latestGauge',
      key: 'reconcile.missed_close_elevated',
      label: 'Missed-close backlog',
      severity: 'warning',
      suggestion: 'missed_close is not settling to 0 — the reconcile worker isn\'t keeping up, or a loop\'s inbound isn\'t being reviewed. Check the worker loop.',
      index: 'll5_reconcile_metrics',
      timestampField: 'timestamp',
      field: 'missed_close_count',
      op: '>',
      bound: MISSED_CLOSE_MAX,
    },
    // Any wrong_close is a real problem: a message-linked loop CLOSED with zero grounding
    // on its thread (a close nobody actually checked the conversation for).
    {
      kind: 'latestGauge',
      key: 'reconcile.wrong_close',
      label: 'Ungrounded closes',
      severity: 'warning',
      suggestion: 'A loop was closed with ZERO grounding on its thread this cycle — a close with no evidence it was actually reviewed. Inspect recent completions.',
      index: 'll5_reconcile_metrics',
      timestampField: 'timestamp',
      field: 'wrong_close_count',
      op: '>',
      bound: WRONG_CLOSE_MAX,
    },
    // Low coverage: too many candidate loops went ungrounded — but ONLY when there are
    // enough candidates to judge (gate: candidate_count >= 3; null coverage is non-numeric
    // → skipped by the gauge; a tiny denominator is skipped by the gate).
    {
      kind: 'latestGauge',
      key: 'reconcile.low_coverage',
      label: 'Reconciliation coverage',
      severity: 'warning',
      suggestion: 'Reconciliation coverage is low with enough candidates to judge — many candidate loops are going ungrounded. Check that the worker is grounding (query_im_messages) before closing.',
      index: 'll5_reconcile_metrics',
      timestampField: 'timestamp',
      field: 'reconciliation_coverage',
      op: '<',
      bound: MIN_COVERAGE,
      gate: { field: 'candidate_count', op: '>=', bound: MIN_CANDIDATES_FOR_COVERAGE },
    },
    // NARRATIVE NON-DEGRADATION (DECISION-025 B3): the loop is ALIVE but SLOW — the plain
    // liveness check (dead-at-45m) can't see this. CADENCE: recent p95 inter-arrival gap of
    // list_narrative_work materially exceeds its trailing baseline p95.
    {
      kind: 'percentileRegression',
      key: 'loop.narrative_cadence_regressed',
      label: 'Narrative-loop cadence',
      severity: 'warning',
      suggestion: 'The narrative loop is still alive but its tick cadence has degraded (recent p95 gap blew out vs baseline) — check for agent slowdown / contention before it goes fully stale.',
      toolName: 'list_narrative_work',
      signal: 'gap',
      recentWindowMinutes: NARR_CADENCE_RECENT_MIN,
      baselineWindowMinutes: NARR_CADENCE_BASELINE_MIN,
      percentile: CADENCE_PCT,
      regressionFactor: NARR_CADENCE_FACTOR,
      floor: NARR_CADENCE_FLOOR_MIN,
      minSamples: NARR_CADENCE_MIN_SAMPLES,
    },
    // …and the per-tick COST companion (available because ll5_app_log tool_call rows carry
    // duration_ms): recent p95 call duration blows out vs baseline → the loop is getting
    // expensive/slow under load.
    {
      kind: 'percentileRegression',
      key: 'loop.narrative_cost_regressed',
      label: 'Narrative-loop call cost',
      severity: 'warning',
      suggestion: 'list_narrative_work call duration (p95) has blown out vs baseline — the narrative loop is getting expensive/slow. Check ES / agent load.',
      toolName: 'list_narrative_work',
      signal: 'field',
      field: 'duration_ms',
      recentWindowMinutes: NARR_CADENCE_RECENT_MIN,
      baselineWindowMinutes: NARR_CADENCE_BASELINE_MIN,
      percentile: CADENCE_PCT,
      regressionFactor: NARR_CADENCE_FACTOR,
      floor: NARR_COST_FLOOR_MS,
      minSamples: NARR_CADENCE_MIN_SAMPLES,
    },
  ];
}
