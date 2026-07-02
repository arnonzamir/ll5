# DECISION-018 — Companion planning rhythm: plan beats, staged-item collection, weekly session with solo fallback

Status: accepted — 2026-07-02

## Context

A full system + audit review (Jun 25 – Jul 2, 2026: 932 eval moments, 27 sessions,
week of journal/GTD/chat telemetry) found the system excellent at running the day
that already exists (morning decision-locks, in-day logistics) and weak at planning
*forward* and planning *together*:

- **Forward planning is measurably absent.** Since `ping_later` became eval ground
  truth (2026-07-01), it occurred **once in 932 moments**. The persona rule
  ("commit the prep, don't just name it") did not move behavior.
- **Silent delivery is a black hole.** Free-block proposals, GTD triage offers, and
  prep plans are "staged silently" in the chat thread and get zero engagement —
  the forward planning isn't hidden, it's *published where the user doesn't look*.
  User engagement fell from 20-36 messages/day to 6-8 by Jul 1-2.
- **The weekly review never happens.** The Jun 25 [Weekly Review] trigger said "run
  it WITH them"; the agent sent "options" and waited forever. No evening review
  exists at all. Inbox grew 40→48 over the week, overdue 57→76.
- **GTD is rotting**, which poisons free-block suggestions (the agent itself noted
  "the action list is 2-3 months stale"); groceries sit in next-actions.

The pattern across all of this (and the lesson of DECISION-015/016): **only
deterministic machinery survives; agent initiative and user pickup both decay.**

## Decision

Wire the planning rhythm as deterministic machinery around two daily **plan beats**
and one weekly **session**, with collection and fallback contracts so nothing
depends on the agent choosing to plan or the user happening to scroll.

### 1. Evening close beat (new)

A new gateway scheduler (`evening-close.ts`) fires once per evening (default 20:30
local, knob `user_settings.scheduler.evening_close_*`) inserting an
`[Evening Close]` system message. The nudge is **self-carrying**: the gateway
itself queries the day's unengaged staged items and embeds them, so collection does
not depend on agent recall:

- today's assistant chat messages delivered at silent/staged level with no
  subsequent user message in the conversation (PG `chat_messages` query);
- open journal entries created today (via awareness ES, same pattern as
  journal-health);
- today's habit checks and their outcomes (DECISION-019, once shipped).

The agent's job (new ll5-run skill `evening-close`): a **2-minute close** — today's
loose ends (max 3), *tomorrow's one thing* (same discipline as the morning brief's
"one decision"), habit outcomes, and a pick-up/drop call on each embedded staged
item. Delivered at notify level; one message.

### 2. Staged-item delivery contract

Anything the agent stages at silent level is no longer fire-and-forget: it either
(a) gets collected into the next beat by the gateway query above, or (b) the agent
books a `create_wake` to the next beat itself. Persona amendment: *a silent
staging is a deferral, not a delivery* — every staged item must have a beat where
it resurfaces at notify level or is explicitly dropped.

### 3. Weekly review = session with a solo fallback

The `WeeklyReviewScheduler` (Fri 14:00) changes contract:

- **Visible commitment:** it books the review as a real calendar block (tickler,
  `kind: reminder`) so the session exists on the user's calendar, not just as a
  nudge.
- **Session opening:** the nudge instructs the agent to open with the **first
  concrete question** of the review (never "want to do the review?" / "options").
- **Solo fallback (the key change):** the scheduler books a follow-up check
  (+45 min). If the user hasn't engaged, the agent runs the review **solo** and
  delivers a one-page outcome: state of projects/inbox/overdue, what it archived
  or proposes to archive, and **at most 3 decisions that need the user** —
  answerable by short reply.
- **GTD hygiene forcing function inside the solo pass:** propose-to-archive
  anything untouched 30+ days (move to someday, never silent-delete), route
  grocery-type items to the shopping list, and rebuild the "suggestible pool" the
  free-block engine draws from so suggestions stop being stale.

### 4. Prep commitment in the daily loop, with a measured floor

The `[Calendar Review]` nudge gains a mechanical obligation: for each
prep-needing event in the next 48h, **book the prep this turn** (`create_wake` /
tickler) — naming it is not enough (this is what `ping_later` now measures). A new
anomaly check (`behavior.forward_work_stalled`, one object in `buildChecks()`)
warns when no `ping_later` eval moment occurred in 48h — the deterministic
backstop for the persona rule that demonstrably didn't self-enforce.

### 5. Plan as an artifact (later phase)

The day's plan (morning decision + evening-close "tomorrow's one thing" + booked
preps) becomes a queryable object surfaced as a **Today card** on dashboard +
Android, instead of living only in chat scroll. Phased after the beats prove out.

## Alternatives considered

- **Push harder on persona rules** ("actually run the review", "commit the prep").
  Already tried; the eval governor shows persona alone doesn't change behavior
  (1/932 `ping_later`, weekly review dropped despite explicit instruction).
  Rejected as sole mechanism — rules stay, but machinery enforces.
- **A new "staged items" store** (dedicated ES index for proposals). Rejected:
  the data already exists in `chat_messages` (delivery level + engagement) and the
  open journal; a gateway query at beat time is zero new agent obligations and no
  new write path.
- **Raising default delivery levels** (stop staging silently). Rejected: restraint
  is correct — the failure isn't staging, it's staging *without a resurface
  contract*. Raising levels would recreate the noise problem the suppress
  discipline solved.
- **User-initiated weekly review only** (wait until asked). Rejected: five weeks of
  evidence says it never happens; the review's value (GTD hygiene feeding daily
  suggestions) is systemic, not optional.

## Consequences

- Two new deterministic beats bracket the day; the agent's good-but-silent forward
  work gets a guaranteed audience twice a day at low interrupt cost.
- The weekly review always produces an outcome — with the user when he engages,
  solo one-pager when he doesn't. GTD stops rotting either way.
- New surface: one scheduler + one skill + nudge-text changes + one anomaly check
  (+ tests). Calendar-review nudge text changes ship with ll5-run + gateway
  together.
- Persona gains the staging contract; governor gains a forward-work floor.
- Risk: the evening beat becomes another ignored ping — mitigated by the one-
  message / max-3-items / one-decision discipline that already works mornings, and
  measured by per-beat engagement (see implementation plan KPIs).
