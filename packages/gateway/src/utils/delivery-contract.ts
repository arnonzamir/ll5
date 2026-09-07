import type { NotificationLevel } from './fcm-sender.js';
import type { DeliveryMode } from './delivery-mode.js';

/**
 * Delivery contract — pure logic (DECISION-034, Phase 1).
 *
 * The agent declares a class on every proactive message; the gateway
 * re-validates the block here (so a hand-crafted POST cannot bypass the
 * channel tool), maps stakes to a push level, plans the do-by escalation
 * ladder and decides, tick by tick, which rung is due. Nothing in this file
 * touches the database — the side effects live in `src/delivery.ts` and the
 * `delivery-escalation` scheduler.
 */

export type DeliveryClass = 'fyi' | 'needs-you' | 'do-by';
export type Stakes = 'low' | 'medium' | 'high' | 'critical';
export type Rung = 'repush' | 'alarm' | 'reach';
export type EscalationPreset = 'standard' | 'gentle' | 'none';
export interface EscalationStep { offset_minutes: number; rung: Rung }
export type EscalationSpec = EscalationPreset | EscalationStep[];
export type Modality = 'chat' | 'push_silent' | 'push_notify' | 'push_alert' | 'push_alarm' | 'reach';

export const DELIVERY_CLASSES: readonly DeliveryClass[] = ['fyi', 'needs-you', 'do-by'];
export const STAKES: readonly Stakes[] = ['low', 'medium', 'high', 'critical'];
export const RUNGS: readonly Rung[] = ['repush', 'alarm', 'reach'];
export const SUBJECT_MAX = 40;
/** The subject must appear inside this many leading characters of the content. */
export const SUBJECT_WINDOW = 80;
/** Matches DECISION_EXPIRES_MAX_DAYS in tray.ts. */
export const DUE_MAX_DAYS = 14;
/** An ask still open this long after due_at is missed (do-by) / expired (needs-you). */
export const MISS_GRACE_MS = 30 * 60_000;

/** Phase 1 initial push level by stakes — a fixed map; learning is Phase 4. */
export const LEVEL_BY_STAKES: Record<Stakes, NotificationLevel> = {
  low: 'silent',
  medium: 'notify',
  high: 'alert',
  critical: 'critical',
};

const LEVEL_RANK: Record<NotificationLevel, number> = { silent: 0, notify: 1, alert: 2, critical: 3 };

export function maxLevel(a: NotificationLevel, b: NotificationLevel | undefined | null): NotificationLevel {
  if (!b) return a;
  return LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a;
}

export function modalityForLevel(level: NotificationLevel | null): Modality {
  switch (level) {
    case 'silent': return 'push_silent';
    case 'notify': return 'push_notify';
    case 'alert': return 'push_alert';
    case 'critical': return 'push_alarm';
    default: return 'chat';
  }
}

/** The validated, normalised delivery block stored with the message. */
export interface DeliveryBlock {
  class: DeliveryClass;
  subject: string | null;
  due_at: string | null;
  stakes: Stakes | null;
  ack_required: boolean;
  escalation: EscalationSpec;
}

export interface ValidateInput {
  /** The raw `delivery` object from the request body (may be undefined). */
  delivery: unknown;
  content: string;
  proactive: boolean;
  /** The request's own notification_level — DECISION-030's critical marker. */
  notification_level?: NotificationLevel | null;
  now: Date;
}

export type ValidateResult =
  | { ok: true; delivery: DeliveryBlock | null; notes: string[] }
  | { ok: false; error: string };

/**
 * Case-fold and strip everything that is not a letter or digit so "Card
 * pickup, 17 HaNadiv" matches "card pickup 17 hanadiv" and Hebrew niqqud
 * never breaks a match.
 */
