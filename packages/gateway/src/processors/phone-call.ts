/**
 * Phone-call processor (2026-09-08). One `phone_call` item per telephony state
 * transition → one ll5_awareness_calls doc per call (upsert), the in-memory
 * "on a call" signal for delivery mode (utils/call-state.ts), and on a missed
 * call a `missed_call` notable event. No system message unless the caller is a
 * known person whose contact_settings routing is immediate/agent — the same
 * resolver WhatsApp uses, keyed by the person the phone number resolves to.
 *
 * Contact resolution: the phone sends `contact_name` when the number is in the
 * address book; when it does not, we look the number up in messaging_contacts
 * (phone_number or WhatsApp JID), which also yields the linked KB person_id.
 */
import type { Client } from '@elastic/elasticsearch';
import crypto from 'node:crypto';
import type { Pool } from 'pg';
import type { PushPhoneCallItem } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { insertSystemMessage, createSchedulerEvent } from '../utils/system-message.js';
import { getEffectiveTimezone } from '../utils/timezone.js';
import { applyCallEvent, type CallSession } from '../utils/call-state.js';
import { writeNotableEvent } from './notable.js';
import { normalizePhone } from './phone-contacts.js';
import type { ContactRoutingResolver } from './contact-routing.js';

export const CALLS_INDEX = 'll5_awareness_calls';

/** Pure: the upsert key — call_log_id when the phone has one, else started_at + number. */
export function callDocId(userId: string, call: Pick<CallSession, 'call_log_id' | 'started_at' | 'number'>): string {
  // started_at + number is stable across ringing → offhook → idle (the session
  // keeps the first started_at), and the call log id arrives only on idle —
  // so the session key wins whenever the session knows a number.
  const key = call.number
    ? `s:${call.started_at}:${call.number}`
    : call.call_log_id
      ? `l:${call.call_log_id}`
      : `s:${call.started_at}`;
  return crypto.createHash('sha256').update(`${userId}:call:${key}`).digest('hex').slice(0, 32);
}

export interface ResolvedContact { displayName: string | null; personId: string | null }

/** messaging_contacts lookup by phone number (or WhatsApp JID). {null,null} when unknown. */
export async function lookupContactByPhone(pool: Pool, userId: string, number: string): Promise<ResolvedContact> {
  const variants = normalizePhone(number);
  if (variants.length === 0) return { displayName: null, personId: null };
  const phones = variants.flatMap((v) => [v, `+${v}`]);
  const jids = variants.flatMap((v) => [`${v}@s.whatsapp.net`, `${v}@lid`]);
  try {
    const r = await pool.query<{ display_name: string | null; person_id: string | null }>(
      `SELECT display_name, person_id FROM messaging_contacts
        WHERE user_id = $1 AND (phone_number = ANY($2) OR platform_id = ANY($3))
        ORDER BY (person_id IS NOT NULL) DESC, last_seen_at DESC NULLS LAST
        LIMIT 1`,
      [userId, phones, jids],
    );
    const row = r.rows[0];
    if (!row) return { displayName: null, personId: null };
    const name = row.display_name && !/^\+?[0-9][0-9 \-()]+$/.test(row.display_name) && !row.display_name.includes('@') ? row.display_name : null;
    return { displayName: name, personId: row.person_id ?? null };
  } catch (err) {
    logger.warn('[phone-call][lookup] contact lookup failed (non-critical)', { error: err instanceof Error ? err.message : String(err) });
    return { displayName: null, personId: null };
  }
}

function fmtTime(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}

/** Pure: the agent-facing missed-call line. */
export function renderMissedCall(name: string | null, number: string | null, at: string, tz: string): string {
  const who = name ? `${name}${number ? ` (${number})` : ''}` : number ?? 'unknown number';
  return `[Call] Missed call from ${who} at ${fmtTime(at, tz)}`;
}

export async function processPhoneCall(
  es: Client,
  pool: Pool | undefined,
  userId: string,
  item: PushPhoneCallItem,
  matcher?: ContactRoutingResolver,
  now = Date.now(),
): Promise<void> {
  const t = applyCallEvent(userId, item, now);
  if (t.staleReset) logger.info('[phone-call][state] stale call session discarded', { userId });
  const call = t.record;
  if (!call) {
    logger.debug('[phone-call][state] idle with nothing in flight, ignored', { userId });
    return;
  }

  // Resolve the number against known contacts (name when the phone sent none,
  // person_id for routing either way).
  let contactName = call.contact_name;
  let personId: string | null = null;
  if (pool && call.number) {
    const resolved = await lookupContactByPhone(pool, userId, call.number);
    personId = resolved.personId;
    if (!contactName) contactName = resolved.displayName;
  }

  const id = callDocId(userId, call);
  const doc: Record<string, unknown> = {
    user_id: userId,
    state: call.phase,
    direction: call.direction,
    number: call.number,
    contact_name: contactName,
    person_id: personId,
    known_contact: !!(personId || contactName),
    started_at: call.started_at,
    ended_at: call.ended_at,
    duration_s: call.duration_s,
    call_log_id: call.call_log_id,
    updated_at: new Date(now).toISOString(),
  };
  await es.update({ index: CALLS_INDEX, id, doc, doc_as_upsert: true, refresh: false });
  logger.info('[phone-call][store] call state stored', {
    userId, state: call.phase, direction: call.direction, known: !!(personId || contactName), missed: t.missed,
  });

  if (!t.missed) return;

  const at = call.ended_at ?? new Date(now).toISOString();
  await writeNotableEvent(es, userId, {
    event_type: 'missed_call',
    timestamp: at,
    summary: `Missed call from ${contactName ?? call.number ?? 'unknown number'}`,
    severity: personId ? 'medium' : 'low',
    payload: { number: call.number, contact_name: contactName, person_id: personId, call_log_id: call.call_log_id },
  });

  // System message only when the person's own routing asks for it.
  if (!pool || !matcher || !personId) return;
  const settings = await matcher.getContactSettings(userId, 'person', personId);
  if (settings?.routing !== 'immediate' && settings?.routing !== 'agent') return;
  const tz = await getEffectiveTimezone(pool, userId).catch(() => 'Asia/Jerusalem');
  await insertSystemMessage(pool, userId, renderMissedCall(contactName, call.number, at, tz), undefined, createSchedulerEvent('missed_call'));
  logger.info('[phone-call][missed] system message (contact routing)', { userId, person_id: personId, routing: settings.routing });
}
