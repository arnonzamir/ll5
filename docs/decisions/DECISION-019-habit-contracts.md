# DECISION-019 — Habit contracts: generalize the Ritalin escalation into a first-class primitive

Status: accepted — 2026-07-02

## Context

The Jun 25 – Jul 2 audit shows a sharp asymmetry in habit follow-through:

- **The Ritalin loop works.** Daily 3-dose schedule, each dose backed by recurring
  `create_wake` steps (silent pre-check → notify → second ask → CRITICAL/
  STREAM_ALARM), each step idempotent against a daily GTD action. On Jul 2 the
  user only confirmed at the 09:25 CRITICAL step — the escalation is doing real
  work. Food bright-lines, weight, and sleep framing also persist because
  ticklers/health-polling drive them.
- **Everything without deterministic machinery decays.** Training skips ("And
  yes, I'll skip km" — second skip that week) were absorbed with no follow-up;
  the "coffee vs nap" question got no closure; no habit has a visible trend.

The Ritalin pattern is hand-rolled: 9+ individually-created wakes whose escalation
policy lives in free-text payloads, no completion history beyond scattered GTD
actions, no trend surfacing, and creating the next habit means hand-crafting the
whole chain again. The system's proven lesson (DECISION-015/016/018): behavior
that must persist needs a first-class, deterministic primitive.

## Decision

A **habit contract** entity owned by the gtd MCP (habits are commitments — PG,
relational, state transitions; and the gtd tables live in the same `ll5` database
the gateway already reads for GTD health).

- **Store:** new PG table `gtd_habits` — `id`, `user_id`, `name`, `description`,
  `schedule` (JSONB: days-of-week + local times, tz-resolved like ticklers),
  `check_kind` (`gtd_action` — a daily action auto-created and checked, the
  Ritalin shape | `user_confirm` — the beat asks | `data` — verified against a
  data source, e.g. health activities for training, sleep index for the sleep
  timer), `check_config` (JSONB: action-title template / query params),
  `escalation` (JSONB: ordered steps `{offset_minutes, level}` with levels
  silent/notify/alert/critical), `status` (`active`|`paused`|`retired`),
  timestamps. Plus `gtd_habit_log` — one row per scheduled occurrence:
  `habit_id`, `due_at`, `outcome` (`done`|`missed`|`skipped_deliberate`|
  `excused`), `closed_at`, `note`. **The log is the point** — it's what makes
  trends, streaks, and skip-patterns queryable instead of archaeological.
- **Agent surface (gtd MCP tools):** `create_habit`, `update_habit`,
  `log_habit_outcome`, `list_habits`, `habit_trends({habit_id?, weeks})` —
  per-habit completion rate, current streak, recent misses with notes.
- **Firing (gateway `HabitScheduler`):** reads active habits + today's log rows
  each tick (60s, same shape as `WakeScheduler`); at each due step with the
  occurrence still open, inserts an `[Habit Check]` agent instruction naming the
  habit, the step's level, and the check to perform. Idempotent by design: a
  logged outcome closes the occurrence and silences remaining steps. An
  occurrence never closed by end-of-day is auto-logged `missed` — misses are
  data, not silence.
- **Where outcomes surface:** the evening close (DECISION-018) reports today's
  habit outcomes; the weekly review (session or solo) includes `habit_trends` —
  a **skip-pattern is a coaching trigger** (two skips in a week = a named
  observation with a smaller-doorway offer, per the coach persona), which is the
  "improving habits and abilities" loop the vision promises but nothing
  currently drives.
- **Migration:** Ritalin becomes the first habit contract (3 habits: AM/PM/
  late-PM doses, `check_kind: gtd_action`, current 4-step escalations as
  `escalation` JSON) — retiring ~9 hand-rolled recurring wakes. Next candidates:
  training (check_kind `data` against health activities, skip-aware), sleep
  timer, bright-lines day-clear.

## Alternatives considered

- **Status quo — hand-rolled wakes per habit.** Works for Ritalin but doesn't
  scale (N wakes per habit, policy in free text), has no outcome history, and
  can't answer "how's the training habit trending?" Rejected.
- **Habits as narratives** (personal-knowledge). Narratives are observational
  rollups, not schedulable commitments with escalation state machines; the
  consolidation loop would fight the scheduler for ownership. Rejected.
- **Habits in awareness ES next to wakes.** Keeps the firing store in one place,
  but the outcome log is relational (joins to GTD actions, per-occurrence state
  transitions, weekly aggregates) and habits are semantically GTD commitments.
  PG + gtd MCP is the right owner; the gateway already reads that DB.
- **A generic "escalation policy" attachment on wakes.** Closer, but still no
  outcome log or trends — the log is the actual missing capability.

## Consequences

- Creating a new habit becomes one tool call instead of hand-crafting a wake
  chain; escalation and outcomes become data.
- Habit trends become a standing input to weekly review and evening close —
  coaching gets a factual substrate (streaks, skip patterns) instead of relying
  on the agent remembering.
- New surface: one migration (2 tables), ~5 gtd tools, one gateway scheduler
  (+ tests). Deploy = gtd + gateway together; ll5-run persona/skills reference
  the new tools.
- The Ritalin path (health-critical) migrates: run habit contracts and existing
  wakes in parallel for a few days, verify `[Habit Check]` firing + escalation
  end-to-end, then cancel the legacy wakes.
- Auto-logged `missed` rows risk unfair data when life intervenes — the
  `excused`/`skipped_deliberate` outcomes plus evening-close reconciliation keep
  the log honest.
