# Delivery contract: message classes, seen model, activity rail, escalation, modality learning

**Date:** 2026-09-07 · **Status:** design (no code) · **Follows:** DECISION-030 (caps, quiet hours, delivery mode), DECISION-031 (section budgets, `[[moment …]]`), DECISION-028 #5/ISS-004 (deferral_ref), DECISION-029 (tests) · **Companion UI docs:** `docs/design/android-companion-ui-spec.md` §3, `android-companion-ui-interaction-model.md` §2

Paths without a prefix are in `/Users/arnon/workspace/ll5`. `agent:` = `/Users/arnon/workspace/ll5-run-claude-code`, `android:` = `/Users/arnon/workspace/ll5-android/app/src/main/java/com/ll5/android`.

## The problem

Two of Arnon's observations from 2026-09-07: (1) the chat shows the last line of an internal process with no awareness of what the user saw; (2) the user is not watching the chat, so anything that needs action or a change of behaviour cannot be a chat turn. This morning a card-pickup reminder that needed action was a plain chat message nobody read.

Why it happens, from the code:

- The only user-facing sink is one `chat_messages` row (`packages/gateway/src/chat.ts:427-450`) plus an optional FCM push whose body is `content.slice(0,200)` (`chat.ts:477`). There is no notion of "this needs an action by T". The tray exists but only for `habit | approval_* | decision` (`packages/gateway/src/tray.ts:41-69`); a reminder has no tray kind.
- Proactive turns are told to "do it, one-line report" (`packages/ll5-run-shared/CLAUDE.md:25`) and "your prose IS the answer, deliver with push_to_user every time" (`CLAUDE.md:179`). Every such report is a `push_to_user` row in the same stream as real messages. The Stop mirror itself already refuses non-user-facing triggers (`agent:.claude/hooks/lib/decide_mirror.py:143`), but a trigger that is not a `<channel …>` envelope falls through as "CLI typing" (`decide_mirror.py:147`), and `reply(channel:"web")` is allowed on any turn (`agent:channel/ll5-channel.mjs:611-641`). Verification of which path produced the "Parked…" and "Card: …" rows: `SELECT metadata->>'captured_by', metadata->>'kind', channel FROM chat_messages WHERE …` — `captured_by='stop-mirror'` means the fallback, otherwise the agent's own push.
- `narrate` rows are `chat_messages` with `metadata.kind='thinking'` and `display_compact=true` (`ll5-channel.mjs:1028-1029`; `migrations/024_chat_notify_metadata_kind.sql:3-5`). Same table, same stream; clients hide the live one and fold the rest (`android:ui/chat/ChatScreen.kt:387, 400-414`).
- The quiet-hours digest trims each held item to its first line, 157 chars (`packages/gateway/src/scheduler/quiet-hours-release.ts:19-21`), so a held ask survives as a fragment.
- Nothing reports what the user saw: no read/seen/delivered columns or routes in the gateway (grep across `src/` and `migrations/`), no notification actions, delete intents or opened/dismissed callbacks in the app (`android:service/LL5FirebaseMessagingService.kt`), no read-position reporting (`android:ui/narratives/TopicsRailScreen.kt:54` states "no read-state" as policy for Topics). The only user acks that reach the gateway today are the chat reaction `acknowledge` (`android:data/remote/ChatApi.kt:72-76`) and tray answers.

## 1. What exists today

