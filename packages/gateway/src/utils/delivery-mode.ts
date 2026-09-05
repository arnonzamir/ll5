import type { Pool } from 'pg';
import type { Client } from '@elastic/elasticsearch';
import { logger } from './logger.js';
import { getLocationState } from '../processors/location.js';

/**
 * Delivery mode — the user's current state as it should shape what the agent
 * sends and how (DECISION-030, 2026-09-05). Computed by the gateway from
 * signals it already has, so the agent does not have to remember to check:
 *
 *   quiet_hours  local time inside the quiet window (default 23:30–06:30)
 *   sleep        phone sleep-classify says asleep (confidence ≥ 0.7, ≤ 20 min old)
 *   driving      location state says driving within the last 10 min
 *   meeting      a real (non-all-day, non-LL5-system) calendar event is in progress
 *   sick         the agent's own active_context user-model text says so
 *   normal       none of the above
 *
 * Precedence: sleep > quiet_hours > driving > meeting > sick > normal. The
 * channel MCP stamps the mode on every inbound envelope; POST /chat/messages
 * uses quiet_hours/sleep to HOLD non-critical proactive pushes until morning.
 */
export type DeliveryMode = 'sleep' | 'quiet_hours' | 'driving' | 'meeting' | 'sick' | 'normal';

export interface DeliveryModeResult {
  mode: DeliveryMode;
  reasons: string[];
  /** True when proactive, non-critical pushes should be held (sleep or quiet hours). */
  hold_pushes: boolean;
  /** ISO time the current hold window ends (next quiet-hours end), when hold_pushes. */
  release_at: string | null;
  computed_at: string;
}

export interface QuietHours { start: string; end: string } // "HH:MM" local, may wrap midnight
export const DEFAULT_QUIET_HOURS: QuietHours = { start: '23:30', end: '06:30' };
export const SICK_PATTERN = /\b(sick|fever|ill|flu|migraine|unwell|nauseous)\b|חולה|חום|שפעת/i;

function localHM(now: Date, tz: string): { h: number; m: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(now);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10);
  return { h: get('hour') % 24, m: get('minute') }; // ICU can print midnight as "24"
}
const toMin = (hm: string) => { const [h, m] = hm.split(':').map((x) => parseInt(x, 10)); return h * 60 + (m || 0); };

/** Pure: is `now` (in tz) inside the quiet window? Handles windows that wrap midnight. */
export function inQuietHours(now: Date, tz: string, q: QuietHours = DEFAULT_QUIET_HOURS): boolean {
  const { h, m } = localHM(now, tz);
  const cur = h * 60 + m, s = toMin(q.start), e = toMin(q.end);
  return s <= e ? cur >= s && cur < e : cur >= s || cur < e;
}

/** Pure: ISO instant of the next quiet-window end at/after `now` (local wall clock in tz). */
export function nextQuietEnd(now: Date, tz: string, q: QuietHours = DEFAULT_QUIET_HOURS): string {
  const { h, m } = localHM(now, tz);
  const cur = h * 60 + m, e = toMin(q.end);
  let minutesAhead = e - cur;
  if (minutesAhead <= 0) minutesAhead += 24 * 60;
  return new Date(now.getTime() + minutesAhead * 60_000).toISOString();
}

/** Pure: does the agent's active_context text say the user is unwell? */
export function looksSick(activeContext: unknown): boolean {
  if (!activeContext) return false;
  const text = typeof activeContext === 'string' ? activeContext : JSON.stringify(activeContext);
  return SICK_PATTERN.test(text);
}

/** Pure: pick the mode from the raw signals. */
export function pickMode(s: { quiet: boolean; asleep: boolean; driving: boolean; meeting: boolean; sick: boolean }): { mode: DeliveryMode; reasons: string[] } {
  const reasons: string[] = [];
  if (s.asleep) reasons.push('phone sleep-classify: asleep');
  if (s.quiet) reasons.push('quiet hours');
  if (s.driving) reasons.push('location: driving');
  if (s.meeting) reasons.push('calendar: event in progress');
  if (s.sick) reasons.push('user model active_context mentions illness');
  const mode: DeliveryMode = s.asleep ? 'sleep' : s.quiet ? 'quiet_hours' : s.driving ? 'driving' : s.meeting ? 'meeting' : s.sick ? 'sick' : 'normal';
  return { mode, reasons };
}

