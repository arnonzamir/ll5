# DECISION-020 — Grounded action: use everything the system knows, before acting or asserting

Status: accepted — 2026-07-02

## Context

The user's explicit expectation: *"I expect it to always use any available data
item while and before acting or suggesting."* The Jun 25 – Jul 2 audit shows the
opposite happening in two directions:

**Asserting from inference what a sensor/store could answer** — five trust-eroding
incidents in one week:

1. "can you not see the wifi im on?" — agent leaned on GPS+meeting-room inference
   instead of reading the wifi anchor it has.
2. "No sunbit meetings on Saturday" — stale `next_event` asserted as fact.
3. A stale-thread ping the user had already answered; the "you did answer" recovery
   was itself an inference — for that thread the agent only sees the inbound side
   ("did you get my side too?" → "Honest answer: no").
4. "יתפנה למחר" translated to the wrong absolute day; the slot passed — a real-cost
   MISS.
5. "Why not?? You can see the conversation with the sitter just like I can."

~20% of the user's messages that week were system-troubleshooting — the user is
doing QA the grounding discipline should prevent.

**Not bringing known data to the moment of action** — the Hen 1:1 sat on the
calendar all morning; the agent had a person record, narratives, and an open Apr 9
"Fill in PIP form for Hen" action, and surfaced none of it until the user explained
what the meeting was. Tool telemetry confirms the skew: in the audited week the
agent made 3,530 `list_narratives` / 1,892 `recall_lessons` / 1,832 `write_journal`
calls (mostly self-maintenance loops) against `get_situation` 41, `list_events` 31,
`get_person` 13, `recall_everything` 66 — the wide memory exists and is barely
consulted at decision points.

## Decision

Make grounding a **checkable contract**, not a virtue: deterministic guards where
the failure is mechanical, a persona hard rule with a per-claim-class lookup map
where it's judgment, and a governor metric so ungrounded action is visible.

### 1. Sensor-before-assertion (persona hard rule + lookup map)

New ll5-run Hard Rule: **never assert or act on something a tool can answer
without calling the tool this turn.** Shipped with a claim-class → source map in
the persona: physical state → `where_is_user` (wifi/GPS/motion, never inferred);
schedule claims → `list_events`/`list_ticklers` live (never a cached
`next_event`); "did X reply / is this thread stale" → `query_im_messages` for the
actual thread; task/commitment claims → GTD queries; person/topic context →
`get_person` + narratives + `recall_everything`. Hedging language ("probably at
the office") is only permitted when the source was checked and is genuinely
stale/ambiguous — and then the staleness is stated.

### 2. Prep dossier obligation (the Hen case, generalized)

The calendar-review / meeting-prep path must, for each upcoming event with named
participants or a resolvable topic, pull the dossier **before** the brief: person
records, active narratives (`get_narrative` + connections), open GTD
actions/waiting-fors mentioning the participants, and recent thread activity. The
brief leads with what the system already knows ("open since Apr 9: PIP form for
Hen"). This is the concrete meaning of "use any available data item before
suggesting" at the daily beat where it matters most.

### 3. One-sided-thread guard (deterministic)

Incidents 3/5 were mechanical: staleness/unanswered tracking ran on threads where
outbound capture doesn't exist. Messaging MCP computes per-conversation
**outbound visibility** (any outbound row for the conversation in a trailing
window, or capability flag on the account); `query_im_messages` returns it as
`visibility: full | inbound_only`, and every staleness/unanswered-tracker path
(persona + composite triggers) must skip `inbound_only` threads for
"you-haven't-replied" claims — or state the blindness explicitly when the thread
is still worth surfacing.

### 4. Relative-time resolution guard (deterministic-ish)

Rule + format contract: any relative time expression in source material ("מחר",
"יתפנה למחר", "השבוע", "in an hour") is resolved against the **source message's
timestamp** (not "now"), and every user-facing schedule commitment states the
resolved absolute day/date ("tomorrow (Fri Jul 3)"). Cheap to follow, and makes
the class-4 error visible at a glance when it happens.

### 5. Governor: grounding becomes measurable

`eval_record.py` already parses the turn transcript per proactivity moment. It
gains a `grounding_calls` count (lookup-class tool calls this turn:
recall/situation/events/person/thread queries) shipped with each eval moment. New
anomaly check `behavior.ungrounded_pings`: `ping_now` moments with
`grounding_calls == 0` rising vs baseline → warning to the agent. Complements the
`decision_mismatch` and `ping_later` metrics from the same pipeline.

### 6. Instrumentation verification (precondition)

Before trusting these metrics: verify the 138 `claimed suppress / actual
ping_now` mismatches (Jun 27 – Jul 2) and the inverted Jul 1 distribution
(131 ping_now / 28 suppress) — likely recorder semantics (moment recorded before
delivery, or the 3-way change) rather than behavior. Fix the recorder if so.

## Alternatives considered

- **Persona rule alone.** The existing persona already says forward-looking,
  cross-source-before-asserting (coach-scan does it) — and the week's incidents
  happened anyway. Rejected as sole mechanism; rules need the deterministic
  guards + the metric.
- **Force a recall_everything on every turn (hook-injected).** Maximally
  grounded, but adds latency + tokens to hundreds of daily system-trigger turns
  where nothing user-facing happens; the audit shows the problem is at *action
  points*, not every turn. Rejected — target the claim classes and the ping
  moments instead.
- **Deterministic pre-fetch (gateway embeds dossier data in every calendar-review
  nudge).** Attractive for prep (no agent judgment needed) — kept as a fallback:
  if the dossier obligation doesn't move behavior within two weeks (measured by
  grounding_calls on prep turns), embed person/action lookups directly in the
  nudge payload the way evening-close embeds staged items (DECISION-018).

## Consequences

- Trust incidents of classes 1-5 get structural fixes, not apologies; the
  troubleshooting share of user messages becomes a KPI that should fall.
- Prep briefs start from what the system knows — the wide memory finally shows up
  at decision points, and its use is measured per moment.
- New surface: messaging visibility computation + field, eval recorder field +
  one anomaly check, persona hard rule + lookup map, calendar-review skill
  changes (+ tests). No new stores.
- Slight latency/token cost on user-facing action turns (a few lookups) — bounded
  by targeting claim classes, not all turns.
