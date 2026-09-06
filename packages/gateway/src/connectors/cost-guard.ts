/**
 * Connector cost guard — the fan-out cap for rule-hit triggers
 * (docs/design/connectors.md, Section 6, ladder step 2; the ISS-033 lesson).
 *
 * Per (user, connector), per clock hour:
 *   - the first `maxPerHour` rule hits go out as their own system message ('immediate');
 *   - the overflow is buffered into one GroupCoalescer window ('coalesce') that
 *     delivers a single burst message;
 *   - once that burst has been flushed, nothing more is immediate this hour
 *     ('digest_only') — the events are still stored and land in the daily digest.
 *
 * `decide()` is the pure decision (exported for tests, mutates the state it is
 * given); `ConnectorCostGuard` keeps the per-key state in memory, like
 * battery-alert.ts. Restart = counters reset; acceptable for a cap.
 * Day counters are UTC-day buckets and feed the `connector.fanout` alert.
 */
export type ImmediateDecision = 'immediate' | 'coalesce' | 'digest_only';

export interface CostGuardState {
  hourBucket: number;
  immediateThisHour: number;
  burstsFlushedThisHour: number;
  dayBucket: number;
  immediateToday: number;
  coalescedToday: number;
  digestOnlyToday: number;
}

export const DEFAULT_IMMEDIATE_MAX_PER_HOUR = 3;
/** connector.fanout tripwire (Section 8): immediate messages per connector per day. */
export const FANOUT_ALERT_PER_DAY = 10;

export function newCostGuardState(now = Date.now()): CostGuardState {
  return {
    hourBucket: Math.floor(now / 3_600_000),
    immediateThisHour: 0,
    burstsFlushedThisHour: 0,
    dayBucket: Math.floor(now / 86_400_000),
    immediateToday: 0,
    coalescedToday: 0,
    digestOnlyToday: 0,
  };
}

function roll(state: CostGuardState, now: number): void {
  const hour = Math.floor(now / 3_600_000);
  if (hour !== state.hourBucket) {
    state.hourBucket = hour;
    state.immediateThisHour = 0;
    state.burstsFlushedThisHour = 0;
  }
  const day = Math.floor(now / 86_400_000);
  if (day !== state.dayBucket) {
    state.dayBucket = day;
    state.immediateToday = 0;
    state.coalescedToday = 0;
    state.digestOnlyToday = 0;
  }
}

/** Decide how one rule hit is delivered and account for it. Pure apart from mutating `state`. */
export function decide(state: CostGuardState, now: number, maxPerHour = DEFAULT_IMMEDIATE_MAX_PER_HOUR): ImmediateDecision {
  roll(state, now);
  if (state.immediateThisHour < maxPerHour) {
    state.immediateThisHour += 1;
    state.immediateToday += 1;
    return 'immediate';
  }
  if (state.burstsFlushedThisHour === 0) {
    state.coalescedToday += 1;
    return 'coalesce';
  }
  state.digestOnlyToday += 1;
  return 'digest_only';
}

/** The coalescer delivered its burst for this key — no more immediates this hour. */
export function noteBurstFlushed(state: CostGuardState, now: number): void {
  roll(state, now);
  state.burstsFlushedThisHour += 1;
  state.immediateToday += 1;
}

export interface CostGuardStats {
  key: string;
  immediate_this_hour: number;
  immediate_today: number;
  coalesced_today: number;
  digest_only_today: number;
}

export class ConnectorCostGuard {
  private readonly states = new Map<string, CostGuardState>();
  constructor(private readonly maxPerHour: number = DEFAULT_IMMEDIATE_MAX_PER_HOUR) {}

  static key(userId: string, connectorId: string): string { return `${userId}:connector:${connectorId}`; }

  private state(key: string, now: number): CostGuardState {
    let s = this.states.get(key);
    if (!s) { s = newCostGuardState(now); this.states.set(key, s); }
    return s;
  }

  decide(userId: string, connectorId: string, now = Date.now()): ImmediateDecision {
    return decide(this.state(ConnectorCostGuard.key(userId, connectorId), now), now, this.maxPerHour);
  }

  noteBurstFlushed(userId: string, connectorId: string, now = Date.now()): void {
    noteBurstFlushed(this.state(ConnectorCostGuard.key(userId, connectorId), now), now);
  }

  immediateToday(userId: string, connectorId: string, now = Date.now()): number {
    const s = this.state(ConnectorCostGuard.key(userId, connectorId), now);
    roll(s, now);
    return s.immediateToday;
  }

  stats(): CostGuardStats[] {
    return Array.from(this.states.entries()).map(([key, s]) => ({
      key,
      immediate_this_hour: s.immediateThisHour,
      immediate_today: s.immediateToday,
      coalesced_today: s.coalescedToday,
      digest_only_today: s.digestOnlyToday,
    }));
  }

  reset(): void { this.states.clear(); }
}
