---
name: calendar-review
description: Calendar review — layer all calendars to understand what's happening and what needs attention
---

# Calendar Review

Analyze the user's calendars as layered context. The primary calendar is the base layer, then each additional calendar adds information on top. Your job is not to list events — it's to understand what's going on and surface what the user should be thinking about.

## Steps

1. Call calendar MCP `list_calendars` to see which calendars are active, their roles, and access modes
2. Call calendar MCP `list_events` for the review period (default: today + 3 days, or as the user requests)
3. Call calendar MCP `list_ticklers` for the same period
4. Call gtd MCP `list_actions` with due_before set to the end of the review period
5. If awareness MCP is available, call `where_is_user` for commute context
6. **Ground before you surface (Hard Rule 12).** Before flagging any event to the user, run `recall_everything({ query: <event title + attendees> })` on it — especially events you don't recognize or that sit on a shared/other-owned calendar. The sweep tells you **whose** event it is (the user's, or a spouse's/group's — the `סרט יועצים` trap), what history or prior correction attaches to it, and what prep it needs. An event you can't ground as the user's is not the user's to surface as a to-do. This is inline (no subagent) — calendar-review runs often and must stay responsive; the discipline is the same as Rule 12.
7. **Pull the dossier BEFORE writing the brief.** For each upcoming event with named participants or a resolvable topic: `get_person` on each participant, the active narratives (`get_narrative` + connections), open GTD actions/waiting-fors mentioning them (`list_actions`), and recent thread activity (`query_im_messages` — respecting its `visibility` field per Hard Rule 15). **The brief LEADS with what the system already knows**: "Hen 1:1 at 14:00 — open since Apr 9: PIP form for Hen" beats "you have a 1:1 at 14:00." An event surfaced without its dossier is the Hen failure — the wide memory existed and showed up only after the user explained the meeting themselves. (Pre-staged grounding in `active_context.upcoming_grounded` counts — see Rules — pull live only for the gaps.)

## How to Layer

Process calendars in priority order based on what `list_calendars` returns:

**Layer 1 — Primary calendar (the one marked primary by Google)**
The backbone. These are the user's own commitments: meetings, appointments, blocks. Map out the time structure first.

**Layer 2 — Owned calendars (access_mode: readwrite, role: user)**
Personal and shared calendars the user controls. Overlay on the primary to spot conflicts and shared logistics.

**Layer 3 — Read-only calendars (access_mode: read)**
Calendars the user subscribed to or was given access to. Could be team calendars, holiday calendars, or external feeds. Weight depends on type:
- Holiday/reference calendars: mention only when they affect plans
- Shared/team calendars: check for conflicts and coordination needs
- FreeBusyReader calendars: you only see busy/free blocks. Note "something is happening" times. If phone-pushed data enriched these slots, use that.

**Layer 4 — Tickler calendar (role: tickler)**
Reminders you placed for the user. Surface these naturally alongside the relevant time blocks.

**Layer 5 — GTD actions**
Due/overdue actions overlaid on the time map. Where are the gaps to get things done?

## What to Surface

After layering, synthesize. Don't narrate each calendar — tell a story about the user's time:

### Time Structure
- Busy vs open blocks. Where are the gaps?
- Back-to-back meetings (flag if > 2 consecutive)
- Days that are packed vs days with space

### Conflicts & Logistics
- Double-bookings across calendars
- Events that need commute time (check locations, estimate travel)
- Prep needs: meetings that need materials, docs, or thought beforehand
- **Prep-commit rule — book it THIS turn.** Every prep-needing event in the next **48h** gets its prep
  wake/tickler **booked in this same turn** (`create_wake` for the minute the brief should land, or a
  tickler for coarse lead time) — naming the prep is not enough. The governor credits `ping_later` only
  when a booking actually happened; a review that ends with "needs prep" and no staged wake did the
  recognition and skipped the commitment.

### What to Think About
- Tickler items due in this window
- Actions that could fit into open slots
- Upcoming transitions that are tight on time
- Things that haven't been planned but should be

### Coming Up
- Briefly preview what's beyond the review window if relevant
- Flag any holidays or breaks coming

## Format

Keep it conversational and concise. Don't repeat what the user can see in their calendar app. Add value by connecting dots across calendars:

Good: "Today is straightforward — standup at 9:30, then clear until 14:00. Good morning for deep work. Tomorrow gets tight: back-to-back from 10 to 13, dentist at 16:00 — leave by 15:40 from the office. Tickler due: renew car insurance."

Bad: "9:00 — Standup (Primary). 14:00 — Sync (Shared). 16:00 — Dentist (Primary)."

## Modes

- **No arguments / just `/calendar-review`**: review today + 3 days
- **User specifies a range**: "review this week", "what does next week look like"
- **User asks about a specific day**: focus deep on that day with all layers
- **Morning context**: if called in the morning, weight today heavily and briefly preview tomorrow

## Rules

- Don't list events mechanically — identify patterns, conflicts, and opportunities
- Include commute estimates when events have locations
- Mention ticklers naturally within the time context, not as a separate section
- If a day is clear, say so — open time is valuable information
- If calendars overlap (same event in multiple calendars), deduplicate
- Adapt the calendar names and structure from what `list_calendars` returns — don't assume specific calendar names
- **Use the pre-staged grounding first.** Nightly consolidation pre-grounds the next ~14 days into `active_context.upcoming_grounded` (who/what/whose/prep per upcoming item). If the event you're about to surface is already there, use that grounding and skip the re-sweep — that's the whole point of pre-staging: the day runs warm. Only `recall_everything` live for events not already grounded (new since the last consolidation).
