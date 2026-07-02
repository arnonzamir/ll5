// Pure habit helpers (DECISION-019): schedule/escalation validation, timezone
// local-date resolution, occurrence expansion, and trends math. Kept free of
// I/O so the tool handlers stay thin and this logic is directly testable.

import type {
  Habit,
  HabitSchedule,
  HabitLogEntry,
  HabitTrend,
  HabitWeekStats,
  HabitMissEntry,
} from '../types/index.js';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const ESCALATION_LEVELS = new Set(['silent', 'notify', 'alert', 'critical']);

/** Validates the schedule shape; returns an error message or null when valid. */
export function validateSchedule(schedule: unknown): string | null {
  if (schedule == null || typeof schedule !== 'object' || Array.isArray(schedule)) {
    return 'schedule must be an object: {"days": "daily"|[0..6], "times": ["HH:MM", ...]}';
  }
  const s = schedule as Record<string, unknown>;

  if (s.days !== 'daily') {
    if (!Array.isArray(s.days) || s.days.length === 0) {
      return 'schedule.days must be "daily" or a non-empty array of day-of-week integers (0=Sunday .. 6=Saturday)';
    }
    for (const d of s.days) {
      if (!Number.isInteger(d) || (d as number) < 0 || (d as number) > 6) {
        return `schedule.days contains an invalid day: ${JSON.stringify(d)} (must be integers 0..6, 0=Sunday)`;
      }
    }
  }

  if (!Array.isArray(s.times) || s.times.length === 0) {
    return 'schedule.times must be a non-empty array of "HH:MM" strings';
  }
  for (const t of s.times) {
    if (typeof t !== 'string' || !TIME_RE.test(t)) {
      return `schedule.times contains an invalid time: ${JSON.stringify(t)} (must be "HH:MM", 24h)`;
    }
  }
  return null;
}

/** Validates the escalation shape; returns an error message or null when valid. */
export function validateEscalation(escalation: unknown): string | null {
  if (!Array.isArray(escalation)) {
    return 'escalation must be an array of {"offset_minutes": int, "level": "silent"|"notify"|"alert"|"critical"}';
  }
  for (const step of escalation) {
    if (step == null || typeof step !== 'object' || Array.isArray(step)) {
      return `escalation contains an invalid step: ${JSON.stringify(step)}`;
    }
    const s = step as Record<string, unknown>;
    if (!Number.isInteger(s.offset_minutes)) {
      return `escalation step has an invalid offset_minutes: ${JSON.stringify(s.offset_minutes)} (must be an integer)`;
    }
    if (typeof s.level !== 'string' || !ESCALATION_LEVELS.has(s.level)) {
      return `escalation step has an unknown level: ${JSON.stringify(s.level)} (must be silent|notify|alert|critical)`;
    }
  }
  return null;
}

/** Loose IANA timezone check via Intl; returns an error message or null. */
export function validateTimezone(tz: string): string | null {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return null;
  } catch {
    return `Invalid timezone: ${JSON.stringify(tz)} (must be an IANA name like "Asia/Jerusalem")`;
  }
}

/**
 * The current wall clock in a timezone: local date (YYYY-MM-DD), time (HH:MM),
 * and day-of-week (0=Sunday). Falls back to the process timezone when tz is
 * null (matching how ticklers resolve local times).
 */
