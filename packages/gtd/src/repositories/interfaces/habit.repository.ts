import type {
  Habit,
  HabitLogEntry,
  CreateHabitInput,
  UpdateHabitInput,
  LogHabitOutcomeInput,
  HabitFilters,
  HabitLogFilters,
} from '../../types/index.js';

export interface HabitRepository {
  create(userId: string, data: CreateHabitInput): Promise<Habit>;
  update(userId: string, id: string, data: UpdateHabitInput): Promise<Habit>;
  findById(userId: string, id: string): Promise<Habit | null>;
  list(userId: string, filters?: HabitFilters): Promise<Habit[]>;

  /**
   * Close (or pre-create and close) one occurrence. Upserts on
   * (habit_id, due_date, due_time) so the user can confirm before the
   * scheduler has created the row; on conflict only outcome/closed_at/note
   * are updated (steps_fired stays scheduler-owned).
   */
  logOutcome(userId: string, data: LogHabitOutcomeInput): Promise<HabitLogEntry>;

  /** Log entries scoped to the user, filtered by habit and due_date range. */
  listLog(userId: string, filters?: HabitLogFilters): Promise<HabitLogEntry[]>;
}
