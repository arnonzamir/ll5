/**
 * Activity rail — pure composition (DECISION-034 Phase 2, §4).
 *
 * A view, not a store: one entry per handled proactive trigger, composed
 * from four sources the gateway already has.
 *
 *   trigger   the inbound chat row that started the turn (system / scheduler
 *             row, contact message, wake) — `trigger_id` is its id
 *   thought   `narrate` rows the channel stamped `metadata.rail=true` +
 *             `metadata.trigger_id`; fallback the moment's `reason`
 *   decision  the `[[moment]]` record in ll5_eval_moments: decision, reason,
 *             category, deferral_ref (+ trigger_id once the recorder ships it)
 *   journal   ll5_agent_journal entries of the same turn
 *   outcome   the classed message the turn produced (message_delivery row /
 *             chat row with metadata.class) → message_id, tray_item_id, class
 *
 * Composition rule (keying):
 *   1. Every rail row and every moment that carries `trigger_id` joins the
 *      group of that trigger.
 *   2. A moment WITHOUT trigger_id joins the nearest trigger group whose
 *      trigger row was created at or before the moment's timestamp within
 *      MATCH_WINDOW_MS and has no moment yet (the eval record's `ts` IS the
 *      trigger's timestamp, so the two are normally seconds apart);
 *      otherwise it becomes its own group.
 *   3. A group's turn window is [start, end): start = the trigger row's
 *      created_at (else the moment's ts, else the first rail row); end = the
 *      next moment in the same session, capped at TURN_MAX_MS, else start +
 *      TURN_MAX_MS.
 *   4. Journal entries and classed messages are attached to the group whose
 *      window contains them; journal entries prefer a session_id match.
 *   5. Entries are sorted newest first; `next_cursor` is the `at` of the last
 *      entry (opaque to the caller).
 */

export interface MomentDoc {
  id: string;
  timestamp: string;
  session_id?: string | null;
  trigger_id?: string | null;
  trigger_class?: string | null;
  source?: string | null;
  decision?: string | null;
  reason?: string | null;
  category?: string | null;
  deferral_ref?: string | null;
  produced_message_id?: string | null;
}

export interface ChatRowDoc {
  id: string;
  role: string;
  channel: string;
  content: string;
  created_at: string | Date;
  metadata: Record<string, unknown> | null;
}

export interface JournalDoc {
  id: string;
  created_at: string;
  session_id?: string | null;
  topic?: string | null;
  content?: string | null;
  type?: string | null;
}

export interface DeliveryDoc {
  message_id: string;
  tray_item_id: string | null;
  class: string;
  created_at: string | Date;
}

export interface TurnCostDoc {
  id: string;
  session_id?: string | null;
  timestamp: string;
  cost_usd?: number | null;
}

export type RailDecision = 'ping_now' | 'ping_later' | 'suppress';

export interface ActivityEntry {
  id: string;
  at: string;
  trigger: { id: string | null; kind: string | null; summary: string | null };
  thought: string | null;
  decision: RailDecision | null;
  reason: string | null;
  category: string | null;
  outcome: { message_id?: string; tray_item_id?: string; deferral_ref?: string; class?: string };
  journal?: { id: string; topic: string | null; content: string | null } | null;
  cost_usd?: number;
}

export const MATCH_WINDOW_MS = 30 * 60_000;
export const TURN_MAX_MS = 30 * 60_000;
export const SUMMARY_MAX = 160;

interface Group {
  key: string;
  trigger: ChatRowDoc | null;
  moment: MomentDoc | null;
  rail: ChatRowDoc[];
  start: number;
  end: number;
}

const ms = (d: string | Date) => new Date(d).getTime();
const firstLine = (s: string) => s.replace(/\r/g, '').trim().split('\n')[0]?.trim() ?? '';
const clip = (s: string, n = SUMMARY_MAX) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

function isRailRow(r: ChatRowDoc): boolean {
  const m = r.metadata ?? {};
  return m.rail === true || m.rail === 'true';
}

