# DECISION-031 — Context floor and trigger fan-out: pay for context once, not seventeen times

**Date:** 2026-09-06 · **Status:** accepted (Arnon, 10:25 IDT: "everything else do as recommended") · **Follows:** DECISION-028 (#5 delivered here), DECISION-030 · **Issue:** ISS-033

## Context

The Opus 5 roll (2026-09-05) made spend visible for the first time (`ll5_turn_costs`): $85 on 09-04, $239 on 09-05, $137 by 10:00 on 09-06 with $72 in a single hour. Regression on 245 turns: cache-read $0.50/M, cache-write $10/M, output $25/M; cache reads are 57% of spend. Two structural facts explain it:

1. **The floor.** A fresh session sits at ~120K tokens after its first trigger: system prompt + tool schemas 26K, persona `CLAUDE.md` 97 KB (~25K), start pack ~22K of which `active_context` alone is 46 KB, first-turn reads ~45K. Every assistant message re-reads all of it.
2. **The fan-out.** One trigger costs ~17 assistant messages (journal, observation, `record_moment`, narrate, ToolSearch, the substantive calls). One WhatsApp group in an escalation window delivered 83 triggers in an hour, one per message.

Multiply: 17 messages × 300–550K context × $0.5/M = $2.5–4.7 per trigger; 24 triggers in the 09:00 hour.

The watcher's cap policy (ISS-033, agent `6ec517a`) bounds the context per session. This decision lowers the floor and the fan-out.

## Decision

- **A. Section budgets in `write_user_model`** (`packages/awareness/src/tools/user-model-budget.ts`): `active_context` ≤ 8 KB, any other section ≤ 12 KB (UTF-8 bytes of the JSON); over budget is refused with `NOT SAVED — …` and a hint of what to cut. The session-start pack truncates an over-budget section on read. Consolidate skill states the cap.
- **B. Persona trimmed toward 55–62 KB** without changing rules: event-specific procedure (media handling, vault logins, location mechanics) moves into on-demand skills with one-line pointers; repeated rules are stated once; examples cut. A moved/dropped ledger is in `docs/reviews/2026-09-06/persona-trim-ledger.md`.
- **C. `record_moment` retired as a tool** (DECISION-028 #5). The proactive moment is one line of plain text in the assistant's final message: `[[moment category="…" sentiment="…" decision="ping_now|ping_later|suppress" reason="…" deferral_ref="…"]]`. The Stop-hook recorder parses it; the mirror hook strips it before anything reaches the user; a `ping_later` without `deferral_ref` is recorded as hollow (ISS-004). One tool round-trip less per trigger, one schema less to load.
- **D. WhatsApp group bursts coalesce** (`packages/gateway/src/utils/group-coalescer.ts`): at immediate/agent priority a group conversation's messages are buffered per conversation and delivered as one system message per 90 s window (or 12 messages, or shutdown). Direct chats are unchanged. Env `WHATSAPP_GROUP_COALESCE_MS`.

## Alternatives considered

- **Raise the cap and accept long sessions.** Cost is linear in context per message; the floor and fan-out are what make every session expensive from minute three.
- **Cheaper model for triggers.** Arnon chose Opus 5 for the main session on 09-05; workers already run Sonnet 5. Revisit with the 09-12 readout.
- **Persona pointer-only (load everything on demand).** Rules that decide behaviour must be present on every turn; only procedure can move.
- **Debounce all immediate messages, including direct chats.** Rejected: a 90 s delay on a family DM is felt; group chatter is not.

## Consequences

- Measured at the 09-07 checkpoint and the 09-12 readout: floor after the first trigger (`cache_read` on the first substantive message), assistant messages per trigger, system messages per hour during a group burst, $/day.
- The eval dataset's `decision_claimed` now comes from text; a turn whose final message omits the line records `decision_claimed: null` — the frozen-rule test guards the line's presence in the persona.
- Persona edits only land with an agent image roll; the trim is reviewed by ledger, and the 09-07 checkpoint watches for behaviour drift (missed media handling, vault logins, location rules).
