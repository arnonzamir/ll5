import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { logAudit } from '@ll5/shared';
import { chatAuthMiddleware } from './chat.js';
import { listPendingApprovals } from './approvals.js';
import { getEffectiveTimezone, startOfDayInTz } from './utils/timezone.js';
import { logger } from './utils/logger.js';

/**
 * "Needs You" tray plane (android-companion-ui Phase 1).
 *
 * GET /me/tray aggregates every open mandate into one list the phone renders
 * as cards; the two POST routes here + /me/vault/approve-site (vault.ts) are
 * the one-tap answers. Three sources, one shape:
 *
 *   habit            — today's open gtd_habit_log occurrences (shared schema
 *                      with the gtd MCP + HabitScheduler; DECISION-019)
 *   approval_contact — pending permission_change_requests (same helper as
 *                      GET /approvals/pending)
 *   approval_vault   — firing system_alerts with key vault.approval.<domain>
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

export interface TrayItem {
  /** Stable: "habit:<habit_id>:<due_date>:<due_time>" | "approval_contact:<request_id>" | "approval_vault:<domain>" */
  id: string;
  kind: 'habit' | 'approval_contact' | 'approval_vault';
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
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Outcomes a tray tap can log. 'missed' is deliberately absent: misses are
// what the HabitScheduler's end-of-day sweep records when the user DIDN'T
// answer — never a button.
const TRAY_OUTCOMES = ['done', 'skipped_deliberate', 'excused'] as const;

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

/**
 * Every open mandate for a user, one list, newest first — the single source
 * of truth behind GET /me/tray AND the Today card's needs_you_count
 * (today.ts). Extracted so the two surfaces can never disagree on what
 * "needs you" means.
 */
export async function collectTrayItems(pool: Pool, userId: string, now: Date): Promise<TrayItem[]> {
  const [habitItems, contactItems, vaultItems] = await Promise.all([
    collectHabitItems(pool, userId, now),
    collectContactApprovalItems(pool, userId),
    collectVaultApprovalItems(pool, userId),
  ]);
  return [...habitItems, ...contactItems, ...vaultItems]
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

  return router;
}
