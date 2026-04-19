# Unified Conversations, Reactions, Reply-To

## Problem

Today `push_to_user` picks a `(channel, conversation_id)` heuristically — most-recent channel between web/android, then "busiest" conversation. Result: pushes land in a conversation the user isn't looking at. The FCM notification fires but opening the Android app shows no new message in the visible thread. Classic "notification without message" bug.

Secondary gaps:
- No way to start a fresh thread without losing the agent's working context.
- Reply-to is broken/missing on Android; users can't anchor a response to a specific agent message.
- No lightweight acknowledgment. Every reply has to be a typed message.

## Goals

1. One active LL5 conversation per user. Web + Android + CLI all read/write the same thread.
2. "New conversation" resets the chat thread only — agent's MCP-resident memory (journal, user model, user_settings) is untouched.
3. Reply-to and reactions work on every surface. Images render in quoted parents.
4. System/internal messages interleave into the visible thread, styled compact and collapsible.
5. Conversation list + Hebrew-aware full-text search on web. Not on Android.

## Non-Goals

- Touching WhatsApp/Telegram threading — those remain per-`remote_jid` (external conversations, not ours).
- Multi-device conversation divergence. There is one thread; every device is a view of it.
- Sliding-window summarization of long threads for the LLM. Out of scope.

## Data Model

### Migration 020 — conversations table + archival

```sql
CREATE TABLE chat_conversations (
  conversation_id UUID PRIMARY KEY,
  user_id         UUID NOT NULL,
  title           TEXT,                 -- agent- or derived-title
  summary         TEXT,                 -- 3-6 line agent summary, set on archival
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at     TIMESTAMPTZ,          -- actual archival time (NOW()), not last activity
  message_count   INT NOT NULL DEFAULT 0,
  last_message_at TIMESTAMPTZ
);

-- Enforce "one active conversation per user" at the DB level.
-- Without this, a double-click on "New conversation" can race to two actives
-- and active_conv() silently picks one.
CREATE UNIQUE INDEX idx_chat_conversations_one_active
  ON chat_conversations(user_id) WHERE archived_at IS NULL;
```

No `search_tsv` column, no trigger-maintained full-text index — search lives in ES (see "Search" below). Hebrew content is 50% of traffic and PG's `simple` dict is effectively substring matching; we'd end up ripping tsvector out within a release.

### Migration 021 — reactions + display_compact

```sql
ALTER TABLE chat_messages
  ADD COLUMN reaction TEXT CHECK (
    reaction IN ('acknowledge','reject','agree','disagree','confused','thinking')
  ),
  ADD COLUMN display_compact BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT chat_messages_reaction_xor_content
    CHECK ((reaction IS NULL) != (content IS NULL));

CREATE INDEX idx_chat_messages_reply_to ON chat_messages(reply_to_id)
  WHERE reply_to_id IS NOT NULL;
```

Notes:
- **Reaction storage is semantic, not visual.** Stored values are intent (`acknowledge`, `reject`, `agree`, `disagree`, `confused`, `thinking`). The client maps to Lucide icons (`Check`, `X`, `ThumbsUp`, `ThumbsDown`, `CircleHelp`, `Ellipsis`). Swapping icon packs or renaming a meaning later is a label change, not a data migration.
- **`content` is made nullable** in the same migration. Reaction rows have `content IS NULL`, `reaction` set, `reply_to_id` set. All other rows have `content NOT NULL`, `reaction NULL`. The XOR constraint enforces it so `COUNT(content)` and full-text paths behave predictably.
- **`display_compact`** controls UX rendering. Named after its behavior, not its origin, so we can reuse it for non-system compact rows later. `role` still records who authored (`user | agent | system`). The two axes are orthogonal — e.g., `role='agent' display_compact=true` is a tool echo; `role='system' display_compact=false` is an escalation bubble.

### Trigger update

Update the existing `chat_messages` INSERT trigger to:
- Bump `chat_conversations.message_count`, `last_message_at`.
- On `NOTIFY`, include `reaction`, `reply_to_id`, `display_compact`.

## Search (ES, lazy)

