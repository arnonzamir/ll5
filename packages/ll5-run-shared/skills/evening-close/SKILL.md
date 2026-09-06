---
name: evening-close
description: The 2-minute evening close — one notify-level message wrapping the day: max 3 loose ends, tomorrow's ONE thing, habit outcomes, and an explicit pick-up/drop call on every staged item the gateway embedded in the nudge.
---

# Evening Close

Triggered by the `[Evening Close]` system message (gateway scheduler, ~20:30 local). The nudge is
**self-carrying**: the gateway embeds the day's collection so you don't have to reconstruct it —

- **staged items** — today's silent/staged assistant messages the user never engaged with,
- **open journal entries** created today (proposals, loose ends),
- **habit checks and their outcomes** for today.

Your job is a **2-minute close**: one message, same discipline as the morning brief. This beat exists
because silent staging is a black hole — everything you parked during the day gets its guaranteed
audience here, exactly once.

## Steps

1. `get_situation` first (the proactive-wake anchor), then read the embedded collection from the nudge.
2. **If the collection looks incomplete or stale** (empty on a day you know was busy, missing an item you
   remember staging), recall before writing — `read_journal(status: "open")` + `recall_everything` on the
   gap. Never write the close from a list you suspect is partial; never re-derive what the embed already
   carries.
3. Compose ONE message (structure below) and deliver it with `push_to_user(level: "notify")`.
4. For each embedded staged item, record the call you made: picked up (it's in the message), rebooked
   (`create_wake` to a named moment — say so), or dropped (say so, one clause). Journal the close;
   end the turn with the `[[moment …]]` line per the eval rule (`decision="ping_now"` — this beat always delivers).
5. Call `set_today_card` with your read (voice ≤2 sentences, first-person) and tomorrow's ONE thing —
   the phone's Today card should end the day current, pointed at tomorrow.

## The message

Four parts, tight, in this order:

1. **Loose ends — max 3.** Today's genuinely unfinished threads, most consequential first. More than 3
   exist? Pick 3; the rest are either dropped out loud ("letting the rest ride") or rebooked. Not a log
   of the day.
2. **Tomorrow's ONE thing.** The single move that matters most tomorrow — same discipline as the morning
   brief's one decision. One sentence, concrete, grounded in the live calendar (Rule 15: `list_events`,
   not a cached picture) if it's schedule-shaped.
3. **Habit outcomes — one line.** From the embedded outcomes: "Ritalin 3/3, training skipped." Two skips
   this week on one habit → one named observation + a smaller-doorway offer (coach voice, never guilt).
4. **Pick-up / drop per staged item.** Every embedded staged item gets an explicit verdict — surfaced
   here, rebooked to a named moment, or dropped. **Never re-stage silently**: an item that leaves this
   close without a verdict is the exact failure this beat exists to end.

## Rules

- ONE message, notify level, ~2 minutes of user attention max. Evening tone: warm, brief (match energy).
- No item may exit the close still staged-and-silent. Pick up, rebook (with the wake actually booked —
  `ping_later` means booked), or drop out loud.
- Nothing new gets opened here — the close wraps the day, it doesn't start threads. A genuinely new
  urgent item is its own push, not a fifth section.
- If the embed is empty and recall confirms a clean day: still send the close — "Clean day, nothing
  staged. Tomorrow's one thing: X." The beat fires every evening; an empty close is short, not skipped.
