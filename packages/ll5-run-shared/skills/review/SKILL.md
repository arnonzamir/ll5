---
name: review
description: Run a GTD weekly review — with the user (guided phase-by-phase conversation) or SOLO (the [Weekly Review — Solo Fallback] pass that always produces a one-pager). Either way the review happens; it never dies waiting.
---

# Weekly Review

This is the most important habit in GTD — it keeps the system trusted. **Two modes; the review always produces an outcome:**

- **With the user** (a `[Weekly Review]` nudge, or the user asks): the guided conversation below.
  **OPEN with the first concrete question of Phase 1 — never with options.** Not "want to do the
  review?" / "we could look at X or Y" — pull the inbox and lead: "Weekly review. First up: 'call the
  dentist' has sat in your inbox 12 days — is that a real action?" The session starts by starting.
- **SOLO** (a `[Weekly Review — Solo Fallback]` instruction — the user didn't engage): run the entire
  pass alone and deliver the one-pager (see "Solo mode" at the end). No waiting between phases, no
  questions mid-flight — decisions the user must make are collected, capped at 3, and asked at the end.

## With the user

Make it feel like a productive conversation with a well-prepared assistant, not a checklist. Work through these phases ONE AT A TIME. Wait for user input between phases. Be conversational.

## Phase 1 — Clear the Inbox

Call `list_inbox` (status: captured).

If empty: "Inbox is clear — nice work. Moving on."

If items exist: "You have N items in your inbox. Let's run through them."
Walk through each item one at a time:
- Present it with source and capture date
- Propose your best guess: "This looks like a @phone action — 'Call dentist.' Create it?"
- If the user agrees, create the action/project and mark the item processed via `process_inbox_item`
- If they say skip, mark as reviewed and move on
- Apply the two-minute rule: "This one's quick — can you do it now?"

## Phase 2 — Review Projects

Call `list_projects` (status: active).

"You have N active projects. Let me walk through them."

For each project:
- Show title and active action count
- If activeActionCount = 0: "This one has no next action. What's the next step?"
- If it seems stale (created long ago, few completions): "Still active, or should we park it in someday?"
- If healthy: "This one looks good — N actions in progress." (brief)

Don't linger on healthy projects. Spend time on stuck ones.

## Phase 3 — Waiting For

Call `list_actions` with list_type: "waiting", status: "active".

If empty: "Nothing on your waiting list. Moving on."

If items exist: "You're waiting on N things."
For each: show the person (waitingFor), the item title, and age in days.
- If > 7 days: "This one's been N days. Want to follow up?"
- If recent: just list it, no pressure

## Phase 4 — Someday/Maybe

Call `list_actions` with list_type: "someday".

If empty: skip.

"Quick scan of your someday list — anything you want to activate?"
Show the list. User can activate (change list_type to todo) or drop (mark completed/delete) items. Most will stay as-is — that's fine.

## Phase 5 — Calendar Look-Ahead

Call calendar MCP `list_events` for the next 7 days.
Call calendar MCP `list_ticklers` for the next 7 days.

"Your week ahead: [summary of events and upcoming ticklers]"
Flag any tight days, prep needs, or conflicts.

## Phase 6 — Narratives Sweep

Call `list_narratives({ status: "active", limit: 50 })`.

If empty: skip.

Walk the top 5–10 most-recently-touched narratives. For each:
- Read the title + summary aloud briefly: "Tamar's pregnancy and baby — your sister's first child, born late March, she was anxious about the delivery, baby is doing well."
- Ask if anything has shifted: "Anything new here?" — capture as `note_observation` if yes
- If observation_count has grown 5+ since last_consolidated_at: silently call `consolidate_narrative` and `upsert_narrative` to refresh the summary
- If the user says it's done ("the bookshelf is built", "Tamar's mat leave is over"): `upsert_narrative({ status: "closed", closed_reason: "..." })`
- If a narrative has been quiet for 60+ days with no new signal: ask "Still alive, or should we mark this dormant?"

Don't walk every narrative. Focus on the live ones; closed/dormant stay quiet.

For dormant-but-stale-and-spiking ("haven't heard about Itamar's class trip in a month, then 3 messages this week"): mention it once, ask if there's an update worth capturing.

## Phase 7 — Mind Sweep

"Last thing — anything on your mind we haven't captured? Work stuff, personal, something someone said this week, a nagging thought?"

Prompt by category if the user needs help:
- Work?
- Home?
- Health?
- Money?
- People you need to get back to?

Capture everything via `capture_inbox`.

## Close

"Review complete. You have N active projects, all with next actions. N things on your waiting list. [Week ahead highlight if available]. You're in good shape."

## Adapt

- If the system is clean (inbox empty, projects current): compress. "Everything looks great. Just a couple things to check..."
- If the user seems tired: "We've covered the big items. Want to do someday + sweep another time?"
- A partial review is infinitely better than a skipped one.

## Solo mode — `[Weekly Review — Solo Fallback]`

The user didn't pick up the session; the review happens anyway. Run the whole pass yourself — same
data as the phases above (`list_inbox`, `list_projects`, `list_actions` waiting/someday, `list_events`
+ `list_ticklers` 7 days, `list_narratives`, `habit_trends`) — and act with the independence you apply
to capture. Then deliver **ONE one-pager** at notify level:

1. **State of the system** — active projects (how many with no next action), inbox size, overdue count,
   stale waiting-fors. Numbers and deltas, not a lecture.
2. **Archive proposals — proposed AND staged, never silent-deleted.** Anything untouched **30+ days** →
   move to someday (`update_action(list_type: 'someday')`), listed in the one-pager so the user can veto.
   Grocery-type items sitting in next-actions → route to the shopping list (`manage_shopping_list`).
3. **The rebuilt suggestible pool** — after the hygiene pass, name what the free-block engine now draws
   from ("live pool: the 6 actions that survived — top three fits for an open hour: …"). A stale pool
   poisons every free-block suggestion; this is the line that proves it's fresh again.
4. **Habit trends** — one line from `habit_trends`; two skips in a week on one habit = a named
   observation + smaller-doorway offer.
5. **AT MOST 3 decisions for the user — filed as tray cards, not chat questions.** For each decision
   that genuinely needs them, call `add_tray_item`: the one question, a one-line context, 2-3 options
   with `recommended: true` on YOUR pick, `default_key` = your pick, and `expires_days` landing on
   **next Thursday** (the card discloses "Thu default: …"). The phone shows them as one-tap A/B/C
   cards — no short replies scrolling away in chat. The one-pager still goes to chat and NAMES the
   filed cards in one line ("3 decisions on your tray: ROI project, kitchen reno, Dana follow-up"),
   but does NOT re-ask them. Each answer (or Thursday's expiry) comes back to you as a `[Decision]`
   system message — apply it then. Everything else you decided; you say what you did.

One message. Every mutation is named in it (nothing silent), overdue items get mentioned once and
gently (Rule 9), and the review is DONE when it lands — not pending a reply: the tray cards conclude
on their own (answered or Thursday-defaulted), so the review never dies waiting.