const CACHE = new Map<string, DeliveryModeResult>();
const CACHE_TTL_MS = 60_000;

export async function readQuietHours(pool: Pool, userId: string): Promise<QuietHours> {
  try {
    const r = await pool.query<{ s: string | null; e: string | null }>(
      `SELECT settings->>'quiet_hours_start' AS s, settings->>'quiet_hours_end' AS e FROM user_settings WHERE user_id = $1`,
      [userId],
    );
    const row = r.rows[0];
    const ok = (v: string | null | undefined) => !!v && /^\d{1,2}:\d{2}$/.test(v);
    return { start: ok(row?.s) ? row!.s! : DEFAULT_QUIET_HOURS.start, end: ok(row?.e) ? row!.e! : DEFAULT_QUIET_HOURS.end };
  } catch {
    return DEFAULT_QUIET_HOURS;
  }
}

/** Has the user written in chat within the last `minutes`? (Awake and talking → never hold.) */
export async function userActiveRecently(pool: Pool, userId: string, minutes = 30): Promise<boolean> {
  try {
    const r = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM chat_messages
        WHERE user_id = $1 AND role = 'user' AND created_at > now() - ($2 || ' minutes')::interval`,
      [userId, String(minutes)],
    );
    return parseInt(r.rows[0]?.n ?? '0', 10) > 0;
  } catch {
    return false;
  }
}

export async function computeDeliveryMode(pool: Pool, es: Client, userId: string, tz: string, now = new Date()): Promise<DeliveryModeResult> {
  const cached = CACHE.get(userId);
  if (cached && now.getTime() - new Date(cached.computed_at).getTime() < CACHE_TTL_MS) return cached;

  const q = await readQuietHours(pool, userId);
  const quiet = inQuietHours(now, tz, q);

  let asleep = false;
  try {
    const r = await es.search<{ confidence?: number; timestamp?: string }>({
      index: 'll5_awareness_sleep', size: 1, sort: [{ timestamp: { order: 'desc' } }],
      query: { bool: { filter: [{ term: { user_id: userId } }, { term: { kind: 'classify' } }, { range: { timestamp: { gte: 'now-20m' } } }] } },
    });
    const src = r.hits?.hits?.[0]?._source;
    asleep = typeof src?.confidence === 'number' && src.confidence >= 0.7;
  } catch (err) { logger.debug('[deliveryMode] sleep probe failed', { error: String(err) }); }

  let driving = false;
  try {
    const loc = await getLocationState(es, userId);
    driving = loc?.last_motion === 'driving' && typeof loc.last_pulse_at === 'number' && now.getTime() - loc.last_pulse_at < 10 * 60_000;
  } catch (err) { logger.debug('[deliveryMode] location probe failed', { error: String(err) }); }

  let meeting = false;
  try {
    const r = await es.count({
      index: 'll5_awareness_calendar_events',
      query: { bool: {
        filter: [{ term: { user_id: userId } }, { range: { start_time: { lte: now.toISOString() } } }, { range: { end_time: { gte: now.toISOString() } } }],
        must_not: [{ term: { all_day: true } }, { term: { kind: 'instruction' } }],
      } },
    });
    meeting = (r.count ?? 0) > 0;
  } catch (err) { logger.debug('[deliveryMode] calendar probe failed', { error: String(err) }); }

  let sick = false;
  try {
    const r = await es.get<{ content?: unknown }>({ index: 'll5_agent_user_model', id: `${userId}_active_context` });
    sick = looksSick(r._source?.content);
  } catch { /* no active_context yet */ }

  const picked = pickMode({ quiet, asleep, driving, meeting, sick });
  const hold = picked.mode === 'sleep' || picked.mode === 'quiet_hours';
  const result: DeliveryModeResult = {
    ...picked,
    hold_pushes: hold,
    release_at: hold ? nextQuietEnd(now, tz, q) : null,
    computed_at: now.toISOString(),
  };
  CACHE.set(userId, result);
  return result;
}

/** Test hook. */
export function resetDeliveryModeCache(): void { CACHE.clear(); }