| Component | Where | Verdict |
|---|---|---|
| `push_to_user` with `kind`, `level`, `display_compact`; `MESSAGE_CAPS` refusal | `agent:channel/ll5-channel.mjs:643-668, 396-414, 884-889` | CHANGED — add `class`, `subject`, `due_at`, `stakes`, `ack_required`, `escalation`; refuse asks without class/due |
| `reply` (`channel: web|system`) | `ll5-channel.mjs:611-641, 1374-1454` | CHANGED — `web` only when replying to a user-facing message |
| `narrate` (`metadata.kind='thinking'`, `display_compact`) | `ll5-channel.mjs:728-740, 1010-1043` | CHANGED — stamp `trigger_id`; proactive-turn narration goes to the rail, not the thread |
| Envelope meta (`delivery_mode`, `scheduler`, ids) | `ll5-channel.mjs:1664-1734` | CHANGED — add `user_seen_up_to`, `unseen_count`, `open_asks` |
| Stop mirror + `decide_mirror.py` | `agent:.claude/hooks/stop-mirror.sh:99-105`; `decide_mirror.py:135-147, 168-181` | CHANGED — fail closed on raw non-CLI triggers |
| `[[moment …]]` recorder, `SHIP_FIELDS`, `/telemetry/eval-moment` whitelist | `agent:.claude/hooks/lib/eval_record.py:67-77, 547-600`; `packages/gateway/src/server.ts:1010-1042, 114-145` | CHANGED — ship `reason`, `category`, `trace_id`, `produced_message_id` |
| `POST /chat/messages` insert + hold gate; `insertAssistantMessage` | `chat.ts:352-375, 427-489, 179-201` | CHANGED — accept a `delivery` block, create tray item + delivery row |
| `chat_messages` schema (`display_compact`, `reaction`, `metadata.kind`) | `migrations/002, 021, 024` | EXISTING — class lives in `metadata`; state in a new table |
| `held_messages` + `QuietHoursReleaseScheduler.buildDigest` | `migrations/046_held_messages.sql:8-20`; `quiet-hours-release.ts:16-24, 36-51` | CHANGED — no per-item trim; unseen-only; do-by never digested |
| Tray: `tray_items` table, `TrayItem` union, routes, `add_tray_item` | `migrations/037_tray_items.sql:16-30`; `tray.ts:41-69, 416-426, 519-620, 628-698`; `ll5-channel.mjs:689` | CHANGED — new kind `ask` with `due_at`, `message_id`, `ack_required`, ack/done routes |
| `TrayEscalationDto.future_text` (escalation-honesty line) | `android:data/remote/dto/TrayDtos.kt:47-49`; spec §3 item 5 | EXISTING — reuse for the do-by ladder text |
| Needs You screen, badge = item count, 60 s poll | `android:ui/tray/NeedsYouScreen.kt`, `TrayRepository.kt:57-59` | CHANGED — render `ask` cards with Got it / Done / feedback |
| FCM levels, data-only payload, quiet cap | `packages/gateway/src/utils/fcm-sender.ts:7, 107-181, 243-260` | CHANGED — add `data.message_id`, `tray_item_id`, `rung` |
| Android notification channels per level, `CriticalAlertService` (STREAM_ALARM, DND override, 6 s) | `android:service/LL5FirebaseMessagingService.kt:174-194, 253-268`; `CriticalAlertService.kt:120-179, 236-251` | CHANGED — an `alarm` rung below critical; actions; shown/opened/dismissed events |
| `utils/delivery-mode.ts` (`sleep > quiet_hours > driving > meeting > sick > normal`, `hold_pushes`) | `delivery-mode.ts:22-36, 70, 113-171` | EXISTING — gates the ladder |
| `utils/escalation.ts` (conversation attention, 30 min) | `escalation.ts:7-52` | EXISTING, unrelated — not a push ladder |
| `alerting.ts` re-notify cadence (6 h / 24 h; critical 30 min) | `alerting.ts:49-53, 141-150` | EXISTING — precedent for gateway-driven re-push |
| Habit escalation steps as data, `[Habit Check]` per step | `packages/gtd/src/tools/habits.ts:34-36`; `scheduler/habit-scheduler.ts:170-185` | EXISTING — the ladder-as-data precedent; do-by reuses the shape |
| Wakes (`kind: reminder` → `[Reminder]` system row), ticklers (2 h lookahead) | `scheduler/wake-scheduler.ts:135-152`; `packages/google/src/tools/tickler.ts:137-149`; `scheduler/tickler-alert.ts` | EXISTING — they wake the agent; they do not reach the user directly |
| `user_settings` JSONB + `GET/PUT /user-settings` | `migrations/016`; `server.ts:663-712` | EXISTING — `delivery.explore_rate`, per-class max level |
| User model sections + budgets (8 KB / 12 KB) | `packages/awareness/src/tools/user-model-budget.ts:11-15`; `journal.ts:332-347` | EXISTING — `delivery_policy` is a new section within budget |
| `consolidate` skill Step 5 (`active_context`) | `packages/ll5-run-shared/skills/consolidate/SKILL.md:67-86` | CHANGED — Step 6 writes `delivery_policy` |
| Journal (`ll5_agent_journal`, `GET /journal`) | `server.ts:1447-1493` | EXISTING — rail source |
| Dashboard "Active topics" rail (sidebar tab, 5 min poll) | `packages/dashboard/src/components/chat/active-topics-rail.tsx:36-41, 104`; `chat-root.tsx:145-166` | EXISTING — UI precedent for the activity rail |
| Dashboard/Android fold logic (`thinking`, `display_compact`) | `packages/dashboard/src/lib/chat/format.ts:53-98`; `ChatScreen.kt:211-427` | CHANGED — hide `rail=true` rows from the thread |
| Webhook batch items (`POST /webhook/:token`) | `android:data/remote/dto/WebhookDtos.kt:7-141` | EXISTING — not used for seen events (latency); see §3 |
| Call / SMS to the user | none server-side (`sms` hits are ingest parsers); no `CALL_PHONE`/`SEND_SMS`/`USE_FULL_SCREEN_INTENT` in the manifest | NEW |
| Seen / read-position / notification outcome | none anywhere | NEW — `message_delivery`, `user_read_state`, `POST /me/delivery-events` |

