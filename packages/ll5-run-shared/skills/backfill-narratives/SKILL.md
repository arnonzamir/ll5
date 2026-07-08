---
name: backfill-narratives
description: One-time backfill — page through existing journal/messages/chat history and create observations + narratives for the threads you find
---

# Backfill Narratives

A guided pass through historical data to seed the narrative substrate. Run this once, when narratives are first introduced or after a long period of not maintaining them. It is **slow on purpose** — you, not code, decide what is worth noting.

## When to run

- First time after narratives ship
- After any extended period where narratives weren't being kept up
- If `list_narratives({})` returns very little despite the user having an active life on the system

NOT a routine task. Don't re-run unless the user asks.

## Posture

You are not extracting; you are **listening to the past**. Most of what you see won't become an observation. Note what would matter if it came up tomorrow:
- Recurring people, especially family and close friends
- Group dynamics — who's active, what the running threads are
- Recurring topics — work pressures, ongoing projects in the user's life, kids, health
- Decisions, mood snapshots, evolving situations

Skip routine logistics, one-off transactions, anything that won't matter next week.

## Phases

### Phase 1 — Journal sweep

1. Call `read_journal({ since: "<90 days ago ISO>", limit: 200 })` — paginate if needed via `since` cursors.
2. Walk entries chronologically. For each, ask:
   - Is this *about* a person, place, group, or recurring topic?
   - Would the entry inform how I respond if that subject came up next week?
   - If yes → `note_observation` with `source: 'journal'`, `source_id: <entry_id>`, `observed_at: <entry_created_at>`, `confidence: 'medium'` (the journal already filtered for signal). Tag every relevant subject — multiple is good.
3. Pause every 50 entries. Tell the user roughly: "Backfilled ~50 journal entries → N observations across M subjects." Continue or pause per their preference.

### Phase 2 — Inbound messages from agent/immediate conversations

Limit scope to conversations the user actually engages with — `agent` and `immediate` priority only. Ignored/batched chats are noise.

1. `messaging.list_conversations({ priority: "agent" })` and `messaging.list_conversations({ priority: "immediate" })`.
2. For each meaningful conversation (skip 1:1 with strangers / sales / bots), call `awareness.query_im_messages` for the last ~60 days, paginated.
3. Walk the messages. For groups, focus on:
   - Banter pattern, who's active, what the running thread is → topic-slug observations on the group itself (subject `{kind: 'group', ref: <jid>}`)
   - Specific developments about people in the user's KB (births, trips, health, transitions) → person-tagged observations + group-tagged
4. For 1:1 conversations with people in the KB, focus on personal updates that would matter later.
5. Don't note routine logistics ("see you at 3pm"), order confirmations, etc.

### Phase 3 — Recent chat history

1. Pull the user's recent LL5 chat (`list_chat_messages` if available, or via dashboard/awareness tools) for the last ~30 days.
2. Note things the user explicitly told you about people / groups / topics — `source: 'user_statement'`, `confidence: 'high'`.
3. Note recurring topics that came up across conversations even if not stated — `source: 'inference'`, `confidence: 'low'`.

### Phase 4 — Coin topic slugs and consolidate

Now you have observations spread across people, groups, and ad-hoc topic mentions. Step back and ask:

- Are there recurring topic clusters that deserve a slug? (e.g., observations about the user's workload, their kids' school, a recurring health concern, a hobby project.) For each → coin a slug, create a topic-subject narrative via `upsert_narrative({ subject: { kind: 'topic', ref: '<slug>' }, title: '...', summary: '...' })`.
- For each subject with 5+ observations → call `consolidate_narrative({ subject })`, draft a summary + current_mood + open_threads, and `upsert_narrative` with `last_consolidated_at: <now>`.

### Phase 5 — Report

Tell the user briefly what you did:
- How many observations you noted, broken down by source
- How many narratives you created or consolidated
- The 5–10 most meaningful threads that emerged
- Anything you decided not to note (and why) that they might want noted

Then journal the backfill itself with `write_journal({ type: 'commitment', topic: 'narrative-backfill-2026', content: 'Completed initial backfill: N observations, M narratives.', signal: 'completed' })` so future you knows it's been done.

## Safety

- **Don't surface sensitive material in your report.** If you noted observations with `sensitive: true`, count them in the summary but do not list them.
- **Skip if rate-limited.** If WhatsApp message pulls or ES queries start failing, stop and report partial completion. Better partial than blocking the user.
- **Don't push notifications during backfill.** This is a long, quiet operation.

## Stop signal

If the user says "enough" or "wrap up", journal what you completed, summarize, and stop. Partial backfill is fine — the substrate accumulates organically going forward.
