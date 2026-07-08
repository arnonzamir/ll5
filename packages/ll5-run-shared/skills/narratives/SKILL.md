---
name: narratives
description: Full narrative-maintenance reference — when to upsert/consolidate, status transitions, cross-source validation, backfill. CLAUDE.md keeps the rules; this skill is the deep guidance you load when actively maintaining narratives.
---

# Narratives — Deep Reference

CLAUDE.md has the day-to-day rules. This skill is the reference you pull in when you're doing real narrative work — drafting a person-narrative, consolidating a thread, triaging which observations to write. Read it through when you sit down to maintain narratives; otherwise the short rules in CLAUDE.md are enough.

## Subjects are realities, not containers

**A WhatsApp group is not a narrative — the *relationships expressed in it* are.** The "פיתות בפסח" group isn't a thread in the user's life; the *friend circle that hangs out via that chat* is. The "All inclusives" group isn't a narrative; the *extended family relationships* it carries are.

When you see signal in a group chat, ask: *what human reality is showing up here?* Then make that the subject. The group JID is a **source** of the observation (set `source_id` to the conversation_id), not the **subject** of the narrative.

Practical consequence:
- **Default to `person` and `topic`** for narrative subjects. Most threads in a life are either about one person, the relationship between people, or a recurring concern/project.
- **Use `topic` slugs that name social units, not technical containers**: `pesach-friend-circle` not `pitot-bapesach-group`; `arnon-side-family` not `all-inclusives-group`. The slug should make sense out loud at coffee.
- **Use `kind: 'group'` rarely** — only when the *group as a phenomenon* is itself the unit of analysis (e.g., "the family WhatsApp's banter pattern" as a thing you study). Most observations from a group chat should tag the *people* and *topic* involved, with the group_id as `source_id` only.
- When uncertain, list 2–3 candidate subjects in your head and ask: *which one would still make sense if the group chat moved to Telegram next year?* That's your narrative subject.

## Subject kinds — preference order

- `person` — ref = person_id from personal-knowledge. **Primary kind for inner-circle narratives.** Rotem, the kids, parents, close friends — anyone whose own life-thread runs alongside the user's deserves a person-narrative.
- `topic` — ref = lowercase-kebab slug you coin: `workload-management`, `self-esteem`, `bookshelf`, `pesach-friend-circle`, `arnon-side-family`. Use for relationships-between-people, ongoing projects, recurring concerns. The slug should describe a social or psychological reality, not a tool.
- `place` — ref = place_id. Rare; use only when the place itself is the thread (a vacation home with its own arc, an office with shifting dynamics).
- `group` — ref = conversation JID. **Last resort.** Only when the group's behavior as a unit is the phenomenon you're tracking. Default to people + topic instead.

Multiple subjects per observation are encouraged. A message from Rotem in the family group about Itamar's school day → subjects: `[{person: rotem_id}, {person: itamar_id}, {topic: 'parenting-itamar'}]`. The group_id goes in `source_id`.

**Sensitivity:** Set `sensitive: true` for tender topics — mood, self-esteem, kids, marital, money. The flag does NOT gate you (this system is private), but it should make you more deliberate about *surfacing* the content: don't push sensitive material via FCM unless asked, don't include it in summaries that might glance off a phone in a shared room.

## Cross-source validation — never narrate from one source

**A narrative built from one source is a hallucination waiting to happen.** When you're developing or consolidating a narrative — especially a person-narrative — pull from every relevant source before drafting:

| Source | What it gives you |
|---|---|
| `recall` (observations) | What you've explicitly noted before |
| `read_journal` (awareness) | Your past internal observations + commitments + feedback received |
| `read_user_model` (awareness) | What you know about the user themselves; relationships, mood, patterns |
| `query_im_messages` (awareness) | Actual message history with the person/group — the truth on the wire |
| `list_people` / `get_person` (knowledge) | Who they are, aliases, relationship to user, prior notes |
| `list_facts` (knowledge) | Standalone facts that mention them |
| `query_location_history` (awareness) | Where they were when, co-presence patterns |
| `list_events` (calendar) | Meetings/calls/events involving them |
| `chat history` (gateway) | Past conversations *you* had with the user about them |

**Minimum before drafting a person-narrative summary:** 1 read_user_model, 1 list_people/get_person, 1 query_im_messages on the most-active conversation with or about them, 1 read_journal scan, 1 recall. Five tool calls. Anything less is guesswork.

**Validate before consolidating.** If your draft summary says "Rotem has been stressed this week" but the calendar shows a quiet week and the journal has no entries on Rotem and the messages are short and warm — that draft is wrong. Don't write it. Triangulate.

**Failure modes seen so far:**
- Overgeneralizing one chat's tone into a person's mood ("she sent a curt text" ≠ "she's upset with you")
- Conflating a group's banter pattern with a single relationship inside the group
- Mixing two people who appear in the same thread (Tamar-the-daughter ≠ Tamar-the-sister; check person_id)
- Treating a one-off logistic ("Athens hotel handled by company") as a thread-level decision
- Writing a person-narrative about someone the user has barely mentioned, based mostly on inference

When in doubt, write fewer observations of higher confidence rather than many of low confidence.

## Active curiosity — narratives are how you learn the user's life

Default posture: **strive to learn, not to record.** A passive agent that only writes down what it overhears builds a thin substrate. An active agent asks, hypothesizes, and connects.

Be curious in three directions:

**1. Ask about people.** When a new person surfaces and you don't have a clear picture, hold the question and look for natural openings. *"You mentioned Deland Jessop — who's that, and how does he fit into the Richard thing?"* is a fine thing to ask once. Capture the answer to person + narrative substrate. Don't interrogate; one well-timed question per session is plenty.

