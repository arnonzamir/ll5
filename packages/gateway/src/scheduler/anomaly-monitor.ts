import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { raiseAlert, clearAlert, type AlertSeverity } from '../utils/alerting.js';
import { withSchedulerHealth } from '../utils/scheduler-health.js';

interface AnomalyMonitorConfig {
  intervalMinutes: number;
  userId: string;
}

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
}

type Check = StalenessCheck | RateShiftCheck;

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
    const baseGte = new Date(now - 86_400_000 - w).toISOString();
    const baseLt = new Date(now - 86_400_000).toISOString();
    const current = await this.countInWindow(c.index, c.timestampField, curGte, curLt, c.filter);
    const baseline = await this.countInWindow(c.index, c.timestampField, baseGte, baseLt, c.filter);
    if (current < 0 || baseline < 0) return false;          // query failed → skip
    if (baseline < c.minBaseline) return false;             // baseline too quiet to judge
    const dir = c.direction ?? 'drop';
    const tripped = dir === 'drop'
      ? current <= baseline * (1 - c.minChangePct)
      : current >= baseline * (1 + c.minChangePct);
    if (!tripped) return false;
    await raiseAlert(this.pool, {
      userId: this.config.userId, key: c.key, severity: c.severity,
      summary: `${c.label} ${dir === 'drop' ? 'dropped' : 'spiked'}`,
      value: `${current} in the last ${c.windowMinutes}m vs ${baseline} same window yesterday`,
      expected: `≈ ${baseline}`,
      suggestion: c.suggestion,
    });
    return true;
  }

  private async check(): Promise<void> {
    const firing = new Set<string>();
    for (const c of this.checks) {
      const tripped = c.kind === 'staleness' ? await this.runStaleness(c) : await this.runRateShift(c);
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
    // FRESHNESS — "did it stop". The narrative loop calls list_narrative_work every
    // ~20 min; >45 min with no call means the loop (or the agent) is dead.
    {
      kind: 'staleness',
      key: 'loop.narrative_consolidation',
      label: 'Narrative-maintenance loop',
      maxMinutes: 45,
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
    // THROUGHPUT — a big drop vs the same window yesterday means the agent suddenly
    // went quiet (a feed died, or it's stuck). Seasonality-proof (same hour yesterday).
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
      suggestion: 'The agent is suppressing far more proactive turns than the same time yesterday — often a downstream symptom of a broken tool (it can\'t act, so it suppresses). Check recent tool failures.',
      windowMinutes: 180,
      direction: 'rise',
      minBaseline: 12,
      minChangePct: 1.0, // doubled vs same window yesterday
      index: 'll5_eval_moments',
      timestampField: 'timestamp',
      filter: [{ term: { decision: 'suppress' } }],
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
  ];
}
