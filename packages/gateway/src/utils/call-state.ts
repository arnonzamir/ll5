/**
 * Phone-call state machine (2026-09-08). Pure reducer + a per-user in-memory
 * registry, so delivery-mode can answer "is the user on a call right now"
 * without an ES round trip and processors/phone-call.ts can build the one
 * document per call as the phone reports ringing → offhook → idle.
 *
 *   ringing  incoming call, not yet answered
 *   offhook  a call is active (incoming answered, or outgoing from dial)
 *   idle     the call ended; `missed` when an incoming call was never answered
 *
 * Missed detection: the phone says `direction: 'missed'` on the final idle; as
 * a backstop a ringing → idle with no offhook in between is missed too (older
 * builds do not label it). A session older than ON_CALL_STALE_MS is treated as
 * over (a lost `idle` push must not leave the user "on a call" forever).
 * Restart = registry reset; acceptable for a 3 h-bounded signal.
 */

export type CallPhase = 'ringing' | 'offhook' | 'idle';
export type CallDirection = 'incoming' | 'outgoing' | 'missed';

export const ON_CALL_STALE_MS = 3 * 60 * 60_000;

export interface CallEvent {
  state: CallPhase;
  direction?: CallDirection | null;
  number?: string | null;
  contact_name?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  duration_s?: number | null;
  call_log_id?: string | null;
  timestamp?: string | null;
}

/** What we know about the call in flight (or the one that just ended). */
export interface CallSession {
  phase: CallPhase;
  /** Epoch ms of the last transition (staleness clock). */
  since: number;
  started_at: string;
  ended_at: string | null;
  duration_s: number | null;
  number: string | null;
  contact_name: string | null;
  direction: CallDirection | null;
  call_log_id: string | null;
  /** True once the call went through offhook (it was answered / connected). */
  answered: boolean;
}

export interface CallTransition {
  /** The session after this event: null once the call is over. */
  next: CallSession | null;
  /** The call this event describes, to upsert; null when there is nothing to record. */
  record: CallSession | null;
  /** True on the idle that ends an unanswered incoming call. */
  missed: boolean;
  /** True when a stale session was discarded before applying the event. */
  staleReset: boolean;
}

function isoOf(ms: number): string { return new Date(ms).toISOString(); }

function eventTime(ev: CallEvent, nowMs: number): string {
  return ev.timestamp ?? isoOf(nowMs);
}

/** Is a session stale (older than ON_CALL_STALE_MS since its last transition)? */
export function isStale(session: CallSession | null, nowMs: number): boolean {
  return !!session && nowMs - session.since > ON_CALL_STALE_MS;
}

/** Pure: is the user on a call according to `session` at `nowMs`? */
export function isOnCall(session: CallSession | null, nowMs: number): boolean {
  return !!session && session.phase === 'offhook' && !isStale(session, nowMs);
}

/** Pure: apply one phone event to the previous session. */
export function reduceCall(prev: CallSession | null, ev: CallEvent, nowMs: number): CallTransition {
  const staleReset = isStale(prev, nowMs);
  const base = staleReset ? null : prev;

  if (ev.state === 'ringing') {
    const record: CallSession = {
      phase: 'ringing',
      since: nowMs,
      started_at: ev.started_at ?? eventTime(ev, nowMs),
      ended_at: null,
      duration_s: null,
      number: ev.number ?? null,
      contact_name: ev.contact_name ?? null,
      direction: ev.direction ?? 'incoming',
      call_log_id: ev.call_log_id ?? null,
      answered: false,
    };
    return { next: record, record, missed: false, staleReset };
  }

  if (ev.state === 'offhook') {
    // An offhook with no ringing before it is an outgoing call (or an answer we
    // missed the ringing of — the phone's direction wins when it says so).
    const record: CallSession = {
      phase: 'offhook',
      since: nowMs,
      started_at: base?.started_at ?? ev.started_at ?? eventTime(ev, nowMs),
      ended_at: null,
      duration_s: null,
      number: ev.number ?? base?.number ?? null,
      contact_name: ev.contact_name ?? base?.contact_name ?? null,
      direction: ev.direction ?? base?.direction ?? 'outgoing',
      call_log_id: ev.call_log_id ?? base?.call_log_id ?? null,
      answered: true,
    };
    return { next: record, record, missed: false, staleReset };
  }

  // idle
  if (!base && !ev.number && !ev.call_log_id) {
    // Nothing in flight and nothing identifying a call: a spurious idle.
    return { next: null, record: null, missed: false, staleReset };
  }
  const inferredMissed = !!base && base.phase === 'ringing' && !base.answered;
  const direction: CallDirection | null = ev.direction ?? (inferredMissed ? 'missed' : base?.direction ?? null);
  const endedAt = ev.ended_at ?? eventTime(ev, nowMs);
  const startedAt = base?.started_at ?? ev.started_at ?? endedAt;
  const duration = ev.duration_s ?? (base?.answered
    ? Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000))
    : null);
  const record: CallSession = {
    phase: 'idle',
    since: nowMs,
    started_at: startedAt,
    ended_at: endedAt,
    duration_s: Number.isFinite(duration as number) ? duration : null,
    number: ev.number ?? base?.number ?? null,
    contact_name: ev.contact_name ?? base?.contact_name ?? null,
    direction,
    call_log_id: ev.call_log_id ?? base?.call_log_id ?? null,
    answered: base?.answered ?? (direction !== 'missed' && direction !== null),
  };
  return { next: null, record, missed: direction === 'missed', staleReset };
}

// ---------------------------------------------------------------------------
// Per-user registry (module state; battery-alert.ts idiom)
// ---------------------------------------------------------------------------

const sessions = new Map<string, CallSession>();

export function applyCallEvent(userId: string, ev: CallEvent, nowMs = Date.now()): CallTransition {
  const t = reduceCall(sessions.get(userId) ?? null, ev, nowMs);
  if (t.next) sessions.set(userId, t.next); else sessions.delete(userId);
  return t;
}

export interface OnCallState {
  since: string;
  number: string | null;
  contact_name: string | null;
}

/** The delivery-mode signal: non-null while the user is on a call (not stale). */
export function getOnCallState(userId: string, nowMs = Date.now()): OnCallState | null {
  const s = sessions.get(userId) ?? null;
  if (!isOnCall(s, nowMs)) return null;
  return { since: s!.started_at, number: s!.number, contact_name: s!.contact_name };
}

/** Test hook. */
export function resetCallState(): void { sessions.clear(); }
