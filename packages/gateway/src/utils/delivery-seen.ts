/**
 * Seen model — pure logic (DECISION-034 Phase 3).
 *
 * The app reports what the user actually saw (chat read position,
 * notification shown / opened / dismissed, tray card opened, feedback);
 * this file turns a batch of those events into (a) the new monotonic read
 * position and (b) the per-delivery column updates, and derives the unseen
 * count the envelope carries. The database side is `src/delivery-routes.ts`.
 *
 * Derivation rule: seen_at = the FIRST of notification_opened, tray_opened,
 * or the read position passing the message (chat_seen_up_to >= created_at,
 * in which case seen_at = the read position's time).
 */

export type DeliveryEventType =
  | 'chat_seen'
  | 'notification_shown'
  | 'notification_opened'
  | 'notification_dismissed'
  | 'tray_opened'
  | 'tray_feedback';

export const DELIVERY_EVENT_TYPES: readonly DeliveryEventType[] = [
  'chat_seen', 'notification_shown', 'notification_opened', 'notification_dismissed', 'tray_opened', 'tray_feedback',
];

export type Feedback = 'too_much' | 'not_enough' | 'ok';
export const FEEDBACK_VALUES: readonly Feedback[] = ['too_much', 'not_enough', 'ok'];

export interface DeliveryEvent {
  type: DeliveryEventType;
  /** ISO instant, clamped to `now` (a phone clock ahead of the server never moves the read position into the future). */
  at: string;
  message_id?: string;
  tray_item_id?: string;
  delivery_id?: string;
  feedback?: Feedback;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate the raw `events` array. Bad entries are dropped and counted, never
 * fatal: the phone batches, and one malformed item must not lose the rest.
 */
export function normalizeEvents(raw: unknown, now: Date): { events: DeliveryEvent[]; rejected: number } {
  if (!Array.isArray(raw)) return { events: [], rejected: 0 };
  const events: DeliveryEvent[] = [];
  let rejected = 0;
  for (const item of raw as unknown[]) {
    const o = item as Record<string, unknown> | null;
    if (!o || typeof o !== 'object') { rejected += 1; continue; }
    const type = o.type;
    if (typeof type !== 'string' || !(DELIVERY_EVENT_TYPES as readonly string[]).includes(type)) { rejected += 1; continue; }
    const atMs = typeof o.at === 'string' ? Date.parse(o.at) : NaN;
    if (!Number.isFinite(atMs)) { rejected += 1; continue; }
    const at = new Date(Math.min(atMs, now.getTime())).toISOString();
    const id = (k: string) => (typeof o[k] === 'string' && UUID_RE.test(o[k] as string) ? (o[k] as string) : undefined);
    const ev: DeliveryEvent = { type: type as DeliveryEventType, at };
    const messageId = id('message_id'), trayItemId = id('tray_item_id'), deliveryId = id('delivery_id');
    if (messageId) ev.message_id = messageId;
    if (trayItemId) ev.tray_item_id = trayItemId;
    if (deliveryId) ev.delivery_id = deliveryId;
    if (type !== 'chat_seen' && !messageId && !trayItemId && !deliveryId) { rejected += 1; continue; }
    if (type === 'tray_feedback') {
      if (typeof o.feedback !== 'string' || !(FEEDBACK_VALUES as readonly string[]).includes(o.feedback)) { rejected += 1; continue; }
      ev.feedback = o.feedback as Feedback;
    }
    events.push(ev);
  }
  return { events, rejected };
}

/** Pure: the read position only moves forward. */
export function foldReadState(current: string | null, events: DeliveryEvent[]): string | null {
  let best = current ? Date.parse(current) : -Infinity;
  for (const e of events) {
    if (e.type !== 'chat_seen') continue;
    const t = Date.parse(e.at);
    if (t > best) best = t;
  }
  return Number.isFinite(best) ? new Date(best).toISOString() : null;
}

/** Column updates for one delivery row. Every value is "first wins" except feedback (last wins). */
export interface DeliveryUpdate {
  target: { delivery_id?: string; message_id?: string; tray_item_id?: string };
  shown_at?: string;
  opened_at?: string;
  seen_at?: string;
  dismissed_at?: string;
  feedback?: Feedback;
}

const earliest = (a: string | undefined, b: string): string => (a && Date.parse(a) <= Date.parse(b) ? a : b);

function targetKey(e: DeliveryEvent): string {
  return e.delivery_id ? `d:${e.delivery_id}` : e.message_id ? `m:${e.message_id}` : `t:${e.tray_item_id}`;
}

/**
 * Pure: fold a batch into per-target updates. Idempotent by construction —
 * the SQL applies each field with COALESCE (first wins), so re-sending a
 * batch changes nothing.
 */
export function reduceDeliveryEvents(events: DeliveryEvent[]): DeliveryUpdate[] {
  const byTarget = new Map<string, DeliveryUpdate>();
  for (const e of events) {
    if (e.type === 'chat_seen') continue;
    const key = targetKey(e);
    let u = byTarget.get(key);
    if (!u) {
      u = { target: {} };
      if (e.delivery_id) u.target.delivery_id = e.delivery_id;
      else if (e.message_id) u.target.message_id = e.message_id;
      else if (e.tray_item_id) u.target.tray_item_id = e.tray_item_id;
      byTarget.set(key, u);
    }
    switch (e.type) {
      case 'notification_shown': u.shown_at = earliest(u.shown_at, e.at); break;
      case 'notification_opened': u.opened_at = earliest(u.opened_at, e.at); u.seen_at = earliest(u.seen_at, e.at); break;
      case 'notification_dismissed': u.dismissed_at = earliest(u.dismissed_at, e.at); break;
      case 'tray_opened': u.seen_at = earliest(u.seen_at, e.at); break;
      case 'tray_feedback': u.feedback = e.feedback; break;
    }
  }
  return [...byTarget.values()];
}

/** A delivery row as the derivation sees it. */
export interface SeenCandidate {
  created_at: string | Date;
  seen_at: string | Date | null;
  opened_at?: string | Date | null;
}

/**
 * Pure: the seen_at a row ends up with, given the read position and the
 * row's own opened/seen marks. Null when nothing has reached it.
 */
export function deriveSeenAt(row: SeenCandidate, chatSeenUpTo: string | null): string | null {
  const marks: number[] = [];
  if (row.seen_at) marks.push(new Date(row.seen_at).getTime());
  if (row.opened_at) marks.push(new Date(row.opened_at).getTime());
  if (chatSeenUpTo) {
    const pos = Date.parse(chatSeenUpTo);
    if (pos >= new Date(row.created_at).getTime()) marks.push(pos);
  }
  if (marks.length === 0) return null;
  return new Date(Math.min(...marks)).toISOString();
}

/** A chat row as the unseen count sees it. */
export interface UnseenCandidate {
  role: string;
  direction?: string;
  created_at: string | Date;
  metadata: Record<string, unknown> | null;
}

/** Pure: is this row one the user is expected to see? Assistant rows carrying
 *  a class (or a push level), never rail narration. */
export function countsAsUnseen(row: UnseenCandidate): boolean {
  if (row.role !== 'assistant') return false;
  if (row.direction && row.direction !== 'outbound') return false;
  const m = row.metadata ?? {};
  if (m.rail === true || m.rail === 'true') return false;
  return typeof m.class === 'string' || typeof m.notification_level === 'string';
}

/** Pure: assistant rows after the read position (all of them when there is none). */
export function unseenCount(rows: UnseenCandidate[], chatSeenUpTo: string | null): number {
  const pos = chatSeenUpTo ? Date.parse(chatSeenUpTo) : -Infinity;
  let n = 0;
  for (const r of rows) {
    if (!countsAsUnseen(r)) continue;
    if (new Date(r.created_at).getTime() > pos) n += 1;
  }
  return n;
}

/** "14m" / "3h" / "2d" / null — how long ago the user last saw the chat. */
export function seenAgeText(chatSeenUpTo: string | null, now: Date): string | null {
  if (!chatSeenUpTo) return null;
  const mins = Math.max(0, Math.round((now.getTime() - Date.parse(chatSeenUpTo)) / 60_000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