- PG remains system of record for chat.
- A tailing indexer process consumes the existing `chat_message_notify` NOTIFY channel and indexes each message into an ES index `ll5_chat_messages` (user_id, conversation_id, content, created_at, role) with the `hebrew` analyzer. At-least-once semantics; re-indexing is idempotent keyed on message id.
- A second index `ll5_chat_conversations` stores conversation title + summary for matched-snippet results.
- If ES is down, `GET /chat/conversations/search` falls back to `ILIKE` on the last N (say 500) conversations per user. Degrades gracefully, doesn't block UI.
- The indexer process is a new gateway scheduler (`chat-search-indexer.ts`) — same failure/restart model as existing schedulers, no new deployment shape.

## Gateway API

### New / changed endpoints

```
GET    /chat/conversations                 # list (active first, archived after), paged
POST   /chat/conversations/new             # archive active, create new, optional summary text
GET    /chat/conversations/:id             # details + first page of messages
GET    /chat/conversations/:id/messages    # paginated
GET    /chat/conversations/search?q=...    # ES-backed, falls back to ILIKE
PATCH  /chat/messages/:id                  # sets reaction (user-authored) — new
POST   /chat/messages                      # existing — now accepts reaction, reply_to_id, display_compact
```

`POST /chat/conversations/new` body:
```json
{ "summary": "optional 3-6 line agent-authored summary" }
```
Behavior:
- Sets `archived_at = NOW()` on the current active conversation, writes `summary` to it.
- Creates a new row (the unique partial index prevents double-active races).
- Emits `NOTIFY conversation_switched` with `{prior_id, new_id, user_id}`.

### Conversation switch race

Between archive and client-side SSE receipt of `conversation_switched`, a mid-flight client may `POST /chat/messages` with the just-archived `conversation_id`. The server must handle this deterministically:

- **30-second grace window**: writes targeting an id archived < 30s ago are accepted and routed to the new active conversation. Response includes `{ rerouted_to: <new_id> }` so the client updates its state.
- After 30s: `409 Conflict` with `{ code: 'conversation_archived', active_conversation_id: <new_id> }`. Client retries.
- Never silently drop.

### Active conversation resolution

```
active_conv(user_id) = SELECT conversation_id FROM chat_conversations
                       WHERE user_id = $1 AND archived_at IS NULL
                       LIMIT 1
```
Uniqueness is guaranteed by the partial unique index, so no `ORDER BY ... LIMIT 1` tiebreak is needed.

All `push_to_user` calls and new inbound messages from web/android/cli route here. The `channel` column still records the surface that produced the message (for analytics and source-routing metadata), but it no longer gates conversation selection. WhatsApp/Telegram keep their per-`remote_jid` conversations as before.

`GET /chat/listen` (SSE) payload additions: `reaction`, `reply_to_id`, `display_compact`, plus a new event type `conversation_switched` so open clients can pivot without reconnect.

## Channel MCP (ll5-run/channel/ll5-channel.mjs)

- `push_to_user` simplifies: drops channel resolution. Always writes to active conversation. Still accepts `level` for FCM.
- New tool `new_conversation(summary?: string)` — calls `POST /chat/conversations/new`. Agent is instructed to generate 3-6 lines covering topics/decisions, not verbatim recap.
- New tool `react(message_id, reaction)` — allows agent to react to user messages (rarely needed but symmetric).
- SSE handler passes `reply_to_id`, `reaction`, `display_compact` through to Claude.
- Agent instructions updated: reactions are not conversation turns — don't reply to them unless they carry reply_to_id targeting a question awaiting user answer.

## Dashboard (web)

- Chat panel: sidebar with active + archived conversations (collapsible, default collapsed on mobile width). Title + last_message_at + message_count.
- Search box above the sidebar → `/chat/conversations/search`. Results show conversation title + matched snippet (ES highlight).
- Clicking an archived conversation opens a read-only view (no composer).
- "New conversation" button near composer → prompts agent via a system event to generate a summary, then calls `/chat/conversations/new`. Confirmation dialog so it's not one-tap-away.
- Compose affordances:
  - Hover a message → quick action bar: Reply, React (6 icons in a popover), Copy.
  - Reply quotes the parent inline in the composer; on send, `reply_to_id` is set.
- Reply rendering: small quoted strip above the bubble — sender, first 2 lines of text, and a 40px thumbnail if the parent has an image URL in content or attachments.
- Compact message rendering (`display_compact=true`):
  - Single-line muted row, Lucide glyph prefix by source (`Clock` scheduler, `ShieldAlert` monitor, `Wrench` tool result).
  - Consecutive compact rows within 60s collapse to `▾ 5 system events` — click to expand.
  - Header toggle: "Show system events" (persisted in user_settings.ui).
