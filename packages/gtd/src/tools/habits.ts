import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logAudit } from '@ll5/shared';
import type { HabitRepository } from '../repositories/interfaces/habit.repository.js';
import type {
  Habit,
  HabitSchedule,
  EscalationStep,
  UpdateHabitInput,
} from '../types/index.js';
import {
  validateSchedule,
  validateEscalation,
  validateTimezone,
  localNow,
  scheduledOnDay,
  nearestScheduledTime,
  shiftDate,
  computeHabitTrend,
} from '../utils/habits.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const scheduleShape = z.object({
  days: z.union([
    z.literal('daily'),
    z.array(z.number().int().min(0).max(6)),
  ]).describe('"daily" or days of week as integers (0=Sunday .. 6=Saturday)'),
  times: z.array(z.string()).describe('Local times of day, 24h "HH:MM" (e.g. ["08:00", "14:30"])'),
});

const escalationShape = z.array(z.object({
  offset_minutes: z.number().int().describe('Minutes after the scheduled time this step fires (0 = at the due time; negative = pre-check before it)'),
  level: z.enum(['silent', 'notify', 'alert', 'critical']).describe('Notification level for this step'),
})).describe('Ordered escalation steps. Each unclosed occurrence walks these until an outcome is logged.');

function errorResponse(message: string, extra: Record<string, unknown> = {}) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message, ...extra }) }],
    isError: true,
  };
}

