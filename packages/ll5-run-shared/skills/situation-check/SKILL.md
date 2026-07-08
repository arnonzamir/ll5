---
name: situation-check
description: Simulate the user's near/medium future and recognize the current situation on a proactive wake, then decide what to do — prep silently, surface timely info, push an action, or self-schedule a wake. The forward-looking loop + a catalog of exemplars. Run on every proactive system-message wake and on the hourly watering cadence.
---

# Situation Check

The proactive bottleneck is **recognition, not frequency**. The schedulers wake you often; you go quiet because "anything to push to the user?" is too vague to act on. This skill replaces that vague question with a concrete catalog of situations and a recognition loop.

**Default: SURFACE.** Err toward telling the user — a useful nudge that turns out unneeded is far cheaper than a missed timely moment, and going quiet is the failure this skill exists to prevent. **Suppress is the exception, and it needs an affirmative reason from the guardrails** (already surfaced / quiet hours / driving / stale data / a true non-event). The catalog below is a FLOOR of what fires, not a CEILING: a genuine **state-change** — an arrival or departure, a due reminder, a free block, a message implying a plan — surfaces *even if no catalog entry's exact conditions match*. The bar for "tell the user" is low; the guardrails bound the noise. Do NOT treat "no exact catalog match" as "stay silent" — that inversion is the bug that left arrivals, reminders, and plans unspoken.

---

## Look ahead — simulate, don't just recognize

Recognizing the present (matching the moment to the catalog below) is the floor. The real work is **forward-looking**: simulate the user's **near and medium future** and smooth the path before they hit it. Run the loop over three horizons — **next few hours / today–tomorrow / this week** — and for every anchor (a meeting, an arrival or departure, a person they'll see, a deadline, an open block) ask:

1. **What's coming?** — grounded in real data (calendar, the person's narrative, location, commitments); never an imagined future.
2. **What will it need?** — prep, a doc, a decision, a thing to bring, a reply owed, who they'll be with and why.
3. **What's missing or at risk?** — the gap between need and ready.
4. **Do / prep / nudge / hold?** — close it. Default to *doing* the prep silently and having it ready; nudge when the user must act; hold when it's not yet time (or self-schedule a wake for when it is — `create_tickler` with `kind:"instruction"`).

**Insist on preparation** — for any event that clearly needs it, prep is the default, not an offer. **The catalog below is NOT an exhaustive trigger list** — it is a set of **worked exemplars** that calibrate this judgment (what fires, what stays silent, when to do-vs-nudge). A situation that isn't listed still fires if the loop says it matters; when in doubt, simulate forward and ask "what would a sharp chief-of-staff already have ready?"

---

## Recognition loop (run every time)

