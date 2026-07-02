import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { insertSystemMessage, createSchedulerEvent } from '../utils/system-message.js';
import { getEffectiveTimezone, startOfDayInTz } from '../utils/timezone.js';
import { withSchedulerHealth } from '../utils/scheduler-health.js';

interface HabitSchedulerConfig {
  enabled: boolean;
  userId: string;
  timezone: string;
}

// Like WakeScheduler: a step only fires within this many minutes PAST its due
// instant, so a long outage/restart never fires stale escalation steps at the
// wrong time of day. The end-of-day sweep turns silence into `missed` data.
const CATCHUP_MINUTES = 90;

interface HabitRow {
  id: string;
  name: string;
  description: string | null;
  schedule: { days?: 'daily' | number[]; times?: string[] } | null;
  check_kind: string;
  check_config: Record<string, unknown> | null;
  escalation: Array<{ offset_minutes?: number; level?: string }> | null;
  timezone: string | null;
}

interface LogRow {
  due_time: string;
  outcome: string | null;
  steps_fired: number[] | null;
}

interface LocalParts { date: string; dow: number; minutes: number }

/**
 * Habit-contract firing engine (DECISION-019). Reads `gtd_habits` /
 * `gtd_habit_log` (created by the gtd MCP migration in the same ll5 database)
 * every 60s, WakeScheduler-shaped: DST-safe local wall-clock compare in the
 * habit's timezone (else the effective tz), per-occurrence step dedup persisted
 * in `steps_fired` (restart-safe), and a catch-up cap so stale steps never fire.
 * A logged outcome closes the occurrence and silences remaining steps; an
 * occurrence never closed by end of day is auto-logged `missed` on the first
 * tick of the new local day — misses are data, not silence.
 *
 * Tables are queried DEFENSIVELY: this scheduler ships in the same release as
 * the gtd migration, so a missing table (42P01) logs and skips, never crashes.
 */
