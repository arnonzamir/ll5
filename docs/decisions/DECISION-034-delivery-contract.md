# DECISION-034 — Delivery contract: a message to the user is not sent until it has a path that reaches them

**Date:** 2026-09-07 · **Status:** accepted (Arnon, 08:55 IDT) · **Design:** `docs/design/delivery-contract.md` · **Follows:** DECISION-030, DECISION-031

## Context

The user does not watch the chat. Reminders and asks delivered as chat rows did not exist for him (the card-pickup reminder of 2026-09-07). Proactive turns leaked their last thought into the thread with no context; internal narration sat next to messages meant for him; the overnight digest was trimmed mid-sentence. Arnon: "This balance is the make or break of the app."

## Decision

1. **Three classes, declared by the agent, enforced by the channel tool and re-validated by the gateway:** `fyi` (chat only), `needs-you` (tray item with a due time, push at the policy's level), `do-by` (tray item, acknowledgement required, escalation ladder until acknowledged). A proactive turn reaches the user only through a classed `push_to_user`; `reply` on a proactive turn is refused; the mirror never posts a proactive tail.
2. **Subject first.** `needs-you` and `do-by` carry a `subject` that must open the text; the message is readable with no prior turn.
3. **Escalation ladder for `do-by`:** re-push, then alarm-grade app notification (the app's alert levels, used sparingly), then "reach" = a WhatsApp message to Arnon's own number through the messaging MCP, a dedicated self-chat that the phone treats as a real conversation. No paid call/SMS provider for now. Every rung is gated by delivery mode and the quiet-hours critical rule; acknowledgement stops the ladder.
4. **Activity rail:** the agent's self-initiated thinking (journal entry + `[[moment …]]` record + narrate lines per trigger) rendered as its own stream in the app and dashboard, collapsed, never pushed or badged. Narrate rows leave the chat thread.
5. **Seen model:** the Android app reports chat read position, notification opened/dismissed, tray opened/acknowledged/done; the envelope carries "seen up to" and the unseen count; digests carry unseen items only, untrimmed, open asks first, and open asks are also re-pushed individually at quiet-hours end. Desktop tabs do not count as seen.
6. **Per-user modality learning, as data:** every classed delivery records modality, context and outcome; the nightly pass writes a small `delivery_policy` section to the user model; the floor for low-stakes `needs-you` (silent push vs badge only) is itself a learned policy field, not a constant. Start more assertive and dial back: exploration begins biased toward stronger modalities and decays on "too much" feedback and on dismissed-without-action outcomes.
7. **Order:** Phase 1 the card-reminder case (class, tray, push, acknowledgement, ladder) plus the two layout defects; Phase 2 mirror/rail split; Phase 3 seen model; Phase 4 learning. Android gets the tray first; the dashboard tray in Phase 3.

## Alternatives considered

- Prompt-only discipline ("always push for reminders"): tried by implication since August; the persona said the right words and the reminder still went to chat.
- Shorter, louder everything: the tray goes numb. Learning per user is the answer to the mundane-vs-important balance.
- Paid call/SMS provider for reach: deferred; self-WhatsApp gives the same interruption at no cost, and can be revisited if it proves silenceable.

## Consequences

- The tool refuses more: an unclassed proactive message, a do-by without a deadline, a subject that does not lead. Refusals are the mechanism, as in DECISION-030.
- New gateway state (`message_delivery`, tray `ask` items, `user_read_state`) and one scheduler (`delivery-escalation`).
- Verification per phase in the design's Section 7; the make-or-break metric is "asks acted on by their deadline" against "tray items per day".
