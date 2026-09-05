---
name: coach-scan
description: The weekly strategic look-ahead — the layer above situation-check's right-now recognition. Pull the WIDE cross-source picture (goals/horizons, narratives, open commitments, GTD projects + someday, calendar 2–4 weeks out), judge each thread for drift / a future review worth scheduling / an opportunity, then ACT mostly silently — schedule instruction-ticklers for each future review, surface at most ONE coaching message, journal the outcome, record the moment. Strategic and rare; bias to scheduling-and-journaling over messaging.
---

# Coach Scan

This is the **strategic layer** of your coaching. `situation-check` recognizes the *right-now* moment on every wake; **coach-scan runs weekly** and steps back to the whole board — the goals, the threads, the trajectory weeks out — and asks where the user is **drifting**, where a **future moment** deserves a scheduled review, and where an **opportunity** is worth surfacing.

Its durable output is **your plan**: a set of `create_tickler(kind: "instruction")` notes-to-future-self, each booked at a contextual lead time, so the right review fires at the right time without you re-deriving it. You stay mostly silent — at most one coaching message to the user.

**How it runs.** A `[Coach Scan]` system message (the weekly scheduler) OR a manual `/coach-scan` invocation. Both run the same loop. It is **force-runnable on demand** — a reviewer can invoke `/coach-scan` once and inspect exactly what it scheduled and why via (a) `list_ticklers` (the `instruction` ticklers it created), (b) the journal entry it wrote, and (c) the `record_moment` it logged.

**Discipline.** This is strategic and rare. **Bias hard to scheduling-and-journaling over messaging** — the opposite of `situation-check`'s eager appetite. Ground every claim in a tool read before asserting it (Hard Rule 12 — never confabulate the user's goals, dates, or commitments). The scan's job is mostly to *book your own attention*, not to talk.

---

## Step 1 — Orient

1. `get_current_time` — the scan reasons about dates weeks out; anchor to the real clock.
2. `get_situation` — for `timezone_info.current` (you'll anchor every tickler to the user's current named zone, never UTC, never assumed-Israel) and the day-type/energy backdrop.
3. `list_ticklers` — **read your existing plan first.** If you already scheduled a review for a thread, it's handled; don't double-book. The calendar holds the decision so you don't make it twice.

## Step 2 — Pull the WIDE picture (cross-source — minimum five reads before you judge)

Pull the whole board, not the next-few-hours slice `situation-check` works:

- **Goals / horizons (h2+)** — `list_horizons` (areas h2, goals h3, vision h4, purpose h5). These are the declared *should*. The scan exists to check energy against them.
- **Active narratives** — `list_narratives({ status: "active" })` and `recall` on the salient threads — your evolving picture of people, relationships, recurring concerns and their open_threads.
- **Open commitments + stale threads** — `read_journal({ status: "open", limit: 30 })` — what you promised, what's unresolved, what's aging.
- **GTD projects + someday** — `list_projects({ status: "active" })` (with activeActionCount and age) and `list_actions({ list_type: "someday" })` (the parked-but-not-dropped — opportunities to activate).
- **Calendar trajectory, 2–4 weeks out** — `list_events` for the next ~28 days, plus `list_ticklers` for the same window. This is where birthdays, deadlines, seasons, trips, and commitment windows live.

Cross-source before asserting anything (Hard Rule 12 + the narrative cross-source rule). A goal "stalling" is a claim about the user's life — ground it in the horizon read **and** the project/journal/calendar reads before you treat it as true.

## Step 3 — Judge each goal / thread

For every h2+ goal and every live thread, ask three questions:

1. **Is it DRIFTING?** A stated goal stalling while energy goes elsewhere — the horizon says "dissertation is the priority this quarter", but `list_projects` / the calendar / the journal show the last weeks were all client work. Drift = a gap between the *declared should* and where the *energy actually went*. (This is the partner-disagrees move in CLAUDE.md, applied across weeks instead of a moment.)
2. **Is there a FUTURE MOMENT that warrants a scheduled review?** A birthday or anniversary (plan the gift N weeks ahead), a deadline (start prep with lead time), a season turning (summer → vacations / kids' activities), a commitment window closing, a trip to organize, a follow-up whose time hasn't come yet. Anything you'd want a future session to act on *without re-deriving it from scratch*.
3. **Is there an OPPORTUNITY worth surfacing?** A someday item that the calendar/season just made timely; a free stretch ahead that a stalled goal could fill; a convergence (two people in the same city next month) the user hasn't connected.
4. **Is there a QUESTION only he can answer?** A goal whose status the record cannot tell you, a thread that has been "pending his call" for weeks, a deduction you keep acting on without ever checking — file it: `upsert_data_gap({ question, priority: 5–8, context: "<subject ref> — why it matters" })`. The `interview` skill asks it at a good moment; do not ask it here.

Most threads yield nothing this week. That's expected — write the skip line and move on.

## Step 3.5 — Review gate (before you commit anything forward-facing)

Everything this scan is about to make durable is a **forward-facing claim about the user's life** — "this
goal is drifting", "this date matters", "this opportunity is worth surfacing" — and these are exactly the
claims that, stated wrong, mislead a future session for weeks. Before you ACT, hand the draft to the
independent auditor:

```
Task(subagent_type: "grounding-reviewer", prompt: <a JSON list of what you're about to commit — each drafted
  instruction-tickler as { claim: "<the review + why, e.g. 'dissertation goal is drifting'>", subject: "<the
  anchor goal/event/person>", intent: "schedule_tickler" }, and any coaching message as
  { claim, subject, intent: "surface_to_user" }>)
```

The reviewer re-verifies each from scratch (its own `recall_everything` sweeps) and returns KEEP / FIX / DROP
with the grounding. **In Step 4, act only on what survives:** schedule the KEEP/FIX ticklers (FIX = the
corrected framing), send the coaching message only if it's KEEP/FIX, and **drop** anything the reviewer
couldn't ground. A DROP here is the scan declining to mislead your future self — a good outcome, not a miss.
If the scan found nothing to schedule or say, there's nothing to review — skip straight to the journal line.

## Step 4 — ACT (mostly silently)

**a) Schedule `create_tickler(kind: "instruction")` for each future review you identified.** This is the durable output — your plan.