export class HabitScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSweepDate: string | null = null;

  constructor(
    private pool: Pool,
    private config: HabitSchedulerConfig,
  ) {}

  start(): void {
    if (!this.config.enabled) {
      logger.info('[HabitScheduler][start] Disabled — skipping (re-enable via user_settings.scheduler.habit_scheduler_enabled=true)');
      return;
    }
    logger.info('[HabitScheduler][start] Started', { timezone: this.config.timezone });
    this.timer = setInterval(() => void withSchedulerHealth('habit_scheduler', () => this.tick()).catch(() => {}), 60_000);
    void withSchedulerHealth('habit_scheduler', () => this.tick()).catch(() => {});
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private localParts(now: Date, zone: string): LocalParts {
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

  /** True when the table is missing (pre-migration deploy) — log once per tick and skip. */
  private isMissingTable(err: unknown): boolean {
    return (err as { code?: string } | null)?.code === '42P01';
  }

  /**
   * End-of-day sweep: on the first tick of a new local day, auto-close every
   * still-open occurrence from previous days as `missed`.
   */
  private async sweepMissed(localDate: string): Promise<void> {
    if (this.lastSweepDate === localDate) return;
    this.lastSweepDate = localDate;
    try {
      const res = await this.pool.query(
        `UPDATE gtd_habit_log
         SET outcome = 'missed', closed_at = NOW()
         WHERE user_id = $1 AND outcome IS NULL AND due_date < $2`,
        [this.config.userId, localDate],
      );
      if ((res.rowCount ?? 0) > 0) {
        logger.info('[HabitScheduler][sweep] Auto-logged missed occurrences', { count: res.rowCount, before: localDate });
      }
    } catch (err) {
      if (this.isMissingTable(err)) {
        logger.debug('[HabitScheduler][sweep] gtd_habit_log missing (pre-migration) — skipping');
      } else {
        logger.warn('[HabitScheduler][sweep] missed-sweep failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  private async loadActiveHabits(): Promise<HabitRow[]> {
    try {
      const res = await this.pool.query<HabitRow>(
        `SELECT id, name, description, schedule, check_kind, check_config, escalation, timezone
         FROM gtd_habits
         WHERE user_id = $1 AND status = 'active'`,
        [this.config.userId],
      );
      return res.rows;
    } catch (err) {
      if (this.isMissingTable(err)) {
        logger.debug('[HabitScheduler][tick] gtd_habits missing (pre-migration) — skipping');
      } else {
        logger.warn('[HabitScheduler][tick] habit query failed', { error: err instanceof Error ? err.message : String(err) });
      }
      return [];
    }
  }

  private async loadTodaysLog(habitId: string, localDate: string): Promise<Map<string, LogRow>> {
    const byTime = new Map<string, LogRow>();
    try {
      const res = await this.pool.query<LogRow>(
        `SELECT due_time, outcome, steps_fired
         FROM gtd_habit_log
         WHERE habit_id = $1 AND user_id = $2 AND due_date = $3`,
        [habitId, this.config.userId, localDate],
      );
      for (const r of res.rows) byTime.set(r.due_time, r);
    } catch (err) {
      if (!this.isMissingTable(err)) {
        logger.warn('[HabitScheduler][tick] log query failed', { habitId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return byTime;
  }

  /** Upsert the occurrence row and append the fired step index (the durable dedup). */
  private async recordStepFired(
    habit: HabitRow, localDate: string, dueTime: string, dueAt: Date, stepIdx: number,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO gtd_habit_log (id, habit_id, user_id, due_date, due_time, due_at, steps_fired)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, jsonb_build_array($6::int))
       ON CONFLICT (habit_id, due_date, due_time)
       DO UPDATE SET steps_fired = gtd_habit_log.steps_fired || to_jsonb($6::int)
       WHERE gtd_habit_log.outcome IS NULL
         AND NOT gtd_habit_log.steps_fired @> to_jsonb($6::int)`,
      [habit.id, this.config.userId, localDate, dueTime, dueAt.toISOString(), stepIdx],
    );
  }

  private async fireStep(
    habit: HabitRow, dueTime: string, zone: string,
    stepIdx: number, stepCount: number, level: string,
  ): Promise<void> {
    const checkConfig = habit.check_config && Object.keys(habit.check_config).length > 0
      ? ` Config: ${JSON.stringify(habit.check_config).slice(0, 200)}.`
      : '';
    const body = [
      `[Habit Check] ${habit.name} — occurrence ${dueTime} (${zone}), step ${stepIdx + 1}/${stepCount}, level: ${level}.`,
      `Check kind: ${habit.check_kind}.${checkConfig}${habit.description ? ` (${habit.description})` : ''}`,
      'Check idempotently: if already done, log_habit_outcome done and stay silent; otherwise act at this step\'s level; log the outcome when known.',
    ].join('\n');
    const evt = createSchedulerEvent('habit_check');
    await insertSystemMessage(this.pool, this.config.userId, body, undefined, evt);
  }

  private async tick(): Promise<void> {
    const now = new Date();
    const effectiveTz = await getEffectiveTimezone(this.pool, this.config.userId);

    // End-of-day sweep runs on the effective-tz day boundary.
    const effectiveDate = this.localParts(now, effectiveTz).date;
    await this.sweepMissed(effectiveDate);

    const habits = await this.loadActiveHabits();
    for (const habit of habits) {
      try {
        const zone = habit.timezone || effectiveTz;
        const L = this.localParts(now, zone);

        const days = habit.schedule?.days ?? 'daily';
        const matchesDay = days === 'daily' || (Array.isArray(days) && days.includes(L.dow));
        if (!matchesDay) continue;

        const times = habit.schedule?.times ?? [];
        const escalation = habit.escalation ?? [];
        if (times.length === 0 || escalation.length === 0) continue;

        const logByTime = await this.loadTodaysLog(habit.id, L.date);
        const dayStart = startOfDayInTz(now, zone);

        for (const dueTime of times) {
          const [th, tm] = dueTime.split(':').map(Number);
          if (!Number.isFinite(th) || !Number.isFinite(tm)) continue;
          const occurrenceMin = th * 60 + tm;

          const log = logByTime.get(dueTime);
          // A logged outcome closes the occurrence and silences remaining steps.
          if (log?.outcome != null) continue;
          const fired = new Set<number>(log?.steps_fired ?? []);

          for (let i = 0; i < escalation.length; i++) {
            if (fired.has(i)) continue;
            const step = escalation[i];
            const stepMin = occurrenceMin + (step.offset_minutes ?? 0);
            const since = L.minutes - stepMin;
            // Catch-up cap: never fire stale steps after an outage.
            if (since < 0 || since > CATCHUP_MINUTES) continue;

            const dueAt = new Date(dayStart.getTime() + occurrenceMin * 60_000);
            await this.recordStepFired(habit, L.date, dueTime, dueAt, i);
            await this.fireStep(habit, dueTime, zone, i, escalation.length, step.level ?? 'notify');
            fired.add(i);
            logger.info('[HabitScheduler][tick] Habit step fired', {
              habit: habit.name, dueTime, step: `${i + 1}/${escalation.length}`, level: step.level,
            });
          }
        }
      } catch (err) {
        logger.warn('[HabitScheduler][tick] habit processing failed', {
          habit: habit.name, error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
