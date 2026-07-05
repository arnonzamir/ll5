import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { logAudit } from '@ll5/shared';
import { chatAuthMiddleware } from './chat.js';
import { listPendingApprovals } from './approvals.js';
import { getEffectiveTimezone, startOfDayInTz } from './utils/timezone.js';
import { insertSystemMessage } from './utils/system-message.js';
import { logger } from './utils/logger.js';

/**
 * "Needs You" tray plane (android-companion-ui Phase 1).
 *
 * GET /me/tray aggregates every open mandate into one list the phone renders
 * as cards; the POST routes here + /me/vault/approve-site (vault.ts) are
 * the one-tap answers. Four sources, one shape:
 *
 *   habit            — today's open gtd_habit_log occurrences (shared schema
 *                      with the gtd MCP + HabitScheduler; DECISION-019)
 *   approval_contact — pending permission_change_requests (same helper as
 *                      GET /approvals/pending)
 *   approval_vault   — firing system_alerts with key vault.approval.<domain>
 *   decision         — open tray_items rows the AGENT filed via
 *                      POST /tray-items (weekly-review decisions, plan
 *                      choices — spec §3/§6b A/B/C cards, recommendation
 *                      pre-highlighted). Answered via POST /me/tray/decision;
 *                      expired by the TrayItemExpiry sweep (default applied
 *                      by the AGENT, disclosed to the user — model §3).
 *
 * VOICE (binding — android-companion-ui.md §5a): items speak AS the agent,
 * first person ("should I mark it taken?", "Allow me to sign in…"), never
 * "you have N tasks". Every item carries an escalation-honesty line
 * (interaction model §2): its own future if ignored, phrased as the user's
 * own rule — the app reminds, never nags.
 */

// ---------------------------------------------------------------------------
// Frozen API contract — the Android app is built against these shapes.
// ---------------------------------------------------------------------------

export interface TrayDecisionOption {
  key: string;
  label: string;
  /** The AGENT's pick — the one pre-highlighted (filled) chip. */
  recommended: boolean;
}