## 2. The delivery contract

### Classes

| Class | Meaning | Chat row | Tray item | Push | Escalation |
|---|---|---|---|---|---|
| `fyi` | nothing to do; read when convenient | yes (`metadata.class='fyi'`) | no | only if the agent passes `level` (today's behaviour); policy may downgrade to none | none |
| `needs-you` | the user must know or decide by a time; missing it costs something | yes | `ask`, `due_at`, `ack_required=false` | level chosen by policy (§6), capped by delivery mode and quiet hours; default `notify` | none; at `due_at` the item expires → outcome `missed` if never opened |
| `do-by` | the user must act by a time | yes | `ask`, `due_at`, `ack_required=true` | as above | gateway ladder (§5) until acknowledged |

The agent declares the class; the machinery decides the modality. This is the DECISION-030 pattern: the tool refuses what the persona cannot enforce.

### Fields on `push_to_user` (channel tool)

| Field | Required | Rule |
|---|---|---|
| `class` | always | `fyi | needs-you | do-by`; missing → `NOT SENT — declare class (fyi / needs-you / do-by)`. Omitting `class` is refused on proactive turns; on a user turn `fyi` is assumed (a reply to a question is not an ask). |
| `subject` | needs-you, do-by | ≤ 40 chars, the thing itself ("Card pickup, 17 HaNadiv"). Must appear in the first 80 chars of `text` (normalised, case-folded, Hebrew-safe substring); otherwise `NOT SENT — lead with the subject`. |
| `due_at` | needs-you, do-by | ISO with offset, in the future, ≤ 14 days (matches `DECISION_EXPIRES_MAX_DAYS`, `tray.ts:83`). `do-by` without `due_at` → `NOT SENT — a do-by needs a deadline; if there is none it is needs-you or fyi`. |
| `stakes` | needs-you, do-by | `low | medium | high | critical`. `critical` is DECISION-030's safety/family only; the tool records it, the gateway is the judge for quiet hours. |
| `ack_required` | optional | default `true` for do-by, `false` otherwise; `do-by` with `false` is refused. |
| `escalation` | optional | `standard` (default for do-by), `gentle` (re-push only), `none` (needs-you only), or explicit `[{offset_minutes, rung}]` in the `habits.ts:34-36` shape with `rung` instead of `level`. |
| `level` | optional | kept for compatibility; when present it is a floor, not the choice. The policy picks the modality. |

`kind` and `MESSAGE_CAPS` stay as they are (`ll5-channel.mjs:396`). The check is one more branch in the same refusal path (`:884-889`); the gateway re-validates the `delivery` block on `POST /chat/messages` (`chat.ts:352-375` neighbourhood) so a hand-crafted post cannot bypass it.

### What the gateway does with a classed message

1. Insert the chat row with `metadata.class`, `subject`, `due_at`, `stakes` (no new columns on `chat_messages`).
2. Insert a `message_delivery` row (§3) with the modality chosen (§6) and `delivery_mode`, `hour_local`.
3. For `needs-you`/`do-by`: insert `tray_items` kind `ask` (`question=subject`, `context=first line of text`, `due_at`, `message_id`, `ack_required`, `escalation` JSON, `status='open'`). `escalation.future_text` renders the ladder honestly ("re-push 08:40 · alarm 08:55 · your rule").
4. Push with the chosen level; FCM `data` gains `message_id`, `tray_item_id`, `class`, `rung`, and `collapse` = the tray item id so rungs replace rather than stack (`LL5FirebaseMessagingService.kt:150, 280-283`).
5. Held by quiet hours (`chat.ts:362-369`): `fyi` and `needs-you` go to `held_messages` as today; a `do-by` is never held as a message — its tray item is created immediately, the ladder is scheduled from `max(now, quiet_end)` (§5), and the digest lists it as the first line.

### Digest exemption

The digest is gateway-composed (`scheduler/index.ts:298-301` → `insertAssistantMessage` with `kind: 'quiet_hours_digest'`), so `MESSAGE_CAPS` never applied; the cut is `buildDigest`'s 157-char trim. Change: no per-item trim; each line is `HH:MM · class · subject — first line`; items whose `message_delivery.seen_at` is set (the user opened the app during the hold) are dropped; open asks lead. The digest row is `class='fyi'` itself and carries `metadata.digest_of=[ids]` so the rail can link back.

### Self-containment and the proactive-turn rule

- Subject-first is checked by the tool (above). A needs-you/do-by message must be readable with no prior turn: the persona says so in one line, the tool enforces the subject.
- Proactive turns produce user-visible rows only through `push_to_user`. Enforcement: (a) `reply(channel:"web")` requires `reply_to_id` to resolve to a `user`-role row on a user-facing channel (the channel already looks the original up, `ll5-channel.mjs:1393-1408`); otherwise `NOT SENT — this turn was not started by the user; use push_to_user with a class`. (b) `decide_mirror.py:147` returns `gated (raw trigger, not a conversation)` unless the hook input carries a CLI-typing marker; the fallback that treated unknown text as CLI typing is closed. (c) One-line reports of routine actions on proactive turns are `narrate` (rail), not `push_to_user` — persona change at `CLAUDE.md:25, 179` ("report in one line" → "report in the rail; message the user only with a class").

## 3. The seen model

### App events

`POST /me/delivery-events` (Bearer, batched `{items:[…]}`), separate from `/webhook/:token` because `PushSyncWorker` batches sensor items with latency and the seen signal is only useful fresh:

| event | payload | when the app sends it |
|---|---|---|
| `chat_seen` | `up_to_message_id`, `conversation_id` | last fully visible assistant row changed while the screen is resumed, debounced 2 s; and on pause |
| `notification_shown` | `message_id`, `rung` | `NotificationManager.notify` succeeded (`LL5FirebaseMessagingService.kt:247-268`) |
| `notification_opened` | `message_id` | content intent tapped (new `PendingIntent` extra) |
| `notification_dismissed` | `message_id` | `setDeleteIntent` receiver (new) |
| `tray_opened` | `tray_item_id` | card first laid out on Needs You (`NeedsYouScreen.kt` LazyColumn) |
| `tray_acknowledged` | `tray_item_id` | "Got it" chip, or notification action "Got it" |
| `tray_done` | `tray_item_id` | "Done" chip, or notification action "Done" |
| `feedback` | `tray_item_id`, `value: too_much | not_enough` | card overflow (§6) |

The dashboard sends `chat_seen` only (scroll position on `message-stream.tsx`).

### Storage (migration 049)

- `user_read_state(user_id, conversation_id, seen_up_to_id, seen_up_to_at, device, updated_at)` — one row per conversation per user, monotonic (never moves backwards).
- `message_delivery(message_id PK, user_id, class, subject, due_at, stakes, ack_required, tray_item_id, modality, push_level, delivery_mode, hour_local, pushed_at, shown_at, opened_at, dismissed_at, seen_at, acked_at, done_at, expired_at, outcome, feedback, escalation_step, next_escalation_at, source_trigger_id)`. `seen_at` is derived when `user_read_state.seen_up_to_id` passes the row (same conversation, `created_at <=`), or when `opened_at`/`tray_opened` fires.
- `tray_items`: add `due_at`, `message_id`, `ack_required`, `acknowledged_at`, `done_at`, `escalation JSONB`; widen `status` to `open | acknowledged | answered | done | expired | missed`. `collectTrayItems` (`tray.ts:387`) gains an `ask` source; `GET /me/tray` lists `open` and `acknowledged` (acknowledged renders muted, no badge weight for `needs-you`; `do-by` stays badged until done or due).
- Routes: `POST /me/tray/ack`, `POST /me/tray/done` (`{id}`) next to `POST /me/tray/decision` (`tray.ts:628-698`); both stop the ladder and emit `[Tray] acknowledged/done: <subject>` to the agent via `insertSystemMessage` like `[Decision]` (`tray.ts:681-685`).

### How the agent receives it

- Envelope meta (`ll5-channel.mjs:1675-1682`, flat strings only): `user_seen_up_to` (message id), `user_seen_age` ("14m" / "3h" / "none today"), `unseen_count` (assistant rows after the read position), `open_asks` ("2 needs-you · 1 do-by"). The hint line already appended for delivery mode (`:434-440`) gains one sentence: "The user has not seen the thread since 07:12 — do not refer to the previous turn; restate."
- `push_to_user` returns `{id, tray_item_id?, modality, seen:false}`; a new `get_delivery_state({ids})` returns the `message_delivery` row per id for follow-ups ("did he see the card note?").
- Start pack (`agent:.claude/hooks/session-start.sh:252-254`): the status line gains `unseen: N since HH:MM, open asks: M`.

### Digests and replies

`releaseDue` (`quiet-hours-release.ts:36-51`) joins `message_delivery` and skips rows with `seen_at`. The persona rule: on any turn where `unseen_count > 0`, a proactive message must not assume the previous turn was read (the tool's subject check makes each one self-contained anyway).

## 4. The activity rail

A view, not a store. One entry per handled trigger, keyed by the trigger id the channel writes to `~/.ll5/agent-trace-id` (`ll5-channel.mjs:1742-1744`) and the recorder carries as `trace_id` (`eval_record.py:547-581`).

| Rail field | Source row | Path |
|---|---|---|
| time, trigger | the system `chat_messages` row (`channel='system'`, `metadata.event_id`, `scheduler` kind) | `utils/system-message.ts:110-115`; migration 032 `scheduler` |
| one-line thought | `narrate` rows with `metadata.trigger_id` = trace (new stamp in `ll5-channel.mjs:1028`); fallback `[[moment reason]]` | `chat_messages` kind `thinking` |
| outcome | `[[moment]]` `decision` + `deferral_ref` (`ping_later` → the wake's `fire_at` from `ll5_scheduled_wakes`); `ping_now` → `produced_message_id` | `ll5_eval_moments` after the whitelist gains `reason`, `category`, `trace_id`, `produced_message_id` (`server.ts:1024-1038`; `SHIP_FIELDS` `eval_record.py:596-600`) |
| journal line | journal entry with the same trace (`write_journal` gains `trigger_id` from the trace file, or the rail matches by session + 90 s window) | `ll5_agent_journal`, `GET /journal` |
| link | `message_delivery.source_trigger_id` → the message row and its tray item | migration 049 |

`GET /me/activity?since=&limit=` (gateway) composes these per trace: `{at, trigger:{kind,label}, thought, decision, deferred_until?, message_id?, tray_item_id?, journal_id?}`. It reads `chat_messages` + `ll5_eval_moments` + wakes; no new index.

Rendering: Android — a sheet reached from the Chat overflow and the System screen ("Activity"), collapsed rows, newest first, no badge, no push, never a tab. Dashboard — a third sidebar tab beside "Active topics" and "Chats" (`chat-root.tsx:145-157`), same 5 min poll discipline (`active-topics-rail.tsx:40`). A rail row with `message_id` deep-links to the chat row / tray card.

What leaves the thread: `narrate` rows and compact tool markers produced on proactive turns (`metadata.rail=true`, set by the channel when the current trace is not user-facing; both fold functions skip them: `format.ts:64-98`, `ChatScreen.kt:379-427`); the `[[compact]]` mirror path on proactive turns (already gated). What stays: user-turn narration as the live status line (`ChatScreen.kt:387`) and its folded scrollback, `fyi`/`needs-you`/`do-by` messages, digests, drafts.

## 5. Escalation for `do-by`

A gateway scheduler (`DeliveryEscalationScheduler`, 60 s tick, the `habit-scheduler.ts:196-235` walk pattern) advances `message_delivery` rows with `class='do-by'` and no `acked_at`/`done_at`. Steps are data on the row (`escalation` JSON, `habits.ts:34-36` shape), offsets relative to `due_at`:

| Rung | `standard` schedule | Mechanism | Exists |
|---|---|---|---|
| 0 `push` | at send | FCM at policy level (`notify` default) | yes |
| 1 `re-push` | `max(send + 30 min, due − 60 min)` | same collapse key, level `alert`, body restated with subject and time-left; actions Got it / Done | levels yes; actions new |
| 2 `alarm` | `due − 15 min` | new level-below-critical: `data.rung='alarm'` → `CriticalAlertService` variant that plays STREAM_ALARM (`CriticalAlertService.kt:236-251`) but does not touch DND (`:120-169`); plus the app's own `AlarmManager` exact alarm armed when the `ask` arrived (works offline; needs `SCHEDULE_EXACT_ALARM`) | new |
| 3 `reach` | `due` | the user's own WhatsApp via `send_whatsapp` to the self JID (`messaging` MCP, the only outbound channel that exists) and, if configured, a voice call/SMS through a provider (Twilio) — new secret, new gateway module | new |

Gating, evaluated at each rung with `computeDeliveryMode` (`delivery-mode.ts:113-171`):

- `sleep` / `quiet_hours`: rungs 1-3 fire only when `stakes='critical'` (DECISION-030: safety/family); otherwise the rung is deferred to `release_at` and the digest leads with the ask. A `do-by` due inside quiet hours with non-critical stakes is refused at send time with a hint ("due 05:40 falls in quiet hours; move the deadline or mark critical").
- `driving`: rung 2 becomes a `notify` with `data.tts=true` (the app reads it aloud); rung 3 waits for the mode to clear unless due ≤ 15 min.
- `meeting`: rung 1 delayed to the event end unless due ≤ 30 min.
- `user_settings.notification.max_level` still caps level (`fcm-sender.ts:166-173`).

Acknowledgement stops the ladder: `tray_acknowledged`, `tray_done`, notification actions, reaction `acknowledge` on the message row (`migrations/021`), or the agent calling `ack_delivery({id})` when the user replies about it in chat. `acked_at` is set, `next_escalation_at` cleared, remaining wakes cancelled. Passing `due_at` unacknowledged sets `outcome='missed'`, status `missed`, and posts `[Tray] missed: <subject>` to the agent, which decides whether a follow-up is warranted.

## 6. Modality learning

### Delivery record

`message_delivery` is the record; nothing separate. Context fields at send: `class`, `stakes`, `deadline_distance` (bucketed `<1h | 1-4h | 4-24h | >24h`), `delivery_mode`, `hour_band` (`night | morning | day | evening`), `modality`. Outcome fields filled by events: `seen` (seen_at within 2 h of send), `acknowledged`, `done_by_deadline`, `dismissed`, `ignored` (expired with nothing), `feedback`. Outcome is finalised at `due_at + 2 h` or at `done`.

Modalities: `chat` (no push) · `push_silent` · `push_notify` · `push_alert` (+ tray) · `alarm` · `reach`.

### Policy shape (user model section `delivery_policy`, ≤ 12 KB, `user-model-budget.ts:11-15`)

```json
{
  "version": 3, "updated_at": "2026-09-21", "explore_rate": 0.25,
  "buckets": {
    "do-by|high|<1h|day": { "prefer": "push_alert", "n": 9, "seen": 0.89, "acked": 0.78, "done": 0.67 },
    "needs-you|low|>24h|evening": { "prefer": "chat", "n": 14, "seen": 0.36, "acked": 0.0 }
  },
  "notes": ["alarms during driving were dismissed 3/3 — never alarm while driving",
            "morning needs-you at notify is seen within 20 min on weekdays"]
}
```

Keys are `class|stakes|deadline_distance|hour_band`; ~40 live buckets at ~120 bytes each is ~5 KB. Missing bucket → defaults (`fyi→chat`, `needs-you→push_notify`, `do-by→push_alert`).

### Update (consolidate Step 6)

`GET /me/delivery-stats?days=14` (gateway aggregate over `message_delivery`: per bucket × modality, counts and rates, plus the explicit feedback tallies). The nightly `consolidate` skill (`skills/consolidate/SKILL.md:67-86`) reads it after Step 5, rewrites `delivery_policy` whole (like `active_context`, `SKILL.md:96-97`), and journals the change. Rule: prefer the cheapest modality whose `seen ≥ 0.8` and, for do-by, `done ≥ 0.7` with `n ≥ 5`; never promote above `push_alert` on outcome alone — `alarm`/`reach` are ladder rungs, not defaults. Two `too_much` on a bucket drop it one step; two `not_enough` raise it one step.

### Read at send time

The channel tool does not decide; the gateway does, so the policy is applied even when the agent forgets. `POST /chat/messages` reads `delivery_policy` from `ll5_agent_user_model` (id `${userId}_delivery_policy`, the read path `delivery-mode.ts:160-163` already uses), 5 min cache; `level` from the agent is a floor. Exploration: with probability `explore_rate` on buckets with `n < 20`, pick the adjacent modality (one step up or down) and mark `explored=true` on the record so the stats separate exploration from policy; `explore_rate` decays to 0.05 as buckets fill. The Needs You tray therefore only keeps what the user has been shown to act on: buckets that drift to `chat`/`push_silent` never create tray items unless `do-by`.

### Explicit feedback

Every `ask` card carries an overflow with "Too much" / "Not enough" (one tap, no dialog; spec §3 style), sent as `feedback` events. The tray's escalation-honesty line ("your rule") links to a per-class max in `user_settings.notification` (`needs_you_max_level`, `do_by_max_level`).

### Dashboard "What works for you"

A settings page beside `settings/notification-levels/`: per class, a table of modality → seen / acked / done-by-deadline rates with `n`, the feedback tallies, the current `prefer` per bucket, and `explore_rate`. Read-only except `explore_rate` and the per-class max.

## 7. Minimum change set and phases

Tests follow DECISION-029: pure logic gets unit tests; live shapes get a read-only contract in `packages/e2e/src/mcp-contracts.test.ts`; no mock-assertion suites.

### Phase 1 — the card reminder: class + tray + push + ack (fixes today's case)

| Repo | Files |
|---|---|
| agent | `channel/ll5-channel.mjs` (`push_to_user` schema + `checkDeliveryContract` refusals; `ack_delivery`, `get_delivery_state`); `packages/ll5-run-shared/CLAUDE.md:21-25, 171-181, 208-210` (class rule, subject-first, report-in-rail); `skills/notify/SKILL.md` (class table replaces the level table as the first decision) |
| gateway | `migrations/049_message_delivery.sql`; `chat.ts` (`delivery` block validation, tray + delivery row, FCM data); `tray.ts` (`ask` source, `/me/tray/ack`, `/me/tray/done`, status widening); `scheduler/delivery-escalation.ts` + `scheduler/index.ts` (rungs 0-2 only); `utils/fcm-sender.ts` (`data` passthrough) |
| android | `TrayDtos.kt` (`ask`, `due_at`, `ack_required`), `NeedsYouScreen.kt` (Got it / Done card), `TrayApi.kt`; `LL5FirebaseMessagingService.kt` (actions Got it / Done, `rung='alarm'` handling, collapse by tray id); manifest `SCHEDULE_EXACT_ALARM` + a `DoByAlarmReceiver` |

Tests: `ll5-channel` refusal matrix (missing class / do-by without due / subject not first / do-by in quiet hours) as a table-driven unit on the pure check; gateway `delivery-escalation.test.ts` for rung times vs `due_at` and mode gating (pure, like `habit-scheduler.test.ts`); `tray` route test for `ask` lifecycle; e2e: `GET /me/tray` shape includes `ask`.
Verification: from the CLI, `push_to_user(class:"do-by", subject:"Card pickup", due_at: +25 min, stakes:"medium")` → tray card with the honesty line, push at notify, re-push at alert after 10 min unacked, alarm at T−15; tap Got it → ladder stops, `[Tray] acknowledged` reaches the agent. Repeat inside quiet hours with `stakes:"medium"` → refused with hint. Query `message_delivery` for the rows.

### Phase 2 — mirror / rail split

agent: `decide_mirror.py:147` fail-closed; `reply(channel:"web")` gate; `narrate` stamps `trigger_id` + `rail`; `eval_record.py` `SHIP_FIELDS` + `eval-record.sh`. gateway: `server.ts` whitelist + mapping; `GET /me/activity`; `chat.ts` accepts `metadata.rail`. android: `ChatScreen.kt` hides `rail` rows; Activity sheet. dashboard: `format.ts` skip; `activity-rail.tsx` tab.
Tests: `decide_mirror` table (`tests/test_decide_mirror.py` already exists for the hook — extend); `eval_record` frozen-rule test updated for the new fields; `activity` route composition unit on fixture rows.
Verification: 24 h of proactive turns produce zero `captured_by='stop-mirror'` rows and zero `reply` rows with `channel='web'` not answering a user row; the rail shows one entry per `[Agent Instruction]`/`[Calendar Review]` with a linked message where one was sent.

### Phase 3 — seen model

gateway: `POST /me/delivery-events`, `user_read_state`, `seen_at` derivation, envelope fields in `GET /chat/pending` or a new `GET /me/seen-state` the channel reads per trigger; `quiet-hours-release.ts` unseen filter + no trim. agent: envelope meta + hint (`ll5-channel.mjs:1664-1734`), `session-start.sh` status line, persona "do not assume the previous turn was read". android: `chat_seen` reporter in `ChatScreen.kt` (LazyListState), notification shown/opened/dismissed, tray opened. dashboard: scroll reporter.
Tests: read-state monotonicity + `seen_at` derivation (pure); `buildDigest` unit (unseen-only, no trim); e2e: `/me/delivery-events` accepts the batch.
Verification: leave the app closed overnight → digest carries only unseen; open the app → `unseen_count` on the next envelope is 0; the agent's next proactive message restates rather than refers.

### Phase 4 — learning

gateway: `GET /me/delivery-stats`, policy read + exploration in `chat.ts`. agent: `skills/consolidate/SKILL.md` Step 6; `delivery_policy` in the start pack. android: feedback overflow. dashboard: "What works for you".
Tests: bucket key + aggregate math (pure); policy-pick with exploration seeded RNG (pure); budget: a 60-bucket policy stays under 12 KB (unit on the serialiser).
Verification: after 14 days, `delivery_policy.buckets` has `n ≥ 5` on the common buckets and the tray count per day fell while do-by `done` rate did not.

## 8. Open questions for Arnon — answered 2026-09-07 08:55 (DECISION-034)

1. Reach = self-WhatsApp through the messaging MCP (dedicated self-chat) plus the app's alert levels used sparingly; no paid provider. 2. Silent push is the initial floor for low-stakes needs-you, and the floor is a learned policy field (adaptive). 3. Digest plus open asks re-pushed individually. 4. Android tray first, dashboard tray in Phase 3. 5. Desktop is not "seen". 6. Start more assertive and dial back (exploration biased to stronger modalities, decaying on "too much" and dismissed-without-action).

### Original questions

1. Rung 3 (`reach`): self-WhatsApp only, or also a voice call/SMS provider (Twilio: a new secret, ~$1/month idle)? Self-WhatsApp is free but it is a notification the phone may also silence.
2. Should `needs-you` ever push when the policy's bucket says `chat` — i.e. is the tray badge alone enough for low-stakes needs-you, or is a `silent` push the floor?
3. Digest at quiet-hours end: one message (today) or one `fyi` digest plus the open asks re-pushed individually at their policy level?
4. The dashboard has no tray at all today. Phase 1 Android-only, dashboard tray in Phase 3, or never?
5. `chat_seen` from the dashboard: report it, or treat the desktop as "not really seen" (a tab left open) and rely on the app only?
6. Exploration rate 0.25 for the first weeks means roughly one in four asks arrives at a modality the policy would not have chosen. Acceptable, or start at 0.15?