export function localNow(
  tz: string | null | undefined,
  now: Date = new Date(),
): { date: string; time: string; dayOfWeek: number } {
  const timeZone = tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  // Intl may render midnight as "24:00" with hour12: false — normalize.
  const hour = get('hour') === '24' ? '00' : get('hour');
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${hour}:${get('minute')}`,
    dayOfWeek: dowMap[get('weekday')] ?? 0,
  };
}

/** Whether a schedule fires on the given day-of-week (0=Sunday). */
export function scheduledOnDay(schedule: HabitSchedule, dayOfWeek: number): boolean {
  return schedule.days === 'daily' || schedule.days.includes(dayOfWeek);
}

/**
 * Picks the scheduled time nearest to `nowTime` ("HH:MM"). Returns null when
 * the choice is ambiguous (an exact tie between two times) — callers should
 * then require an explicit due_time.
 */
export function nearestScheduledTime(times: string[], nowTime: string): string | null {
  if (times.length === 0) return null;
  if (times.length === 1) return times[0];

  const mins = (t: string) => parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3, 5), 10);
  const nowMins = mins(nowTime);

  let best: string | null = null;
  let bestDist = Infinity;
  let tied = false;
  for (const t of times) {
    const dist = Math.abs(mins(t) - nowMins);
    if (dist < bestDist) {
      best = t;
      bestDist = dist;
      tied = false;
    } else if (dist === bestDist && t !== best) {
      tied = true;
    }
  }
  return tied ? null : best;
}

/** Shifts a YYYY-MM-DD date string by `days` (UTC-safe date arithmetic). */
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Trends math for one habit over a trailing window of `weeks` 7-day buckets
 * ending at `today` (the habit's local date). Pure — operates on the log
 * entries the caller fetched.
 *
 * - Weekly completion rate = done / (done + missed + skipped_deliberate);
 *   excused occurrences are excluded from the denominator.
 * - Current streak: walk back from `today`; a day breaks the streak when any
 *   occurrence that day is missed/skipped_deliberate, counts when at least one
 *   is done (and none broke it), and is neutral otherwise (no occurrences,
 *   only excused, or still open). Excused never breaks a streak.
 */
export function computeHabitTrend(
  habit: Pick<Habit, 'id' | 'name' | 'status'>,
  entries: HabitLogEntry[],
  weeks: number,
  today: string,
): HabitTrend {
  const byDate = new Map<string, HabitLogEntry[]>();
  for (const e of entries) {
    const list = byDate.get(e.dueDate) ?? [];
    list.push(e);
    byDate.set(e.dueDate, list);
  }

  // Weekly buckets: week 0 = (today-6 .. today), week 1 = the 7 days before, ...
  // Reported oldest-first so the list reads as a left-to-right trend.
  const weekly: HabitWeekStats[] = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const weekEnd = shiftDate(today, -7 * w);
    const weekStart = shiftDate(weekEnd, -6);
    let done = 0, missed = 0, skipped = 0, excused = 0;
    for (let i = 0; i < 7; i++) {
      const date = shiftDate(weekStart, i);
      for (const e of byDate.get(date) ?? []) {
        if (e.outcome === 'done') done++;
        else if (e.outcome === 'missed') missed++;
        else if (e.outcome === 'skipped_deliberate') skipped++;
        else if (e.outcome === 'excused') excused++;
      }
    }
    const denominator = done + missed + skipped;
    weekly.push({
      weekStart,
      weekEnd,
      done,
      missed,
      skipped,
      excused,
      completionRate: denominator > 0 ? Math.round((done / denominator) * 1000) / 1000 : null,
    });
  }

  // Current streak (bounded by the fetched window).
  let streak = 0;
  const windowDays = weeks * 7;
  for (let i = 0; i < windowDays; i++) {
    const date = shiftDate(today, -i);
    const dayEntries = byDate.get(date) ?? [];
    const broke = dayEntries.some((e) => e.outcome === 'missed' || e.outcome === 'skipped_deliberate');
    if (broke) break;
    const anyDone = dayEntries.some((e) => e.outcome === 'done');
    if (anyDone) streak++;
    // Neutral day (no occurrences / only excused / still open): keep walking.
  }

  const recentMisses: HabitMissEntry[] = entries
    .filter((e) => e.outcome === 'missed' || e.outcome === 'skipped_deliberate')
    .sort((a, b) => (b.dueDate + b.dueTime).localeCompare(a.dueDate + a.dueTime))
    .slice(0, 10)
    .map((e) => ({
      dueDate: e.dueDate,
      dueTime: e.dueTime,
      outcome: e.outcome as HabitMissEntry['outcome'],
      note: e.note,
    }));

  return {
    habitId: habit.id,
    name: habit.name,
    status: habit.status,
    weekly,
    currentStreakDays: streak,
    recentMisses,
  };
}