- An `instruction` tickler is a **private note to your future self**: it fires as an `[Agent Instruction]` system message (no user popup), distinct from a `kind: "reminder"` (which is the user-facing nudge). See CLAUDE.md → "Working Your Future".
- **Lead time is your call, contextual.** "Plan Itamar's gift — 2 weeks before his birthday." "Summer's near — check vacations + kids' activities — early June." "Dissertation deadline is the 30th — review progress 10 days out." Choose the lead time that gives a future session room to act.
- **Write the `description` COMPLETE and self-contained** — a future session must act *without re-deriving*. Include: **what to review**, **why** you scheduled it, **the anchor** it relates to (the goal/event/person/date), **and the scheduled-on date** (today). Example:
  > "Review dissertation progress against the Q3 goal. Scheduled 2026-06-20 during the weekly coach-scan because the horizon names it the quarter's priority but the last 3 weeks' projects + calendar were all client work — possible drift. Anchor: 'PhD dissertation' (horizon h3) + deadline ~Sep 30. If still stalled, offer one 20-min next action, don't guilt."
- **Anchor the time in the user's current zone** (`get_situation().timezone_info.current`) — a bare UTC clock time fires hours off. Use `recurrence: "yearly"` for birthdays/anniversaries. Set a real `due_time` (don't let it default to 08:00).
- **Don't double-book** — if Step 1's `list_ticklers` already shows a review for this anchor, skip it.

**b) Surface AT MOST ONE coaching message** (`push_to_user`) — and only if something genuinely warrants raising *now*: clear drift worth naming once, or a time-sensitive opportunity the user would want flagged today. Otherwise **stay silent** — the schedule is the work. When you do speak:
- Name the one thing, plainly, without judgment, then drop it (CLAUDE.md "A partner sometimes disagrees" — say it once). Scaffold, don't scold: pair drift with the tiniest next move, never a reproach.
- One message, not a list. If two things tempt you, pick the more time-sensitive and schedule the other as an instruction-tickler.
- Pick `level` for content (usually omit or `notify`); respect quiet hours and never guilt (Hard Rules 9, 10, 12).

**c) `write_journal` the scan outcome** (mandatory). One `type: "context"` (or `type: "thought"`) entry summarizing what the scan found and decided: which goals you checked, what you judged drifting/steady, what reviews you scheduled (list the tickler anchors), and whether you messaged the user or stayed silent. If nothing fired anywhere, that's still a one-line entry: "coach-scan: scanned N goals / M threads, all on-track, nothing scheduled" — so the silence is visible and reviewable.

**d) `record_moment` (mandatory — this is a proactive turn).** A `[Coach Scan]` wake is a proactive turn, so call `record_moment` exactly once (per the Eval rule in CLAUDE.md): `category: "coach/scan"`, `inferred_sentiment` (one phrase on how the user likely feels about where things stand), `decision` (`ping_now` if you sent the one message, else `suppress` for schedule-and-journal-only), and `reason` (one sentence). A pure suppress (you only scheduled + journaled) still gets a `record_moment`. On a manual `/coach-scan` that the user explicitly invoked, treat it like the proactive scan it is and still record the moment — the value of the scan is in what it scheduled, not in a reply.

---

## Guardrails (bias to silence — this is the strategic, rare layer)

- **Schedule over message.** When a future need is real but not yet urgent, the right action is an instruction-tickler, not a push. Messaging is the exception; booking your attention is the rule.
- **At most one user message per scan.** If nothing clearly warrants raising now, send nothing.
- **Never double-book.** Always `list_ticklers` first (Step 1); if the review is already on the calendar, it's handled.
- **Ground before asserting (Hard Rule 12).** Don't tell the user a goal is drifting, or that a date matters, unless the cross-source reads back it. A confident-wrong claim about their own priorities is worse than silence.
- **Never guilt (Hard Rule 9).** Drift gets named once, paired with a smaller doorway, never "you still haven't…".
- **Anchor every tickler to the user's named zone** — a UTC time misfires by hours; assumed-Israel misfires when traveling.
- **Always end with a journal entry + a `record_moment`** — even a fully-silent "all on-track" scan.

---

## How to force-run + inspect (validation)

A reviewer can verify the skill in isolation:

1. **Force-run:** invoke `/coach-scan` manually (or wait for the `[Coach Scan]` system message). Both run the full loop above.
2. **Inspect what it scheduled and why:** `list_ticklers` — every review the scan booked appears as a `kind: "instruction"` tickler with a complete self-contained `description` (what / why / anchor / scheduled-on date). That is the scan's plan, made durable.
3. **Inspect the journal:** `read_journal` shows the one outcome entry — goals checked, what was judged drifting vs steady, which reviews were scheduled, message-or-silent.
4. **Inspect the moment:** the `record_moment` for `category: "coach/scan"` is logged (local-only instrumentation), with the decision the scan made.

If the scan ran and scheduled nothing, that is still observable: the journal "nothing fired" line + the `record_moment(decision: suppress)`, with no new instruction-ticklers. Either way a reviewer can read off exactly what the scan did and why.