- Reactions rendering: horizontal strip of icons beneath the parent bubble, grouped by type with count. Tap to add/remove your reaction.

## Android (ll5-android)

- No conversation list, no search (deliberate — not a context reset, no need to browse).
- Same reply/react affordances as web:
  - Swipe-right on a message → composer opens with quoted parent (text + 64dp thumbnail if image).
  - Long-press → action sheet: Reply, React, Copy.
- React sheet: 6 icons in a row, tinted with `colorOnSurfaceVariant`, 28dp.
- Compact message style: smaller font, `onSurfaceVariant` color, leading icon. Same 60s-grouping collapse as web.
- FCM handling: tapping a notification opens the main conversation (there's only one), scrolled to the message id in the notification payload. Notification-without-visible-message bug goes away by construction.
- `conversation_switched` SSE event: if the open conversation id no longer matches active, pivot automatically.

## Agent Contract

- When active conversation switches: agent receives a system event `{ type: 'conversation_switched', prior_id, prior_summary? }`. Agent writes a journal entry noting the switch. No instruction to "forget" — its MCP state is the memory.
- When a reaction arrives: agent receives it in SSE but does not reply by default. Exception: reaction on a message that asked a yes/no question and the user reacted `agree` or `disagree`.
- When a reply-to arrives: agent treats the quoted parent as the anchor. If the parent is its own earlier message, it threads naturally. If it's a user message, same as today.
- Agent can call `react` on the user's messages in narrow cases (e.g., `acknowledge` to silently ack "got it, on it" instead of a full reply — cheaper than a bubble).

## Backfill

On migration 020 deploy:

1. Collect distinct `(user_id, conversation_id, MIN(created_at), MAX(created_at), COUNT(*))` from `chat_messages`.
2. Insert one `chat_conversations` row per tuple. `last_message_at = MAX(created_at)`, `message_count = COUNT(*)`.
3. For each user, determine the most recent conversation.
   - If its `last_message_at > NOW() - INTERVAL '14 days'`: leave `archived_at NULL` (this is the active one).
   - Else: set `archived_at = NOW()` on all of that user's conversations. No active row. The next inbound message for that user creates a fresh active conversation.
4. Never use `archived_at = last_message_at` — archival time stays truthful, debugging "when did this get archived" stays honest.

Indexer backfill (ES) runs in a separate one-shot after the table is populated.

## Rollout

1. **Migration 020** — create `chat_conversations`, unique partial index, backfill with 14-day dormant gate.
2. **Migration 021** — `reaction`, `display_compact`, nullable `content`, XOR constraint, `reply_to_id` index.
3. **Gateway** — new endpoints, trigger update, NOTIFY payload additions, 30s grace handling on archived writes.
4. **ES indexer scheduler** (`chat-search-indexer.ts`) — tail NOTIFY into `ll5_chat_messages` + `ll5_chat_conversations` with Hebrew analyzer. One-shot backfill.
5. **Channel MCP** — simplify `push_to_user`, add `new_conversation` and `react`. Update `ll5-run/CLAUDE.md`.
6. **Web dashboard** — sidebar, search, reply-to, reactions, compact rendering.
7. **Android** — reply-to gesture, reactions, compact rendering, notification deep-link to message id, `conversation_switched` handling.
8. **Cleanup** — drop legacy channel resolution code from `push_to_user`; remove old `notify_chat_message` payload fields no longer consumed.

## Tradeoffs / Residual Notes

- Archived threads hold summaries but the agent still has full journal/user-model memory. The summary is for the user, not the agent.
- `display_compact` vs `role='system'` — orthogonal on purpose. Some system-role messages (escalation markers) stay as full bubbles; some agent-role messages (tool echoes) render compact.
- ES for chat search adds one tailing indexer process but avoids the Hebrew-morphology dead end of PG `simple` dict. Fallback to `ILIKE` on recent conversations keeps search degraded-but-working during ES outages.
- Reaction enum stores semantic names. Icon mapping is client-side, migration-free.
- One-active invariant is enforced by a partial unique index, not just application logic. Races on double-click become 23505 constraint violations we can handle cleanly.

## Out of Scope / Follow-ups

- Shared conversations between family members. The `user_id` scoping makes this intentional — families have separate threads even on shared devices.
- Exporting a single conversation to PDF/markdown.
- Conversation pinning / favorites.
