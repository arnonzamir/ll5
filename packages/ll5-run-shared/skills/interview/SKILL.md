---
name: interview
description: Ask the user ONE well-chosen question at a time to clarify a topic, validate a deduction you would otherwise act on, or surface a task — from a queue you keep in data gaps; on demand ("interview me", "/interview") or opportunistically when the user is around
---

# Interview

You know a lot about the user's world and you infer even more. Some of what you infer is wrong, some
topics have an open thread only he can close, and some situations hide a task nobody wrote down. This
skill turns those into **short questions, one at a time, each carrying your best guess as the
default** — so a "yes" costs him one word, silence resolves nothing wrongly, and every answer lands as
durable knowledge the same minute.

The queue is the personal-knowledge **data gaps** store (`list_data_gaps` / `upsert_data_gap`): one
open gap = one question worth asking. Harvesting fills it (mostly at night, in `consolidate`); this
skill spends it.

## When it runs

- **On demand:** the user says "interview me", "ask me about X", "/interview", "what do you want to
  know" → run a *session*: up to 5 questions, one per message, stop when he stops answering.
- **Opportunistic (the default):** on a user-facing turn where he just wrote to you and nothing
  time-sensitive is pending, you may spend **one** question *after* your substantive reply — in the
  same message, so the message still has exactly one question. Also on a heartbeat / agent nudge when
  he was active in the last 15 minutes.
- **Never:** `delivery_mode` other than `normal`; quiet hours; while one asked question is still
  unanswered; after the daily budget (3) is spent; in the evening close or morning brief (those beats
  have their own shape).

## Budget and state (in the gap itself)

- A gap's `context` carries its history: append `asked <ISO>` when you ask, `answered <ISO>` on an
  answer. Count today's `asked` marks across open+answered gaps before asking; 3 is the day's cap.
- An asked gap with no answer stays open; do not re-ask for 3 days, then ask once more; after a second
  silence, `status: dismissed` with `answer: "no answer twice"` — he has told you by not telling you.

## Picking the question (priority order)

1. A **deduction you are about to act on** with medium or higher stakes (moving a plan, telling
   someone something on his behalf, filing a commitment) that rests on `confidence: low` or
   `source: inference` — validate first. This is the one case that may interrupt: ask instead of act.
2. A narrative **open thread that only he can close** (a decision pending, an ambiguity: "is the
   Eilat trip on Sukkot or the week after?").
3. A **task hiding in the record** — something he said he would do that has no action, a recurring
   "I should" — ask whether it is real and capture it in the same turn if yes.
4. A **stale user-model section** (>30 days) whose claim may have drifted ("still 3 Ritalin doses?").
5. Anything else in the queue by `priority`.

Ground before you ask: `recall` the subject; never ask what the record already answers.

## How to ask

- One question. ≤ 200 chars (`push_to_user kind: notice`) or inside a `reply` (≤ 400 with the rest).
- **Lead with your guess as the default:** "I'm assuming the dive trip with Meir is October — right?"
  not "When is the dive trip?". If you have no guess, offer the two most likely options.
- Say why in half a clause only when it is not obvious ("so I stop pencilling it for September").
- Never guilt, never a quiz, never two topics. If he is mid-something, the question waits.
- End the turn with the `[[moment …]]` line per the eval rule; journal one line (`type: context`, topic `interview`).

## On an answer

Write it down in the same turn, then move on — no thanks-padding, at most a one-line acknowledgement:

1. `note_observation({ subjects, text, source: "user_statement", confidence: "high" })` tagged to the
   narrative's subject (reuse its `ref`).
2. `upsert_data_gap({ id, status: "answered", answer })`.
3. If it closes an open thread → `consolidate_narrative` / `upsert_narrative` so the thread leaves
   `open_threads`. If it is durable about him → `write_user_model` on the right section.
4. If your deduction was **wrong**: correct it (`note_observation` with the correction) and, when it
   was an operating mistake, `upsert_lesson` — a wrong deduction is exactly the lesson worth keeping.
5. If a **task** surfaced: capture it now (`capture_inbox` or `create_action` when it is concrete) and
   say so in one clause ("Captured: book the dive boat."). Act-by-default: reversible → do it and say
   it; irreversible → the next question is the confirmation, with a default and a deadline.

## Harvesting (where questions come from)

You do not need this skill running to file a question. Whenever you notice one of the shapes below,
`upsert_data_gap({ question, priority, context })` with the subject ref in `context`:

- in `consolidate` (Step 1.4, nightly): an inference you promoted with low confidence; an open thread
  that needs him; a "will do" with no action;
- in `coach-scan` (weekly): a goal/horizon whose status you cannot read from the record;
- any turn: the moment you catch yourself guessing something that matters.

Priority: 8–10 for deductions you would act on; 5–7 for open threads; 3–4 for curiosity that would
sharpen a narrative. Duplicates: `list_data_gaps` first; update the existing gap's priority instead of
adding a twin.
