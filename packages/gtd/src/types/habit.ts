// Habit contracts (DECISION-019): a habit is a recurring commitment with a
// schedule, an escalation policy, and a per-occurrence outcome log. The gateway
// HabitScheduler fires the escalation steps; the gtd MCP owns the store and the
// agent-facing tools.

export type HabitCheckKind = 'gtd_action' | 'user_confirm' | 'data';
export type HabitStatus = 'active' | 'paused' | 'retired';
export type HabitOutcome = 'done' | 'missed' | 'skipped_deliberate' | 'excused';
export type EscalationLevel = 'silent' | 'notify' | 'alert' | 'critical';

/** days: 'daily' or days-of-week ints (0=Sunday); times: local "HH:MM" strings. */
export interface HabitSchedule {
  days: 'daily' | number[];
  times: string[];
}

/** One escalation step: fire at due time + offset_minutes at the given level. */
export interface EscalationStep {
  offset_minutes: number;
  level: EscalationLevel;
}

export interface Habit {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  schedule: HabitSchedule;
  checkKind: HabitCheckKind;
  checkConfig: Record<string, unknown>;
  escalation: EscalationStep[];
  status: HabitStatus;
  timezone: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface HabitLogEntry {
  id: string;
  habitId: string;
  userId: string;
  dueDate: string; // YYYY-MM-DD
  dueTime: string; // HH:MM
  dueAt: Date | null;
  outcome: HabitOutcome | null;
  closedAt: Date | null;
  note: string | null;
  stepsFired: unknown[];
  createdAt: Date;
}

export interface CreateHabitInput {
  name: string;
  description?: string;
  schedule: HabitSchedule;
  checkKind: HabitCheckKind;
  checkConfig?: Record<string, unknown>;
  escalation: EscalationStep[];
  timezone?: string;
}

export interface UpdateHabitInput {
  name?: string;
  description?: string | null;
  schedule?: HabitSchedule;
  checkKind?: HabitCheckKind;
  checkConfig?: Record<string, unknown>;
  escalation?: EscalationStep[];
  status?: HabitStatus;
  timezone?: string | null;
}

/** Upsert: closes the occurrence even if the scheduler hasn't created it yet. */
export interface LogHabitOutcomeInput {
  habitId: string;
  dueDate: string; // YYYY-MM-DD
  dueTime: string; // HH:MM
  outcome: HabitOutcome;
  note?: string;
}

export interface HabitFilters {
  status?: HabitStatus;
}

export interface HabitLogFilters {
  habitId?: string;
  /** Inclusive due_date lower bound (YYYY-MM-DD). */
  fromDate?: string;
  /** Inclusive due_date upper bound (YYYY-MM-DD). */
  toDate?: string;
}

// ---------------------------------------------------------------------------
// Trends (habit_trends tool)
// ---------------------------------------------------------------------------

export interface HabitWeekStats {
  weekStart: string; // YYYY-MM-DD, inclusive
  weekEnd: string;   // YYYY-MM-DD, inclusive
  done: number;
  missed: number;
  skipped: number;
  excused: number;
  /** done / (done + missed + skipped); excused excluded. Null when no closed occurrences. */
  completionRate: number | null;
}

export interface HabitMissEntry {
  dueDate: string;
  dueTime: string;
  outcome: HabitOutcome;
  note: string | null;
}

export interface HabitTrend {
  habitId: string;
  name: string;
  status: HabitStatus;
  weekly: HabitWeekStats[];
  /**
   * Consecutive days (ending today, walking backward) where every closed
   * occurrence is done. Excused occurrences and days with no occurrences are
   * neutral — they neither break nor extend the streak. Bounded by the
   * trends window.
   */
  currentStreakDays: number;
  /** Last 10 missed / skipped_deliberate occurrences, most recent first. */
  recentMisses: HabitMissEntry[];
}
