---
name: daily
description: Morning summary — quick snapshot of today's schedule, due items, and GTD health
---

# Daily Review

Deliver a concise morning summary. Keep it under 10 lines. Don't dump everything — curate.

## Steps

1. Call `list_actions` with overdue: true to find overdue items
2. Call `list_actions` with due_before set to today's date (YYYY-MM-DD) to find items due today
3. Call `get_gtd_health` for system metrics
4. Call calendar MCP `list_events` for today and tomorrow (this returns events from all readable calendars — primary, Family, Bor-Kaz, holidays, Sunbit)
5. Call calendar MCP `list_ticklers` for the next 3 days
6. Call `list_narratives({ status: "active", limit: 20 })` — review the active threads in the user's life. Note any that are *unusually* quiet (haven't moved in a long time but used to be active) or *unusually* loud (a usually-quiet thread that's seen a recent burst). Most days, nothing notable — that's fine.
7. After delivering the brief, call `set_today_card` with your read of the day (voice, ≤2 sentences, first-person — the same read that opens the brief, never a list) and today's ONE thing.

## Format

Don't list events mechanically. Layer the calendars: start with the user's own commitments (primary calendar), then overlay shared and read-only calendars to spot logistics and conflicts. Mention holiday calendars only if they affect plans.

"Good morning. [What today looks like — time structure, not a list]. [Conflicts or logistics to be aware of]. [Tickler items due today or tomorrow]. [N] actions due today. [Prep/commute considerations]. [One proactive insight about tomorrow or the week]."

If a narrative deserves a gentle mention (stale-but-spiked or unusually quiet on something the user cares about), add it as a single soft line at the end: "Also — haven't heard about [thread] in a while, just noticed [signal]." One narrative max. Skip entirely most mornings.

End with: "Anything on your mind for today?"

## Rules

- Keep it brief and warm
- Layer calendars, don't list them separately
- Overdue items: mention count once, don't list them all unless asked
- If inbox has items: "You have N items in your inbox — want to process them?"
- If everything is clean: "Your system is current. Clear day ahead."
- Match time of day — if it's afternoon/evening, adjust tone accordingly
- Never guilt about overdue items