export function normalizeForMatch(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[֑-ׇ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function subjectLeads(subject: string, content: string): boolean {
  const head = normalizeForMatch(content.slice(0, SUBJECT_WINDOW));
  const needle = normalizeForMatch(subject);
  return needle.length > 0 && head.includes(needle);
}

function parseEscalation(raw: unknown, cls: DeliveryClass): { ok: true; spec: EscalationSpec } | { ok: false; error: string } {
  if (raw == null) return { ok: true, spec: cls === 'do-by' ? 'standard' : 'none' };
  if (raw === 'standard' || raw === 'gentle' || raw === 'none') {
    if (cls === 'do-by' && raw === 'none') return { ok: false, error: "delivery.escalation 'none' is not allowed on a do-by (use needs-you)" };
    return { ok: true, spec: raw };
  }
  if (Array.isArray(raw)) {
    if (raw.length === 0) return { ok: false, error: 'delivery.escalation array must not be empty' };
    const steps: EscalationStep[] = [];
    for (const s of raw as unknown[]) {
      const o = s as { offset_minutes?: unknown; rung?: unknown } | null;
      if (o == null || typeof o !== 'object' || typeof o.offset_minutes !== 'number' || !Number.isFinite(o.offset_minutes)
        || typeof o.rung !== 'string' || !(RUNGS as readonly string[]).includes(o.rung)) {
        return { ok: false, error: 'delivery.escalation steps must be {offset_minutes: number, rung: repush|alarm|reach}' };
      }
      steps.push({ offset_minutes: o.offset_minutes, rung: o.rung as Rung });
    }
    return { ok: true, spec: steps };
  }
  return { ok: false, error: "delivery.escalation must be 'standard' | 'gentle' | 'none' | [{offset_minutes, rung}]" };
}

/**
 * Validate the `delivery` block of POST /chat/messages. Returns the
 * normalised block (or null when no block was given on a non-proactive
 * message) and notes to echo back (e.g. a stakes downgrade).
 */
export function validateDeliveryBlock(input: ValidateInput): ValidateResult {
  const { delivery, content, proactive, now } = input;
  const notes: string[] = [];

  if (delivery == null) {
    if (proactive) return { ok: false, error: 'delivery.class is required on a proactive message (fyi / needs-you / do-by)' };
    return { ok: true, delivery: null, notes };
  }
  if (typeof delivery !== 'object') return { ok: false, error: 'delivery must be an object' };
  const d = delivery as Record<string, unknown>;

  const cls = d.class;
  if (typeof cls !== 'string' || !(DELIVERY_CLASSES as readonly string[]).includes(cls)) {
    return { ok: false, error: 'delivery.class must be one of: fyi, needs-you, do-by' };
  }
  const klass = cls as DeliveryClass;
  const isAsk = klass !== 'fyi';

  // subject
  let subject: string | null = null;
  if (d.subject != null) {
    if (typeof d.subject !== 'string') return { ok: false, error: 'delivery.subject must be a string' };
    subject = d.subject.replace(/\s+/g, ' ').trim();
    if (subject.length === 0) subject = null;
  }
  if (isAsk && !subject) return { ok: false, error: `delivery.subject is required on a ${klass}` };
  if (subject && subject.length > SUBJECT_MAX) return { ok: false, error: `delivery.subject must be at most ${SUBJECT_MAX} characters` };
  if (subject && !subjectLeads(subject, content)) {
    return { ok: false, error: `delivery.subject must open the message (appear within the first ${SUBJECT_WINDOW} characters of content)` };
  }

  // due_at
  let dueAt: string | null = null;
  if (d.due_at != null) {
    if (typeof d.due_at !== 'string' || Number.isNaN(Date.parse(d.due_at))) return { ok: false, error: 'delivery.due_at must be an ISO timestamp' };
    const due = new Date(d.due_at);
    if (due.getTime() <= now.getTime()) return { ok: false, error: 'delivery.due_at must be in the future' };
    if (due.getTime() > now.getTime() + DUE_MAX_DAYS * 86_400_000) return { ok: false, error: `delivery.due_at must be at most ${DUE_MAX_DAYS} days out` };
    dueAt = due.toISOString();
  }
  if (isAsk && !dueAt) {
    return {
      ok: false,
      error: klass === 'do-by'
        ? 'delivery.due_at is required: a do-by needs a deadline; if there is none it is needs-you or fyi'
        : 'delivery.due_at is required on a needs-you',
    };
  }

  // stakes
  let stakes: Stakes | null = null;
  if (d.stakes != null) {
    if (typeof d.stakes !== 'string' || !(STAKES as readonly string[]).includes(d.stakes)) {
      return { ok: false, error: 'delivery.stakes must be one of: low, medium, high, critical' };
    }
    stakes = d.stakes as Stakes;
  }
  if (isAsk && !stakes) stakes = 'medium';
  // DECISION-030: the gateway's critical rule is the message's own
  // notification_level === 'critical' (safety/family — the only thing that
  // bypasses the quiet-hours hold). stakes 'critical' without it is downgraded.
  if (stakes === 'critical' && input.notification_level !== 'critical') {
    stakes = 'high';
    notes.push("stakes downgraded to 'high': 'critical' requires notification_level 'critical' (DECISION-030 safety/family rule)");
  }

  // ack_required
  if (d.ack_required != null && typeof d.ack_required !== 'boolean') return { ok: false, error: 'delivery.ack_required must be a boolean' };
  if (klass === 'do-by' && d.ack_required === false) return { ok: false, error: 'a do-by requires acknowledgement (ack_required cannot be false)' };
  const ackRequired = klass === 'do-by' ? true : d.ack_required === true;

  // escalation
  const esc = parseEscalation(d.escalation, klass);
  if (!esc.ok) return esc;
  if (klass !== 'do-by' && esc.spec !== 'none') {
    notes.push(`escalation ignored: only a do-by has a ladder (class is ${klass})`);
  }

  return {
    ok: true,
    notes,
    delivery: {
      class: klass,
      subject,
      due_at: dueAt,
      stakes,
      ack_required: ackRequired,
      escalation: klass === 'do-by' ? esc.spec : 'none',
    },
  };
}

// ---------------------------------------------------------------------------
// Escalation ladder
// ---------------------------------------------------------------------------

export interface PlannedRung {
  rung: Rung;
  /** ISO instant the rung becomes due. */
  at: string;
  level: NotificationLevel;
  /** Set once sent. */
  sent_at?: string;
}

const MIN = 60_000;
const RUNG_ORDER: Record<Rung, number> = { repush: 0, alarm: 1, reach: 2 };

/** Push level per rung. `alarm`/`reach` ride on `alert` with data.rung set — the
 *  app picks the sound from the rung; the level stays below `critical` so the
 *  user's max-level cap and the quiet rule still apply. Critical stakes lift
 *  every rung to `critical`. */
export function rungLevel(rung: Rung, stakes: Stakes | null): NotificationLevel {
  if (stakes === 'critical') return 'critical';
  return 'alert';
}

/**
 * Pure: the rung schedule for a do-by.
 *   standard  re-push at max(sentAt + 10 min, due − 45 min), alarm at due − 15, reach at due − 5
 *   gentle    re-push only
 *   none      no rungs
 *   array     explicit {offset_minutes, rung}; offsets are relative to due_at (negative = before)
 * Times are clamped to be no earlier than sentAt and non-decreasing in rung
 * order, so a short deadline never schedules an alarm before its re-push.
 */
export function planRungs(spec: EscalationSpec, sentAt: Date, dueAt: Date, stakes: Stakes | null = null): PlannedRung[] {
  const sent = sentAt.getTime();
  const due = dueAt.getTime();
  let raw: Array<{ rung: Rung; t: number }>;
  if (spec === 'none') raw = [];
  else if (spec === 'gentle') raw = [{ rung: 'repush', t: Math.max(sent + 10 * MIN, due - 45 * MIN) }];
  else if (spec === 'standard') {
    raw = [
      { rung: 'repush', t: Math.max(sent + 10 * MIN, due - 45 * MIN) },
      { rung: 'alarm', t: due - 15 * MIN },
      { rung: 'reach', t: due - 5 * MIN },
    ];
  } else {
    raw = spec.map((s) => ({ rung: s.rung, t: due + s.offset_minutes * MIN }));
  }
  raw.sort((a, b) => RUNG_ORDER[a.rung] - RUNG_ORDER[b.rung] || a.t - b.t);
  let floor = sent;
  return raw.map((r) => {
    const t = Math.max(r.t, floor);
    floor = t;
    return { rung: r.rung, at: new Date(t).toISOString(), level: rungLevel(r.rung, stakes) };
  });
}

export interface LadderState {
  rungs: PlannedRung[];
  /** Count of rungs already sent (the first `rung_sent` entries). */
  rung_sent: number;
  acknowledged: boolean;
  stakes: Stakes | null;
}

export type NextRung =
  | { action: 'stop' }
  | { action: 'exhausted' }
  | { action: 'wait'; next_at: string }
  | { action: 'hold'; rung: PlannedRung; index: number }
  | { action: 'send'; rung: PlannedRung; index: number };

/**
 * Pure: what the scheduler should do with a ladder right now. Sends at most
 * ONE rung per call (the lowest unsent whose time has passed); in sleep /
 * quiet_hours a non-critical rung is held — the caller re-evaluates next tick.
 */
export function nextRung(state: LadderState, now: Date, mode: DeliveryMode): NextRung {
  if (state.acknowledged) return { action: 'stop' };
  const index = state.rung_sent;
  const rung = state.rungs[index];
  if (!rung) return { action: 'exhausted' };
  if (new Date(rung.at).getTime() > now.getTime()) return { action: 'wait', next_at: rung.at };
  const quiet = mode === 'sleep' || mode === 'quiet_hours';
  if (quiet && state.stakes !== 'critical') return { action: 'hold', rung, index };
  return { action: 'send', rung, index };
}

export function fmtLocalHHMM(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${String(parseInt(get('hour'), 10) % 24).padStart(2, '0')}:${get('minute')}`;
}

export function localHour(d: Date, tz: string): number {
  return parseInt(fmtLocalHHMM(d, tz).slice(0, 2), 10);
}

const RUNG_LABEL: Record<Rung, string> = { repush: 're-push', alarm: 'alarm', reach: 'reach' };

/**
 * Pure: the tray card's escalation-honesty line — the item's own future if
 * ignored. do-by: the unsent rungs ("re-push 08:40 · alarm 08:55 · reach 09:05");
 * needs-you (no ladder): when it expires.
 */
export function futureText(cls: DeliveryClass, rungs: PlannedRung[], rungSent: number, dueAt: Date, tz: string): string {
  const pending = rungs.slice(rungSent);
  if (cls === 'do-by' && pending.length > 0) {
    return pending.map((r) => `${RUNG_LABEL[r.rung]} ${fmtLocalHHMM(new Date(r.at), tz)}`).join(' · ');
  }
  const expires = new Date(dueAt.getTime() + MISS_GRACE_MS);
  return cls === 'do-by'
    ? `due ${fmtLocalHHMM(dueAt, tz)} · missed ${fmtLocalHHMM(expires, tz)} if not done`
    : `due ${fmtLocalHHMM(dueAt, tz)} · expires ${fmtLocalHHMM(expires, tz)}`;
}

export function timeLeftText(dueAt: Date, now: Date): string {
  const mins = Math.round((dueAt.getTime() - now.getTime()) / MIN);
  if (mins <= 0) return 'now';
  if (mins < 60) return `in ${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `in ${h}h ${m}m` : `in ${h}h`;
}