function triggerKind(row: ChatRowDoc | null, moment: MomentDoc | null): string | null {
  if (row) {
    const m = row.metadata ?? {};
    if (typeof m.scheduler === 'string') return m.scheduler;
    const src = m.source as { platform?: string } | undefined;
    if (src && typeof src.platform === 'string') return src.platform;
    if (row.role === 'user') return 'user';
    return row.channel || null;
  }
  return moment?.trigger_class ?? moment?.source ?? null;
}

function triggerSummary(row: ChatRowDoc | null, moment: MomentDoc | null): string | null {
  if (row) {
    const line = firstLine(row.content).replace(/\[event_id: [^\]]+\]/g, '').trim();
    return line ? clip(line) : null;
  }
  if (moment?.source || moment?.trigger_class) return [moment.trigger_class, moment.source].filter(Boolean).join(' · ');
  return null;
}

function asDecision(v: unknown): RailDecision | null {
  return v === 'ping_now' || v === 'ping_later' || v === 'suppress' ? v : null;
}

export interface ComposeInput {
  moments: MomentDoc[];
  /** Rail rows, classed assistant rows and the trigger rows referenced by trigger_id. */
  chatRows: ChatRowDoc[];
  journal: JournalDoc[];
  deliveries: DeliveryDoc[];
  costs?: TurnCostDoc[];
}