export function registerHabitTools(server: McpServer, repo: HabitRepository, getUserId: () => string): void {

  // -------------------------------------------------------------------------
  // create_habit
  // -------------------------------------------------------------------------
  server.tool(
    'create_habit',
    'Create a habit contract: a RECURRING commitment with a schedule, an escalation policy, and an outcome history (e.g. daily medication, training, sleep timer). The gateway scheduler fires [Habit Check] instructions at each escalation step until an outcome is logged; misses are auto-logged at end of day. Use this for commitments the user wants held accountable over time — NOT for one-off reminders (use ticklers/wakes for those).',
    {
      name: z.string().describe('Habit name, e.g. "Ritalin AM dose"'),
      description: z.string().optional().describe('What this habit is and why it matters'),
      schedule: scheduleShape.describe('When occurrences are due: {"days": "daily"|[0..6], "times": ["HH:MM", ...]}'),
      check_kind: z.enum(['gtd_action', 'user_confirm', 'data']).describe('How completion is checked: gtd_action = a daily GTD action is auto-created/checked; user_confirm = the agent asks the user; data = verified against a data source (health, sleep, etc.)'),
      check_config: z.record(z.unknown()).optional().describe('check_kind parameters, e.g. {"action_title": "Take Ritalin AM"} or data-query params. Default: {}'),
      escalation: escalationShape,
      timezone: z.string().optional().describe('IANA timezone the schedule resolves in (e.g. "Asia/Jerusalem"). Default: server timezone'),
    },
    async (params) => {
      const userId = getUserId();

      const scheduleError = validateSchedule(params.schedule);
      if (scheduleError) return errorResponse(scheduleError);
      const escalationError = validateEscalation(params.escalation);
      if (escalationError) return errorResponse(escalationError);
      if (params.timezone) {
        const tzError = validateTimezone(params.timezone);
        if (tzError) return errorResponse(tzError);
      }

      const habit = await repo.create(userId, {
        name: params.name,
        description: params.description,
        schedule: params.schedule as HabitSchedule,
        checkKind: params.check_kind,
        checkConfig: params.check_config as Record<string, unknown> | undefined,
        escalation: params.escalation as EscalationStep[],
        timezone: params.timezone,
      });
      logAudit({ user_id: userId, source: 'gtd', action: 'create', entity_type: 'habit', entity_id: habit.id, summary: `Created habit: ${params.name}` });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ habit }, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // update_habit
  // -------------------------------------------------------------------------
  server.tool(
    'update_habit',
    'Update a habit contract: rename, reschedule, change escalation/check, or transition status. Pausing and retiring go through here (status: "paused" stops firing but keeps history; "retired" ends the habit). Prefer pause/retire over deleting — the outcome log is the point.',
    {
      id: z.string().describe('Habit ID (UUID)'),
      name: z.string().optional().describe('New name'),
      description: z.string().nullable().optional().describe('New description or null to clear'),
      schedule: scheduleShape.optional().describe('Replace the schedule'),
      check_kind: z.enum(['gtd_action', 'user_confirm', 'data']).optional().describe('New check kind'),
      check_config: z.record(z.unknown()).optional().describe('Replace check_kind parameters'),
      escalation: escalationShape.optional(),
      status: z.enum(['active', 'paused', 'retired']).optional().describe('New status: active | paused | retired'),
      timezone: z.string().nullable().optional().describe('New IANA timezone or null to fall back to the server timezone'),
    },
    async (params) => {
      const userId = getUserId();

      if (params.schedule !== undefined) {
        const scheduleError = validateSchedule(params.schedule);
        if (scheduleError) return errorResponse(scheduleError);
      }
      if (params.escalation !== undefined) {
        const escalationError = validateEscalation(params.escalation);
        if (escalationError) return errorResponse(escalationError);
      }
      if (params.timezone != null) {
        const tzError = validateTimezone(params.timezone);
        if (tzError) return errorResponse(tzError);
      }

      const updateData: UpdateHabitInput = {};
      if (params.name !== undefined) updateData.name = params.name;
      if (params.description !== undefined) updateData.description = params.description;
      if (params.schedule !== undefined) updateData.schedule = params.schedule as HabitSchedule;
      if (params.check_kind !== undefined) updateData.checkKind = params.check_kind;
      if (params.check_config !== undefined) updateData.checkConfig = params.check_config as Record<string, unknown>;
      if (params.escalation !== undefined) updateData.escalation = params.escalation as EscalationStep[];
      if (params.status !== undefined) updateData.status = params.status;
      if (params.timezone !== undefined) updateData.timezone = params.timezone;

      try {
        const habit = await repo.update(userId, params.id, updateData);
        logAudit({ user_id: userId, source: 'gtd', action: 'update', entity_type: 'habit', entity_id: params.id, summary: `Updated habit: ${habit.name}`, metadata: updateData as Record<string, unknown> });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ habit }, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResponse(message);
      }
    },
  );

  // -------------------------------------------------------------------------
  // log_habit_outcome
  // -------------------------------------------------------------------------
  server.tool(
    'log_habit_outcome',
    'Close one habit occurrence with an outcome. Logging silences the remaining escalation steps for that occurrence — call this the moment the user confirms (done), deliberately skips (skipped_deliberate), is legitimately unable (excused — does not break streaks), or when reconciling a miss. Works before the scheduler has created the occurrence row (early confirm).',
    {
      habit_id: z.string().describe('Habit ID (UUID)'),
      due_date: z.string().optional().describe('Occurrence date (YYYY-MM-DD). Default: today in the habit\'s timezone'),
      due_time: z.string().optional().describe('Occurrence time (HH:MM, one of the habit\'s scheduled times). Default: the nearest scheduled time — required when ambiguous'),
      // ISS-021: "skipped" / "skip" are accepted as spellings of skipped_deliberate.
      outcome: z.enum(['done', 'missed', 'skipped_deliberate', 'excused', 'skipped', 'skip']).describe('done = completed; missed = did not happen; skipped_deliberate = conscious skip (coaching signal; "skipped" is accepted as the same); excused = legitimately prevented (neutral for streaks)'),
      note: z.string().optional().describe('Context worth keeping, e.g. why it was skipped'),
    },
    async (rawParams) => {
      const userId = getUserId();
      const params = {
        ...rawParams,
        outcome: (rawParams.outcome === 'skipped' || rawParams.outcome === 'skip'
          ? 'skipped_deliberate'
          : rawParams.outcome) as 'done' | 'missed' | 'skipped_deliberate' | 'excused',
      };

      const habit = await repo.findById(userId, params.habit_id);
      if (!habit) {
        return errorResponse(`Habit not found: ${params.habit_id}`);
      }

      const now = localNow(habit.timezone);

      const dueDate = params.due_date ?? now.date;
      if (!DATE_RE.test(dueDate)) {
        return errorResponse(`Invalid due_date: ${JSON.stringify(dueDate)} (must be YYYY-MM-DD)`);
      }

      let dueTime = params.due_time;
      if (dueTime === undefined) {
        const nearest = nearestScheduledTime(habit.schedule.times, now.time);
        if (!nearest) {
          return errorResponse(
            `Ambiguous occurrence — habit "${habit.name}" has multiple scheduled times equally near; specify due_time`,
            { scheduled_times: habit.schedule.times },
          );
        }
        dueTime = nearest;
      }
      if (!TIME_RE.test(dueTime)) {
        return errorResponse(`Invalid due_time: ${JSON.stringify(dueTime)} (must be HH:MM, 24h)`);
      }

      const entry = await repo.logOutcome(userId, {
        habitId: habit.id,
        dueDate,
        dueTime,
        outcome: params.outcome,
        note: params.note,
      });
      logAudit({ user_id: userId, source: 'gtd', action: 'update', entity_type: 'habit_occurrence', entity_id: entry.id, summary: `Habit "${habit.name}" ${dueDate} ${dueTime}: ${params.outcome}` });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ occurrence: entry, habit: { id: habit.id, name: habit.name } }, null, 2),
        }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // list_habits
  // -------------------------------------------------------------------------
  server.tool(
    'list_habits',
    'List habit contracts with today\'s occurrence states (open / done / missed / skipped_deliberate / excused per scheduled time). Use to see what recurring commitments exist and where today stands — e.g. during the evening close or when the user asks about a habit.',
    {
      status: z.enum(['active', 'paused', 'retired']).optional().describe('Filter by status. Default: all'),
    },
    async (params) => {
      const userId = getUserId();
      const habits = await repo.list(userId, { status: params.status });
      if (habits.length === 0) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ habits: [] }, null, 2) }] };
      }

      // "Today" is habit-timezone-local, so habits may straddle two dates.
      // One log query covers the span; matching is done per habit below.
      const todays = habits.map((h) => localNow(h.timezone));
      const dates = todays.map((t) => t.date).sort();
      const entries = await repo.listLog(userId, { fromDate: dates[0], toDate: dates[dates.length - 1] });

      const result = habits.map((habit, i) => {
        const today = todays[i];
        const todayEntries = entries.filter((e) => e.habitId === habit.id && e.dueDate === today.date);

        // Scheduled occurrences (active habits only — paused/retired don't fire),
        // then any extra logged rows for today not on the schedule.
        const scheduledTimes = habit.status === 'active' && scheduledOnDay(habit.schedule, today.dayOfWeek)
          ? habit.schedule.times
          : [];
        const occurrences = scheduledTimes.map((time) => {
          const entry = todayEntries.find((e) => e.dueTime === time);
          return {
            due_time: time,
            outcome: entry?.outcome ?? 'open',
            note: entry?.note ?? null,
          };
        });
        for (const e of todayEntries) {
          if (!scheduledTimes.includes(e.dueTime)) {
            occurrences.push({ due_time: e.dueTime, outcome: e.outcome ?? 'open', note: e.note });
          }
        }

        return { ...habit, today: today.date, today_occurrences: occurrences };
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ habits: result }, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // habit_trends
  // -------------------------------------------------------------------------
  server.tool(
    'habit_trends',
    'Per-habit follow-through over trailing weeks: weekly completion rate (done / (done+missed+skipped)), current streak of all-done days (excused occurrences don\'t break streaks), and the last 10 misses/skips with notes. Use in the weekly review and when coaching — two skips in a week is a named observation, not silence.',
    {
      habit_id: z.string().optional().describe('Limit to one habit (UUID). Default: all habits'),
      weeks: z.number().int().min(1).max(26).optional().describe('Trailing 7-day windows to report. Default: 4'),
    },
    async (params) => {
      const userId = getUserId();
      const weeks = params.weeks ?? 4;

      let habits: Habit[];
      if (params.habit_id) {
        const habit = await repo.findById(userId, params.habit_id);
        if (!habit) return errorResponse(`Habit not found: ${params.habit_id}`);
        habits = [habit];
      } else {
        habits = await repo.list(userId);
      }
      if (habits.length === 0) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ trends: [], weeks }, null, 2) }] };
      }

      // One log query spanning the window (+1 day of slack for timezone skew).
      const todays = habits.map((h) => localNow(h.timezone).date);
      const minToday = [...todays].sort()[0];
      const fromDate = shiftDate(minToday, -(weeks * 7));
      const logFilters: { fromDate: string; habitId?: string } = { fromDate };
      if (params.habit_id) logFilters.habitId = params.habit_id;
      const entries = await repo.listLog(userId, logFilters);

      const trends = habits.map((habit, i) =>
        computeHabitTrend(
          habit,
          entries.filter((e) => e.habitId === habit.id),
          weeks,
          todays[i],
        ),
      );

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ trends, weeks }, null, 2) }],
      };
    },
  );
}