**2. Hypothesize.** Write observations with `source: 'inference'`, `confidence: 'low'`, that are *guesses*: "Rotem may be stressed about the Eilat-trip overlap with her own work week." A hypothesis is testable. If next week's signals contradict it, delete and re-note. If they confirm it, bump confidence later. Hypotheses make the substrate predictive, not just retrospective.

**3. Connect.** Look for threads *between* threads. The same person showing up in three unrelated narratives is a signal. A topic-slug that should be split (or merged with another). A place that quietly anchors several relationships. *"Why does Saar appear in workload, in Athens-trip, and in last week's hike planning?"* — that's a real question; the answer might deserve its own narrative-topic. When you spot a connection, note it as an observation tagged with all the relevant subjects and `source: 'inference'`.

## Substrate-first details

**Observations are the source of truth. Narratives are the rollup.** A narrative summary that has no underlying observations is a fiction — it has no provenance, can't be traced, can't be disagreed with on a per-fact basis, and rots the moment you start trusting it over the substrate.

- **Never write a narrative summary without the observations it summarizes existing first.** If you have summary-level knowledge in your head from session memory but no observations in `ll5_knowledge_observations` to back it, write the observations *first*, then summarize. One `upsert_narrative` per subject; many `note_observation` calls leading up to it.
- **When you consolidate, the new summary must be drawn from the observations that `consolidate_narrative` returns**, not from your session memory of what's been happening. If your memory says something the observations don't say, the observation is missing — go write it before you consolidate.
- **`observationCount: 0` on a narrative is a code smell.** Stop and ask: what are the 5–10 things I know about this thread? Write each as a `note_observation`. *Then* upsert the summary.
- For retroactive narratives: write observations from session memory with `source: 'inference'` or `source: 'user_statement'` and `observed_at` set to *when the thing actually happened*, not now. The observation timeline is what makes recall useful weeks later.

Why this matters: `recall` returns observations chronologically + the narrative. A summary without observations is a single opaque blob; a summary backed by 30 observations is a thread you can actually follow.

## Act, don't ask — maintenance is your job

You decide when to consolidate, trim, or close. Do not ask the user. Narratives are *your* working notes about their world; they shouldn't have to manage them. If something would change the user's understanding (e.g., closing a major thread), journal the decision; don't make it a chat turn.

The thresholds below are *guidance for your judgment*, not gates that require permission.

## When to upsert a narrative

Two flavors — both silent acts, no user prompt needed:

**Targeted update** (cheap, frequent): a single field change driven by a single observation.
- Trim a resolved item from `open_threads`
- Add a new entry to `open_threads` when a new question surfaces
- Update `current_mood` when the tone clearly shifts
- Append to `recent_decisions` when the user makes a decision worth recording

Targeted updates do NOT count as consolidation. The summary stays as-is; only the touched field changes. No `last_consolidated_at` change.

**New narrative shell**: name a topic-slug subject when enough observations have accumulated to deserve a frame. Don't create empty shells on speculation. **Observations for that subject must already exist** before you write the title + first summary.

## When to consolidate

When a subject has accumulated enough new observations that the *summary itself* feels stale, not just one open thread. Rough threshold: ~5 new observations since `last_consolidated_at`, or several weeks have passed and the thread has moved.

The tool returns current narrative + new observations + guidance. Draft the new summary drawn *only* from those observations, set `current_mood`, refresh `open_threads`, then `upsert_narrative` with `last_consolidated_at: <now>`. If `stats.count: 0`, you have a substrate-empty narrative — backfill observations first.

A background scheduler may also nudge you to consolidate — when it does, do it.

## Resolving a question ≠ ending the narrative

A narrative is the thread; an open_thread item is one question inside the thread. Closing one question almost never means the whole narrative is done. The Athens trip narrative doesn't end when the hotel is confirmed — that's just one box checked. The trip is still happening.

**Status transitions:**
- `active` → default. Recent observations exist; thread is live.
- `dormant` → no real signal in 60+ days, but the subject still exists in the user's life. Set silently when you notice. Recall still finds it. New observations auto-imply it should go back to `active`; flip it.
- `closed` → the thread itself is genuinely over, not just one question. Tamar's pregnancy ends when the baby is born (and a new "Tamar's baby" narrative may begin). The bookshelf is built and standing in the living room. The Athens trip is closed when everyone's home and there's nothing left to do or remember about *the planning*. `closed_reason` required and should be substantive.

When tempted to close: ask "would a new observation belong here next month?" If yes, it's not closed. Trim the open_threads instead.

Closed narratives are not deleted — they remain searchable and recall-able.

## When NOT to push narratives at the user

Most of the time. Narratives are for *your* understanding, not for daily reporting. Surface them only when:
- A usually-active narrative has gone unusually quiet AND there's a recent signal worth surfacing
- A usually-quiet narrative has spiked
- The user explicitly asks ("how's Tamar?", "what's going on with the bookshelf?")
- A weekly review walks through the top active threads

A narrative going stale is not a failure — most of life isn't actionable.

## Backfill

If you've never run `/backfill-narratives`, the system has only what's accumulated since narratives shipped. Running the skill once gives the substrate real depth.

**Substrate-empty narratives need targeted backfill.** If you find an existing narrative with `observationCount: 0` (the dashboard `/narratives` detail page makes this obvious — empty timeline under a rich summary), don't try to derive observations from your session memory in a single sitting. When the relevant subject comes up in conversation, write the observation in real time tagged with the subject. Over a week or two the substrate fills in organically. Don't fabricate timestamps to make it look retroactive — `observed_at` should be when the thing actually happened, or omit it (defaults to now).
