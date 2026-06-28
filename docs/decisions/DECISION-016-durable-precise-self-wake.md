# DECISION-016 — Durable precise-time self-wake (`scheduled_wakes`)

Status: accepted — 2026-06-28

## Context

The agent had two ways to schedule its own future action, and neither gives a
**durable, precise-time** self-wake:

- **`CronCreate`** (Anthropic-side session cron) — precise to the minute, but
  **session-scoped**: invisible/unmanageable after a restart or compaction, and
  effectively lost. Hard-blocked 2026-06-27 (`cron-block.sh`, Hard Rule 6) after a
  real "brothers-trip" watch was lost this way.
- **Ticklers** (Google-Calendar-backed, via the google MCP) — durable, but
  **coarse**: the gateway `TicklerAlertScheduler` fires an `[Agent Instruction]`
  the moment a tickler enters a **2-hour lookahead window**, once per day — not at
  the tickler's start minute. Four escalation steps at 08:45/09:00/09:10/09:25
  created at a 07:20 anchor would all fire in a clump ~07:20.

The forcing case: the **Ritalin AM escalation**. Its tickler instructed the agent
to "arm a 4-step session cron chain" — exactly the precise-time primitive that no
longer exists. Post-block, the agent hits the cron deny daily and improvises
(`cron=5` blocked attempts/day in the behavior watch). The gap is general: the
agent has demonstrated need (132 historical CronCreate calls) for precise durable
self-wakes.

## Decision

Add a first-class **precise-time self-wake** primitive, owned by the awareness
domain, fired by the gateway scheduler host.

- **Store:** a new Elasticsearch index **`ll5_scheduled_wakes`** (awareness).
  Fields: `id`, `user_id`, `fire_at` (ISO), `recurrence` (null | `daily` | `weekly`
  | `weekdays` | RRULE-lite), `payload` (the instruction text the future session
  receives), `kind` (`instruction` agent-private | `reminder` user-facing),
  `status` (`pending` | `fired` | `cancelled`), `source`, `created_at`,
  `fired_at`, `last_fired_at`. Chosen over Postgres because the **gateway scheduler
  reads awareness ES directly today** (composite-triggers, heartbeat, journal-health)
  on a single `DATABASE_URL` that only reaches the gateway's own PG — ES keeps the
  "scheduler reads the store directly" pattern with no new DB wiring. Single-writer
  fire-status + in-memory dedup (as `TicklerAlertScheduler` already does) covers the
  lack of ES transactions at 60s granularity.

- **Agent surface (awareness MCP):** `create_wake({fire_at, payload, kind?,
  recurrence?, source?})`, `list_wakes({status?, from?, to?})`, `cancel_wake({id})`.
  Self-scheduling sits naturally beside the agent's other temporal/situational
  awareness tools (journal, statuses, recall).

- **Firing (gateway `WakeScheduler`):** ticks every 60s, selects `status=pending
  AND fire_at <= now`, and for each inserts a system message — `[Agent Instruction]`
  for `kind=instruction` (agent-private, no push) or a user-facing nudge for
  `kind=reminder` — then marks `fired` (one-off) or advances `fire_at` to the next
  occurrence (recurring). Wrapped in `withSchedulerHealth`; registered in
  `scheduler/index.ts`. **No active-hours gate** — a precise wake fires at the
  minute the agent chose (the agent owns the timing decision, incl. night
  restraint).

## When the agent uses which

- **`create_wake`** — a purely operational, precise self-wake: "re-check the dose at
  09:10", "poll the deploy in 8 minutes", staged escalations. Agent-internal; does
  not belong on the user's calendar.
- **Tickler** (`create_tickler`) — a real-world, user-meaningful temporal nudge that
  belongs on the LL5 System calendar (a reminder the user might see), or a coarse
  "sometime around X" self-review where 2h lookahead is fine.
- **`CronCreate`** — never (blocked).

## Ritalin migration

Replace the "arm a session cron chain" playbook with **4 recurring daily wakes**
(`recurrence: daily`, `kind: instruction`) at 08:45 / 09:00 / 09:10 / 09:25, each
**idempotent**: check today's `Ritalin 40mg AM` GTD action; if completed → no-op; if
still open → escalate at that step's level (09:25 = CRITICAL / STREAM_ALARM). The
07:20 anchor tickler keeps only its "create today's dose GTD action" job. Escalation
self-cancels because each step re-checks and no-ops once the dose is logged. Wakes
are internal (not calendar events), so daily escalation steps don't pollute the
calendar.

## Alternatives considered

- **Precise-fire flag on ticklers** (add `precise` to `create_tickler` + a precise
  path in `TicklerAlertScheduler`). Least new code, reuses the durable store/tool —
  but overloads calendar semantics (internal wakes become daily calendar events) and
  couples internal scheduling to Google Calendar auth/availability. Rejected: a
  dedicated primitive is cleaner and keeps internal wakes off the calendar.
- **Postgres store (gateway or gtd PG).** PG is the nicer fit for a fire-once state
  machine, but the gateway can't read the gtd PG (single `DATABASE_URL`), and putting
  it in the gateway PG leaves no natural MCP tool home. Rejected for ES, which the
  gateway already reads and the awareness MCP already owns.

## Consequences

- The agent gains a durable precise self-wake — `CronCreate` is fully retired with a
  real replacement, ending the daily blocked-cron churn.
- Two self-scheduling mechanisms (wakes vs ticklers) — disambiguated by the rule
  above; persona Hard Rule 6 updated to route precise self-wakes to `create_wake`.
- New surface to maintain: one ES index, three MCP tools, one scheduler (+ tests).
- Health-critical path (Ritalin) migrates onto it — deploy awareness + gateway
  together, verify firing before retiring the cron-chain playbook.