export interface TrayItem {
  /** Stable: "habit:<habit_id>:<due_date>:<due_time>" | "approval_contact:<request_id>" | "approval_vault:<domain>" | "decision:<uuid>" */
  id: string;
  kind: 'habit' | 'approval_contact' | 'approval_vault' | 'decision';
  /** FIRST-PERSON agent voice — one question, never a paragraph. */
  question: string;
  /** One line max. */
  context: string | null;
  /** ISO timestamp. */
  created_at: string;
  /** Escalation-honesty line — the card's contract seal. */
  escalation: { future_text: string };
  habit?: { habit_id: string; habit_name: string; due_date: string; due_time: string };
  approval_contact?: {
    request_id: string;
    display_name: string | null;
    current_permission: string | null;
    requested_permission: string;
  };
  approval_vault?: { domain: string };
  /** item_id is the raw tray_items uuid — what POST /me/tray/decision takes. */
  decision?: { item_id: string; options: TrayDecisionOption[] };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Outcomes a tray tap can log. 'missed' is deliberately absent: misses are
// what the HabitScheduler's end-of-day sweep records when the user DIDN'T
// answer — never a button.
const TRAY_OUTCOMES = ['done', 'skipped_deliberate', 'excused'] as const;

// Agent-filed decision limits (frozen contract with the ll5-run add_tray_item
// tool): one-line question, one-line context, 2-3 options, deadline ≤14d out.
const DECISION_QUESTION_MAX = 200;
const DECISION_CONTEXT_MAX = 300;
const DECISION_EXPIRES_MAX_DAYS = 14;
const DECISION_OPTIONS_MIN = 2;
const DECISION_OPTIONS_MAX = 3;

interface HabitRow {
  id: string;
  name: string;
  description: string | null;
  schedule: { days?: 'daily' | number[]; times?: string[] } | null;
  escalation: Array<{ offset_minutes?: number; level?: string }> | null;
  timezone: string | null;
}

interface LogRow {
  due_time: string;
  outcome: string | null;
  steps_fired: number[] | null;
}

interface LocalParts { date: string; dow: number; minutes: number }

/** Local wall-clock parts in a zone — same shape as HabitScheduler.localParts
 *  so tray visibility and scheduler firing agree on "today". */
function localParts(now: Date, zone: string): LocalParts {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(now);
  const hh = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  const mm = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { date, dow: map[wd] ?? 0, minutes: hh * 60 + mm };
}

function fmtHHMM(totalMinutes: number): string {
  const m = ((totalMinutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function oneLine(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** True when the table is missing (pre-migration deploy) — log and skip. */
function isMissingTable(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '42P01';
}

/**
 * Habit escalation-honesty line, from the habit's own escalation config:
 * next unfired step → "escalates to <level> <HH:MM> · your rule"; all steps
 * spent → the end-of-day sweep is what happens next.
 */
function habitFutureText(
  escalation: NonNullable<HabitRow['escalation']>,
  stepsFired: number[],
  occurrenceMin: number,
): string {
  const fired = new Set(stepsFired);
  const nextIdx = escalation.findIndex((_, i) => !fired.has(i));
  if (nextIdx === -1) return 'auto-logs missed at midnight';
  const step = escalation[nextIdx];
  return `escalates to ${step.level ?? 'notify'} ${fmtHHMM(occurrenceMin + (step.offset_minutes ?? 0))} · your rule`;
}

/**
 * Today's OPEN habit occurrences for the caller: a gtd_habit_log row with
 * outcome IS NULL, OR a habit scheduled today with no row yet whose FIRST
 * escalation step time has passed (the scheduler would have created the row
 * at that instant — this covers scheduler lag/outage so the tray never hides
 * a due check behind an infra hiccup).
 */
async function collectHabitItems(pool: Pool, userId: string, now: Date): Promise<TrayItem[]> {
  let habits: HabitRow[];
  try {
    const res = await pool.query<HabitRow>(
      `SELECT id, name, description, schedule, escalation, timezone
       FROM gtd_habits
       WHERE user_id = $1 AND status = 'active'`,
      [userId],
    );
    habits = res.rows;
  } catch (err) {
    if (isMissingTable(err)) {
      logger.warn('[tray][habits] gtd_habits missing (pre-migration) — no habit items');
      return [];
    }
    throw err;
  }
  if (habits.length === 0) return [];

  const effectiveTz = await getEffectiveTimezone(pool, userId);
  const items: TrayItem[] = [];

  for (const habit of habits) {
    const zone = habit.timezone || effectiveTz;
    const L = localParts(now, zone);

    const days = habit.schedule?.days ?? 'daily';
    const matchesDay = days === 'daily' || (Array.isArray(days) && days.includes(L.dow));
    if (!matchesDay) continue;

    const times = habit.schedule?.times ?? [];
    const escalation = habit.escalation ?? [];
    if (times.length === 0) continue;

    const byTime = new Map<string, LogRow>();
    try {
      const res = await pool.query<LogRow>(
        `SELECT due_time, outcome, steps_fired
         FROM gtd_habit_log
         WHERE habit_id = $1 AND user_id = $2 AND due_date = $3`,
        [habit.id, userId, L.date],
      );
      for (const r of res.rows) byTime.set(r.due_time, r);
    } catch (err) {
      if (!isMissingTable(err)) throw err;
    }

    const dayStart = startOfDayInTz(now, zone);
    for (const dueTime of times) {
      const [th, tm] = dueTime.split(':').map(Number);
      if (!Number.isFinite(th) || !Number.isFinite(tm)) continue;
      const occurrenceMin = th * 60 + tm;

      const log = byTime.get(dueTime);
      if (log) {
        // A logged outcome closes the occurrence — never re-ask.
        if (log.outcome != null) continue;
      } else {
        // No row yet: only surface once the first escalation step's time has
        // passed (before that the habit simply isn't due to be asked about).
        if (escalation.length === 0) continue;
        const firstStepMin = occurrenceMin + (escalation[0].offset_minutes ?? 0);
        if (L.minutes < firstStepMin) continue;
      }

      items.push({
        id: `habit:${habit.id}:${L.date}:${dueTime}`,
        kind: 'habit',
        question: `${habit.name} — should I mark it taken?`,
        context: habit.description ? oneLine(habit.description) : null,
        created_at: new Date(dayStart.getTime() + occurrenceMin * 60_000).toISOString(),
        escalation: { future_text: habitFutureText(escalation, log?.steps_fired ?? [], occurrenceMin) },
        habit: { habit_id: habit.id, habit_name: habit.name, due_date: L.date, due_time: dueTime },
      });
    }
  }
  return items;
}

/** Pending contact-authority requests → tray items (same source of truth as
 *  GET /approvals/pending — one helper, two surfaces). */
async function collectContactApprovalItems(pool: Pool, userId: string): Promise<TrayItem[]> {
  const pending = await listPendingApprovals(pool, userId);
  return pending.map((p) => ({
    id: `approval_contact:${p.id}`,
    kind: 'approval_contact' as const,
    question: `May I handle ${p.display_name ?? 'this conversation'} as "${p.requested_permission}"?`,
    context: `currently ${p.current_permission ?? 'default'}`,
    created_at: new Date(p.created_at).toISOString(),
    escalation: { future_text: 'expires — stays denied until approved' },
    approval_contact: {
      request_id: p.id,
      display_name: p.display_name,
      current_permission: p.current_permission,
      requested_permission: p.requested_permission,
    },
  }));
}

const VAULT_ALERT_PREFIX = 'vault.approval.';

/** Firing vault.approval.<domain> alerts → tray items. Answered via
 *  POST /me/vault/approve-site (vault.ts), which resolves the alert. */
async function collectVaultApprovalItems(pool: Pool, userId: string): Promise<TrayItem[]> {
  const res = await pool.query<{ alert_key: string; summary: string | null; first_seen_at: string }>(
    `SELECT alert_key, summary, first_seen_at
     FROM system_alerts
     WHERE user_id = $1 AND status = 'firing' AND alert_key LIKE $2
     ORDER BY first_seen_at DESC`,
    [userId, `${VAULT_ALERT_PREFIX}%`],
  );
  return res.rows.map((r) => {
    const domain = r.alert_key.slice(VAULT_ALERT_PREFIX.length);
    // The approval-request alert summary is "Vault login approval needed:
    // <site> (<domain>)" — surface the site name as context when it adds
    // anything beyond the domain already in the question.
    const site = r.summary?.match(/^Vault login approval needed: (.+) \(/)?.[1];
    return {
      id: `approval_vault:${domain}`,
      kind: 'approval_vault' as const,
      question: `Allow me to sign in to ${domain}?`,
      context: site && site !== domain ? oneLine(site) : null,
      created_at: new Date(r.first_seen_at).toISOString(),
      escalation: { future_text: 'waiting — site stays blocked until you decide' },
      approval_vault: { domain },
    };
  });
}

// ---------------------------------------------------------------------------
// Decision items (agent-filed tray_items — migration 037)
// ---------------------------------------------------------------------------

interface TrayItemRow {
  id: string;
  question: string;
  context: string | null;
  options: TrayDecisionOption[] | null;
  default_key: string | null;
  expires_at: Date | string | null;
  created_at: Date | string;
}

/** Normalise a stored options array to the frozen wire shape (recommended
 *  always a boolean — the phone keys the filled chip off it). */
function normalizeOptions(options: TrayItemRow['options']): TrayDecisionOption[] {
  return (options ?? []).map((o) => ({
    key: String(o.key),
    label: String(o.label),
    recommended: o.recommended === true,
  }));
}

/**
 * The option the expiry default applies: the default_key match, else the
 * agent's recommended pick, else the first option. POST /tray-items validates
 * options is 2-3 entries, so this never comes up empty for a stored row.
 */
export function defaultOptionOf(
  options: TrayDecisionOption[],
  defaultKey: string | null,
): TrayDecisionOption {
  return options.find((o) => o.key === defaultKey)
    ?? options.find((o) => o.recommended)
    ?? options[0];
}

/** Short weekday name ("Thu") of an instant in a zone — the expiry-disclosure
 *  line matches the spec §3 mock: "Thu default: A · disclosed". */
function weekdayInTz(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(date);
}

/** Open agent-filed tray_items rows → decision cards. Escalation honesty:
 *  a deadline discloses its own default ("Thu default: Park it · disclosed"
 *  — model §3: expiry applies the agent's default AND is disclosed); no
 *  deadline says so plainly. */
async function collectDecisionItems(pool: Pool, userId: string): Promise<TrayItem[]> {
  let rows: TrayItemRow[];
  try {
    const res = await pool.query<TrayItemRow>(
      `SELECT id, question, context, options, default_key, expires_at, created_at
       FROM tray_items
       WHERE user_id = $1 AND status = 'open'
       ORDER BY created_at DESC`,
      [userId],
    );
    rows = res.rows;
  } catch (err) {
    if (isMissingTable(err)) {
      logger.warn('[tray][decisions] tray_items missing (pre-migration) — no decision items');
      return [];
    }
    throw err;
  }
  if (rows.length === 0) return [];

  const tz = await getEffectiveTimezone(pool, userId);
  return rows.map((r) => {
    const options = normalizeOptions(r.options);
    const futureText = r.expires_at
      ? `${weekdayInTz(new Date(r.expires_at), tz)} default: ${defaultOptionOf(options, r.default_key).label} · disclosed`
      : 'waiting — no deadline';
    return {
      id: `decision:${r.id}`,
      kind: 'decision' as const,
      question: r.question,
      context: r.context ? oneLine(r.context) : null,
      created_at: new Date(r.created_at).toISOString(),
      escalation: { future_text: futureText },
      decision: { item_id: r.id, options },
    };
  });
}

/**
 * Every open mandate for a user, one list, newest first — the single source
 * of truth behind GET /me/tray AND the Today card's needs_you_count
 * (today.ts). Extracted so the two surfaces can never disagree on what
 * "needs you" means.
 */
export async function collectTrayItems(pool: Pool, userId: string, now: Date): Promise<TrayItem[]> {
  const [habitItems, contactItems, vaultItems, decisionItems] = await Promise.all([
    collectHabitItems(pool, userId, now),
    collectContactApprovalItems(pool, userId),
    collectVaultApprovalItems(pool, userId),
    collectDecisionItems(pool, userId),
  ]);
  return [...habitItems, ...contactItems, ...vaultItems, ...decisionItems]
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
}

/** Count of open mandates — the tray badge / Today "needs you" number. */
export async function countTrayItems(pool: Pool, userId: string, now: Date): Promise<number> {
  return (await collectTrayItems(pool, userId, now)).length;
}

export interface TrayRouterOptions {
  /** Injectable clock for tests. */
  now?: () => Date;
}

export function createTrayRouter(pool: Pool, authSecret: string, options: TrayRouterOptions = {}): Router {
  const router = Router();
  const authMw = chatAuthMiddleware(authSecret);
  const nowFn = options.now ?? (() => new Date());

  // GET /me/tray — every open mandate, one list. No pagination: the tray is
  // capped by design to true mandates (§5a) — if this list is long, the
  // problem is upstream, not here.
  router.get('/me/tray', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    try {
      const items = await collectTrayItems(pool, userId, nowFn());
      res.json({ items });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[tray][get] Failed', { userId, error: message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /me/habits/outcome — one-tap habit answer from the tray.
  //
  // The upsert is EXACTLY the gtd MCP's log_habit_outcome shape
  // (packages/gtd/src/repositories/postgres/habit.repository.ts logOutcome):
  // insert-or-update on (habit_id, due_date, due_time) setting only
  // outcome/closed_at/note — steps_fired stays scheduler-owned, and the
  // user_id guard on DO UPDATE is the same defense-in-depth backstop.
  //
  // Closing the occurrence silences the remaining escalation steps by itself:
  // HabitScheduler.tick() skips any occurrence whose outcome is non-NULL
  // ("A logged outcome closes the occurrence and silences remaining steps"),
  // so no scheduler coordination is needed here.
  router.post('/me/habits/outcome', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    const { habit_id: habitId, due_date: dueDate, due_time: dueTime, outcome, note } = (req.body ?? {}) as {
      habit_id?: unknown; due_date?: unknown; due_time?: unknown; outcome?: unknown; note?: unknown;
    };

    if (typeof habitId !== 'string' || !UUID_RE.test(habitId)) {
      res.status(400).json({ error: 'habit_id must be a UUID' });
      return;
    }
    if (typeof dueDate !== 'string' || !DATE_RE.test(dueDate)) {
      res.status(400).json({ error: 'due_date must be YYYY-MM-DD' });
      return;
    }
    if (typeof dueTime !== 'string' || !TIME_RE.test(dueTime)) {
      res.status(400).json({ error: 'due_time must be HH:MM (24h)' });
      return;
    }
    if (typeof outcome !== 'string' || !(TRAY_OUTCOMES as readonly string[]).includes(outcome)) {
      res.status(400).json({ error: `outcome must be one of: ${TRAY_OUTCOMES.join(', ')}` });
      return;
    }
    if (note !== undefined && typeof note !== 'string') {
      res.status(400).json({ error: 'note must be a string' });
      return;
    }

    try {
      // User-scoping: the habit must belong to the token's user.
      const habitRes = await pool.query<{ id: string; name: string }>(
        `SELECT id, name FROM gtd_habits WHERE id = $1 AND user_id = $2`,
        [habitId, userId],
      );
      const habit = habitRes.rows[0];
      if (!habit) {
        res.status(404).json({ error: 'Habit not found' });
        return;
      }

      const upsert = await pool.query<{ id: string }>(
        `INSERT INTO gtd_habit_log (habit_id, user_id, due_date, due_time, outcome, closed_at, note)
         VALUES ($1, $2, $3, $4, $5, now(), $6)
         ON CONFLICT (habit_id, due_date, due_time)
         DO UPDATE SET
           outcome = EXCLUDED.outcome,
           closed_at = now(),
           note = COALESCE(EXCLUDED.note, gtd_habit_log.note)
         WHERE gtd_habit_log.user_id = $2
         RETURNING id`,
        [habitId, userId, dueDate, dueTime, outcome, note ?? null],
      );
      if (!upsert.rows[0]) {
        // Guarded upsert matched a conflicting row owned by someone else —
        // should be unreachable after the ownership check above.
        res.status(409).json({ error: 'Habit occurrence not writable' });
        return;
      }

      logAudit({
        user_id: userId,
        source: 'gateway',
        action: 'update',
        entity_type: 'habit_occurrence',
        entity_id: upsert.rows[0].id,
        summary: `Habit "${habit.name}" ${dueDate} ${dueTime}: ${outcome} (tray)`,
        metadata: { habit_id: habitId, due_date: dueDate, due_time: dueTime, outcome },
      });

      res.json({ status: 'logged', outcome });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[tray][habitOutcome] Failed', { userId, habitId, error: message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /tray-items — the AGENT files a decision card (chatAuth: its channel
  // holds a user token, same pattern as POST /today-card). Strict validation:
  // the row IS the frozen card contract, so nothing malformed gets stored.
  router.post('/tray-items', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    const {
      question, context, options, default_key: defaultKey, expires_at: expiresAt, source,
    } = (req.body ?? {}) as {
      question?: unknown; context?: unknown; options?: unknown;
      default_key?: unknown; expires_at?: unknown; source?: unknown;
    };

    if (typeof question !== 'string' || question.trim().length === 0) {
      res.status(400).json({ error: 'question must be a non-empty string' });
      return;
    }
    if (question.length > DECISION_QUESTION_MAX) {
      res.status(400).json({ error: `question must be at most ${DECISION_QUESTION_MAX} characters` });
      return;
    }
    if (context != null && typeof context !== 'string') {
      res.status(400).json({ error: 'context must be a string' });
      return;
    }
    if (typeof context === 'string' && context.length > DECISION_CONTEXT_MAX) {
      res.status(400).json({ error: `context must be at most ${DECISION_CONTEXT_MAX} characters` });
      return;
    }
    if (!Array.isArray(options) || options.length < DECISION_OPTIONS_MIN || options.length > DECISION_OPTIONS_MAX) {
      res.status(400).json({ error: `options must be an array of ${DECISION_OPTIONS_MIN}-${DECISION_OPTIONS_MAX} entries` });
      return;
    }
    const parsed: TrayDecisionOption[] = [];
    for (const opt of options as unknown[]) {
      const o = opt as { key?: unknown; label?: unknown; recommended?: unknown } | null;
      if (o == null || typeof o !== 'object'
        || typeof o.key !== 'string' || o.key.trim().length === 0
        || typeof o.label !== 'string' || o.label.trim().length === 0
        || (o.recommended !== undefined && typeof o.recommended !== 'boolean')) {
        res.status(400).json({ error: 'each option must be {key, label, recommended?} with non-empty strings' });
        return;
      }
      parsed.push({ key: o.key, label: o.label, recommended: o.recommended === true });
    }
    if (new Set(parsed.map((o) => o.key)).size !== parsed.length) {
      res.status(400).json({ error: 'option keys must be unique' });
      return;
    }
    if (defaultKey != null && (typeof defaultKey !== 'string' || !parsed.some((o) => o.key === defaultKey))) {
      res.status(400).json({ error: 'default_key must match one of the option keys' });
      return;
    }
    let expiresDate: Date | null = null;
    if (expiresAt != null) {
      if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) {
        res.status(400).json({ error: 'expires_at must be an ISO timestamp' });
        return;
      }
      expiresDate = new Date(expiresAt);
      const now = nowFn();
      if (expiresDate.getTime() <= now.getTime()) {
        res.status(400).json({ error: 'expires_at must be in the future' });
        return;
      }
      if (expiresDate.getTime() > now.getTime() + DECISION_EXPIRES_MAX_DAYS * 86_400_000) {
        res.status(400).json({ error: `expires_at must be at most ${DECISION_EXPIRES_MAX_DAYS} days out` });
        return;
      }
    }
    if (source != null && typeof source !== 'string') {
      res.status(400).json({ error: 'source must be a string' });
      return;
    }

    try {
      const insert = await pool.query<{ id: string }>(
        `INSERT INTO tray_items (user_id, question, context, options, default_key, expires_at, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          userId, question, context ?? null, JSON.stringify(parsed),
          defaultKey ?? null, expiresDate?.toISOString() ?? null, source ?? null,
        ],
      );
      const id = insert.rows[0].id;

      logAudit({
        user_id: userId,
        source: 'gateway',
        action: 'create',
        entity_type: 'tray_item',
        entity_id: id,
        summary: `Decision card filed: ${oneLine(question, 100)}`,
        metadata: {
          option_keys: parsed.map((o) => o.key),
          default_key: defaultKey ?? null,
          expires_at: expiresDate?.toISOString() ?? null,
          source: source ?? null,
        },
      });

      res.json({ id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[tray][postItem] Failed', { userId, error: message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /me/tray/decision — the one-tap answer to an agent-filed card.
  // Flips the row to answered and tells the AGENT via a system message —
  // the agent applies the chosen action; the tray only records the choice.
  router.post('/me/tray/decision', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    const { item_id: itemId, answer_key: answerKey } = (req.body ?? {}) as {
      item_id?: unknown; answer_key?: unknown;
    };

    if (typeof itemId !== 'string' || !UUID_RE.test(itemId)) {
      res.status(400).json({ error: 'item_id must be a UUID (TrayItem.decision.item_id)' });
      return;
    }
    if (typeof answerKey !== 'string' || answerKey.length === 0) {
      res.status(400).json({ error: 'answer_key must be a non-empty string' });
      return;
    }

    try {
      // User-scoped read first so a wrong answer_key 400s instead of 404ing.
      const itemRes = await pool.query<TrayItemRow & { status: string }>(
        `SELECT id, question, context, options, default_key, expires_at, created_at, status
         FROM tray_items
         WHERE id = $1 AND user_id = $2`,
        [itemId, userId],
      );
      const item = itemRes.rows[0];
      if (!item || item.status !== 'open') {
        res.status(404).json({ error: 'Open tray item not found' });
        return;
      }
      const options = normalizeOptions(item.options);
      const chosen = options.find((o) => o.key === answerKey);
      if (!chosen) {
        res.status(400).json({ error: `answer_key must be one of: ${options.map((o) => o.key).join(', ')}` });
        return;
      }

      const update = await pool.query(
        `UPDATE tray_items
         SET status = 'answered', answer_key = $3, answered_at = now()
         WHERE id = $1 AND user_id = $2 AND status = 'open'`,
        [itemId, userId, answerKey],
      );
      if (update.rowCount === 0) {
        // Lost a race with the expiry sweep or a concurrent answer.
        res.status(404).json({ error: 'Open tray item not found' });
        return;
      }

      // Hand the choice to the agent — it owns applying the decision.
      await insertSystemMessage(
        pool,
        userId,
        `[Decision] user chose '${chosen.label}' for: ${item.question}`,
      );

      logAudit({
        user_id: userId,
        source: 'gateway',
        action: 'update',
        entity_type: 'tray_item',
        entity_id: itemId,
        summary: `Decision answered '${chosen.key}' (${oneLine(chosen.label, 60)}): ${oneLine(item.question, 100)}`,
        metadata: { answer_key: chosen.key },
      });

      res.json({ status: 'answered' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[tray][decision] Failed', { userId, itemId, error: message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