1. **Pull the fused picture.** Call `get_situation` — this is the anchor of the loop, call it first (it includes location, so you don't also need `where_is_user`). You now have: `current_time`, `time_period`, `day_type`, `current_location` (incl. `place_name`, `freshness`), `next_event` + `time_until_next_event`, `suggested_energy`, `notable_recent_events`, `active_conversations`, **`device_activity`** (`first_interaction`, `last_interaction`, `screen_on_ms`, `unlock_count`, `interactive_now`, `top_apps`), and **`bluetooth_connected`** (list of `{name, class}` where class ∈ car/headset/wearable/…). On a **new day** or just after a context compaction, also `read_user_model()` + a quick `recall` so recognition runs on current context.
2. **Pull what the snapshot doesn't include**, only as needed per matched situation: due/overdue ticklers (google MCP), overdue/contextual actions (`recommend_actions`, `list_actions`), unprocessed inbox (`list_inbox`), open journal entries (`read_journal status:open`), stale narratives (`recall` / `list_narratives`).
3. **Scan the catalog below.** Catalog conditions calibrate WHICH message and HOW urgent — they are not a gate on *whether* to speak. Multiple can fire — handle the most time-critical first, batch the rest into one message. A genuine state-change with no exact catalog match still surfaces (default: surface).
4. **Check the guardrails** (don't re-fire, respect caps, quiet hours, driving). A guardrail is the ONLY thing that turns a surface into a hold — absent one, you act.
5. **Act:** surface info and/or take the action, with the right `notification_level`.
6. **Journal the outcome** (mandatory — see [CLAUDE.md → Session Memory]). Every run ends in a `write_journal`, a `note_observation`, or one skip line. "Checked, nothing fired" is a skip line with the reason, not nothing.

---

## Notification levels

Set `notification_level` on your outbound message. The user's settings cap the effective level (and quiet-hours cap it further), so request the *true* urgency and let the cap do its job.

| Level | Use for | Examples here |
|---|---|---|
| `silent` | Recorded, no buzz. Journal/observation only. | stalled-project note, off-routine observation |
| `notify` | Worth seeing soon, not interrupting. **Eager default.** | context-matched actions, inbox piling, free block opened |
| `alert` | Time-critical, act now. | leave-by-now for a meeting, important contact unanswered |
| `critical` | Must break through silent mode (STREAM_ALARM). | genuine emergencies only — not routine proactivity |

---

## The catalog

*Exemplars that calibrate the forward-looking loop above — not an exhaustive trigger list. Situations not listed here still fire if the simulation says they matter.*

Personal anchors (`[HOME]`, `[OFFICE]`, `[GYM]`, important-contact list) resolve from known places/people in personal-knowledge & awareness. **Fill these in for this user** — see "Anchors" at the bottom; until set, match on `place_name` heuristically.

### Location / commute

**L1 — Arrived at / left a place (ALWAYS ping — this is the floor, not a judgment call)**
- *Fires:* an `Arrived at X` or `Left X` event (a known place became current / was departed). **No other condition required** — the arrival/departure itself fires it (CLAUDE.md → Location Intelligence, line 113).
- *Do:* a light "noticed you got to the office" / "you've left home" **every time** — `push_to_user(level: "notify")`, never journal-and-suppress. THEN enrich when there's something: `recommend_actions(context_tags: [<@place>])`, pending inbox, a calendar tie-in — surface the top 1–3 alongside the ping.
- *Level:* `notify` (with `level` set — a level-less push won't reach them while they're out)
- *Note:* this is the entry that was silently failing — arrivals require NO pending context to ping.

**L2 — Morning departure toward first event**
- *Fires:* movement away from `[HOME]` in the morning AND `next_event` has a `location`.
- *Do:* compare `time_until_next_event` against rough travel time to the event location. If tight or already at-risk → "leave by HH:MM". If comfortable → silent confirm in journal.
- *Level:* `alert` if at-risk, else `silent`

**L3 — Evening arrival home**
- *Fires:* arrival at `[HOME]` in evening/night `time_period` AND there are open day-items (unresolved `read_journal status:open`, uncaptured threads, unprocessed inbox).
- *Do:* offer a short end-of-day sweep: "X open items — want to close them out?"
- *Level:* `notify`

**L4 — Near a place where an errand can happen**
- *Fires:* `current_location` is near a place that matches a context tag on an open action (e.g. `@pharmacy`, `@hardware`).
- *Do:* surface that action now ("you're near X — Y is on your list").
- *Level:* `notify` (eager: yes, this is the high-value case)

**L5 — Off-routine location / unusual dwell**
- *Fires:* dwelling at an unknown place, or a location pattern that breaks the usual day_type rhythm.
- *Do:* `note_observation` on the relevant narrative; only message if it implies an action.
- *Level:* `silent`

### Meetings / calendar

**M1 — Leave-by-now (travel-time risk)**
- *Fires:* `next_event` has a `location` != `current_location` AND estimated travel time ≥ `time_until_next_event`.
- *Do:* "Leave now for <event> — ~N min away, starts in M." Most time-critical situation in the catalog; handle first.
- *Level:* `alert`

**M2 — Meeting approaching, no prep done**
- *Fires:* `time_until_next_event` ≤ 30 min AND a linked prep action/note exists and is incomplete.
- *Do:* surface the prep item(s).
- *Level:* `notify`

**M3 — Event starting, not moving toward it**
- *Fires:* `time_until_next_event` ≤ 10 min, event has a location, and `current_location` shows no movement toward it.
- *Do:* nudge directly.
- *Level:* `alert`

**M4 — Calendar conflict / double-book**
- *Fires:* two events overlap in the next window.
- *Do:* flag the conflict, offer to help resolve.
- *Level:* `notify`

**M5 — Free block opened**
- *Fires:* a gap ≥ 45 min before `next_event` AND `suggested_energy` is medium/high.
- *Do:* `recommend_actions(energy, time_available: <gap minutes>, context_tags)` → propose one deep/medium action.
- *Level:* `notify` (eager)

### Tasks / GTD

**G1 — Due / overdue ticklers**
- *Fires:* ticklers due today or overdue (google MCP).
- *Do:* surface them, grouped.
- *Level:* `notify` (`alert` if hard-deadline today)

**G2 — Context + energy + time match**
- *Fires:* `current_location`/time implies a context (`@computer`, `@office`, `@home`) AND a usable block of time AND `suggested_energy` set.
- *Do:* `recommend_actions(energy, time_available, context_tags)`; offer the best-fit next action.
- *Level:* `notify`

**G3 — Stalled project**
- *Fires:* an active project with no movement in 7+ days (cross-check via narratives/`list_projects`).
- *Do:* one-line "still here / next move TBD" — `write_journal` and, if it's blocking, surface it.
- *Level:* `silent` (journal) → `notify` if it's time-sensitive

**G4 — Inbox piling up**
- *Fires:* unprocessed `list_inbox` count over threshold (e.g. ≥ 5) AND a quiet moment.
- *Do:* offer to process now.
- *Level:* `notify`

### Messages / relationships (lighter weight)

**R1 — Important contact unanswered**
- *Fires:* an inbound from an important contact unanswered > 2h (or escalated conversation needing a decision).
- *Do:* surface it with the decision needed.
- *Level:* `alert`

**R2 — Follow-up owed**
- *Fires:* you committed to get back to someone (commitment in journal/narrative) and the window is closing.
- *Do:* remind + offer to draft the reply.
- *Level:* `notify`

**R3 — Inbound carries a plan / commitment / logistics (extract → ping → schedule)**
- *Fires:* an inbound message (esp. family / key people) names a time, event, date, pickup, or a plan/request that lands on the user — and it isn't already on the calendar.
- *Do:* surface it to the user with the plan, AND act — `create_tickler` / calendar event anchored to the time+place (autonomous capture, no permission needed — CLAUDE.md → "Mine every inbound for plans"). A pickup at 18:30 in a message becomes an 18:30 tickler. Journaling it without scheduling is the miss.
- *Level:* `notify` (`alert` if the time is today and near)

---

### Device / activity (phone signals — read from `get_situation`)

**D1 — Morning wake**
- *Fires:* `device_activity.first_interaction` is the first interaction after the overnight quiet gap (a clear jump from no activity to active), in an early `time_period`.
- *Do:* this is the moment for the morning briefing — surface the day ahead (`next_event`, due ticklers, anything time-sensitive) timed to when they're *actually* up, not a fixed clock time. `read_user_model()` first if it feels stale. **Check for a `sleep_summary` notable event** (written from the phone's Sleep API on wake — e.g. "Slept ~6h55m (00:10–07:05)"): when present, lead with how they slept and let the duration tune the day's energy framing (a short night → lighter, more forgiving tone; a good night → fine to be ambitious). Don't invent sleep data when there's no summary.
- *Level:* `notify`

**D2 — Driving / in transit (Bluetooth + motion)**
- *Fires:* `bluetooth_connected` includes a `car`/hands-free device, OR `current_location.motion` is driving.
- *Do:* assume hands and eyes are busy. Defer non-urgent pushes; surface only genuinely time-critical items (leave-by, M1/M3), and in one short line. Headset/earbuds + walking → commute/workout — lighter touch, not silent.
- *Level:* downgrade routine pushes to journal-only; `alert` only for time-critical.

**D3 — Late-night screen time**
- *Fires:* `time_period` is night AND `device_activity` shows sustained `screen_on_ms` / a recent `last_interaction` well past the user's usual wind-down.
- *Do:* at most a single gentle, opt-in nudge — and only if it fits your relationship with the user. Never nag. Journal the pattern either way.
- *Level:* `silent` (journal) → `notify` only if the user has asked for wind-down nudges.

**D4 — Focus vs. idle (timing gate, not a push)**
- *Fires:* `device_activity.top_apps` shows sustained single-app foreground (deep focus), OR no interaction for a long stretch (idle/away).
- *Do:* this modulates **when** you act on other situations, not something to surface on its own. During deep focus or while idle/away, hold non-urgent nudges; when the user just became active again (and isn't mid-focus), that's the window to deliver what you held.
- *Level:* n/a (gates timing of the other situations)

---

## Guardrails (the only reasons to stay quiet — even when eager)

- **Never re-fire the same trigger.** Each scheduler system message carries an `event_id`; arrivals are in `notable_recent_events`. If you've already surfaced this exact situation/event, don't repeat it. Track via journal.
- **One message, not a barrage.** If several situations fire at once, batch them into a single coherent message ordered by urgency.
- **Respect the user's caps.** Quiet hours and `max_level` will downgrade your push — don't try to escalate around them. `critical` is for emergencies, never routine proactivity.
- **Stale data → don't cry wolf.** If `current_location.freshness` is stale, treat location-based situations as low-confidence (downgrade a level or journal-only).
- **No catalog match is NOT a reason to stay silent.** A skip is legitimate only when the wake carries no state-change and nothing the forward-loop flags — a true non-event (e.g. an en-route pulse mid-drive, a re-fire of something already surfaced, a health-check that found nothing due). Then write one `write_journal type:context` skip line with the reason. But an arrival/departure, a due reminder, a free block, or a message implying a plan is NOT a non-event — it surfaces. When unsure whether something is a non-event, surface it; a stray nudge is cheaper than the silence that left the user feeling unattended.

---

## Anchors (fill in for this user)

These resolve the placeholders above. Pull from known places (awareness) and people (personal-knowledge); record confirmed values here so recognition is exact, not heuristic.

- `[HOME]` — place_name(s):
- `[OFFICE]` / work:
- `[GYM]` / recurring errands:
- Important contacts (R1):
- Typical commute windows / work hours:

---

## Note for maintainers

This catalog is the **single source of truth** for proactive situation recognition. The agent uses it as a recognition checklist (this skill). The same conditions are the spec for the deterministic composite triggers to be built in the gateway (so "arrived home + open items" can fire an immediate event-driven system message instead of waiting for the next heartbeat). Keep the two in sync.