export function composeActivity(input: ComposeInput): ActivityEntry[] {
  const rows = new Map(input.chatRows.map((r) => [r.id, r]));
  const groups = new Map<string, Group>();
  const ensure = (key: string): Group => {
    let g = groups.get(key);
    if (!g) { g = { key, trigger: null, moment: null, rail: [], start: NaN, end: NaN }; groups.set(key, g); }
    return g;
  };

  // 1. rail rows + moments with a trigger id
  for (const r of input.chatRows) {
    if (!isRailRow(r)) continue;
    const tid = r.metadata?.trigger_id;
    const key = typeof tid === 'string' && tid ? tid : `rail:${r.id}`;
    const g = ensure(key);
    g.rail.push(r);
    if (!g.trigger && typeof tid === 'string') g.trigger = rows.get(tid) ?? null;
  }
  const loose: MomentDoc[] = [];
  for (const m of input.moments) {
    if (m.trigger_id) {
      const g = ensure(m.trigger_id);
      if (!g.moment || ms(m.timestamp) > ms(g.moment.timestamp)) g.moment = m;
      if (!g.trigger) g.trigger = rows.get(m.trigger_id) ?? null;
    } else {
      loose.push(m);
    }
  }
  // 2. moments without a trigger id → nearest preceding trigger group
  for (const m of loose.sort((a, b) => ms(a.timestamp) - ms(b.timestamp))) {
    const t = ms(m.timestamp);
    let best: Group | null = null;
    let bestGap = Infinity;
    for (const g of groups.values()) {
      if (g.moment) continue;
      const at = g.trigger ? ms(g.trigger.created_at) : g.rail[0] ? ms(g.rail[0].created_at) : NaN;
      if (!Number.isFinite(at)) continue;
      const gap = t - at;
      if (gap >= -60_000 && gap <= MATCH_WINDOW_MS && Math.abs(gap) < bestGap) { best = g; bestGap = Math.abs(gap); }
    }
    if (best) best.moment = m;
    else ensure(`moment:${m.id}`).moment = m;
  }

  // 3. windows
  const bySession = new Map<string, number[]>();
  for (const m of input.moments) {
    if (!m.session_id) continue;
    (bySession.get(m.session_id) ?? bySession.set(m.session_id, []).get(m.session_id)!).push(ms(m.timestamp));
  }
  for (const list of bySession.values()) list.sort((a, b) => a - b);
  for (const g of groups.values()) {
    g.rail.sort((a, b) => ms(a.created_at) - ms(b.created_at));
    const start = g.trigger ? ms(g.trigger.created_at) : g.moment ? ms(g.moment.timestamp) : ms(g.rail[0].created_at);
    let end = start + TURN_MAX_MS;
    const sid = g.moment?.session_id;
    if (sid) {
      // The next moment of the same session AFTER this group's own (the
      // recorder's ts is the trigger time, a few seconds after the row).
      const own = g.moment ? ms(g.moment.timestamp) : start;
      const next = (bySession.get(sid) ?? []).find((t) => t > Math.max(start, own));
      if (next !== undefined) end = Math.min(end, next);
    }
    g.start = start;
    g.end = end;
  }

  // 4. attach journal + outcome
  const deliveriesByMessage = new Map(input.deliveries.map((d) => [d.message_id, d]));
  const classed = input.chatRows
    .filter((r) => r.role === 'assistant' && !isRailRow(r) && typeof r.metadata?.class === 'string')
    .sort((a, b) => ms(a.created_at) - ms(b.created_at));
  const journal = [...input.journal].sort((a, b) => ms(a.created_at) - ms(b.created_at));
  const costs = input.costs ?? [];

  const entries: ActivityEntry[] = [];
  for (const g of groups.values()) {
    const m = g.moment;
    const inWindow = (t: number) => t >= g.start && t < g.end;
    const thoughtRow = g.rail[g.rail.length - 1];
    const thought = thoughtRow ? clip(firstLine(thoughtRow.content), 400) : m?.reason ? clip(m.reason, 400) : null;

    const outcome: ActivityEntry['outcome'] = {};
    const produced = m?.produced_message_id ? rows.get(m.produced_message_id) ?? null : null;
    const msgRow = produced ?? classed.find((r) => inWindow(ms(r.created_at))) ?? null;
    if (msgRow) {
      outcome.message_id = msgRow.id;
      const d = deliveriesByMessage.get(msgRow.id);
      const cls = d?.class ?? (typeof msgRow.metadata?.class === 'string' ? (msgRow.metadata.class as string) : undefined);
      if (cls) outcome.class = cls;
      if (d?.tray_item_id) outcome.tray_item_id = d.tray_item_id;
    } else if (m?.produced_message_id) {
      outcome.message_id = m.produced_message_id;
      const d = deliveriesByMessage.get(m.produced_message_id);
      if (d) { outcome.class = d.class; if (d.tray_item_id) outcome.tray_item_id = d.tray_item_id; }
    }
    if (m?.deferral_ref) outcome.deferral_ref = m.deferral_ref;

    const sid = m?.session_id ?? null;
    const j = journal.find((e) => inWindow(ms(e.created_at)) && (!sid || !e.session_id || e.session_id === sid))
      ?? null;
    const cost = sid ? costs.find((c) => c.session_id === sid && inWindow(ms(c.timestamp)))?.cost_usd : undefined;

    entries.push({
      id: g.key,
      at: new Date(g.start).toISOString(),
      trigger: { id: g.trigger?.id ?? (m?.trigger_id ?? null), kind: triggerKind(g.trigger, m), summary: triggerSummary(g.trigger, m) },
      thought,
      decision: asDecision(m?.decision),
      reason: m?.reason ?? null,
      category: m?.category ?? null,
      outcome,
      journal: j ? { id: j.id, topic: j.topic ?? null, content: j.content ? clip(j.content, 400) : null } : null,
      ...(typeof cost === 'number' ? { cost_usd: cost } : {}),
    });
  }
  return entries.sort((a, b) => ms(b.at) - ms(a.at));
}

/** Opaque cursor: the `at` of the last entry, base64url. */
export function encodeCursor(at: string): string {
  return Buffer.from(at, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): string | null {
  if (!cursor) return null;
  try {
    const s = Buffer.from(cursor, 'base64url').toString('utf8');
    return Number.isFinite(Date.parse(s)) ? new Date(s).toISOString() : null;
  } catch {
    return null;
  }
}
