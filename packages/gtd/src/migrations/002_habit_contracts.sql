-- GTD MCP: Habit contracts (DECISION-019)
-- Generalizes the hand-rolled Ritalin escalation chain into a first-class
-- primitive: a habit is a recurring commitment with a schedule, an escalation
-- policy, and a per-occurrence outcome log. The gateway HabitScheduler reads
-- these tables directly (same ll5 database) — schema shape is a shared contract.
-- All statements are idempotent (IF NOT EXISTS) — the runner re-runs every file.

CREATE TABLE IF NOT EXISTS gtd_habits (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT,
  -- {"days": "daily" | [0..6 ints, 0=Sunday], "times": ["HH:MM", ...]}
  schedule        JSONB NOT NULL,
  check_kind      TEXT NOT NULL
                    CHECK (check_kind IN ('gtd_action', 'user_confirm', 'data')),
  check_config    JSONB NOT NULL DEFAULT '{}',
  -- Ordered steps: [{"offset_minutes": int, "level": "silent"|"notify"|"alert"|"critical"}, ...]
  escalation      JSONB NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'paused', 'retired')),
  timezone        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_habits_user_status ON gtd_habits(user_id, status);

-- One row per scheduled occurrence. The log is the point (DECISION-019):
-- trends, streaks, and skip patterns become queryable instead of archaeological.
CREATE TABLE IF NOT EXISTS gtd_habit_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  habit_id        UUID NOT NULL REFERENCES gtd_habits(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL,
  due_date        DATE NOT NULL,
  due_time        TEXT NOT NULL,
  due_at          TIMESTAMPTZ,
  outcome         TEXT CHECK (outcome IN ('done', 'missed', 'skipped_deliberate', 'excused')),
  closed_at       TIMESTAMPTZ,
  note            TEXT,
  -- Escalation steps already fired for this occurrence (scheduler-owned).
  steps_fired     JSONB NOT NULL DEFAULT '[]',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (habit_id, due_date, due_time)
);

CREATE INDEX IF NOT EXISTS idx_habit_log_user_due_date ON gtd_habit_log(user_id, due_date);
CREATE INDEX IF NOT EXISTS idx_habit_log_habit_due_date ON gtd_habit_log(habit_id, due_date);
