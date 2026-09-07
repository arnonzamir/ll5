---
name: notify
description: Delivery-class reference (fyi / needs-you / do-by, subject, due time, stakes, the escalation ladder) and the conversation-escalation procedure. CLAUDE.md keeps the short rules; this skill is the reference you pull in when deciding how a message reaches the user or handling an escalation.
---

# Notifications & Escalations — Deep Reference

CLAUDE.md has the one-line rules. This skill is the table you consult when you're actively deciding a message's class (and, rarely, a level) or processing an `[Escalation]`/`[Escalation Expiring]` system message.

## First decision: the class (DECISION-034)

Every `push_to_user` declares what the message is FOR THE USER. You pick the class; the gateway picks the modality (chat row, tray item, phone level, escalation) and learns per user what works. The tool refuses a message that does not fit its class.

| Class | Meaning | What you must pass | What the machinery does |
|-------|---------|--------------------|-------------------------|
| **`fyi`** | Nothing to do; read when convenient. | `text` (optionally `level` as a floor if it should buzz) | Chat row. Held for the morning digest in quiet hours. No tray item. |
| **`needs-you`** | He must KNOW or DECIDE by a time; missing it costs something. | `subject` (≤ 40 chars, opens the text), `due_at` (ISO with offset, ≤ 14 days), `stakes` | Tray item with the due time, pushed at the policy's level; expires at `due_at` (outcome `missed`). |
| **`do-by`** | He must ACT by a time. | `subject`, `due_at`, `stakes` (`ack_required` is true by definition) | Tray card with Got it / Done; the ladder runs until acknowledged: push at send, re-push at alert, alarm at T-15 min, then reach (a WhatsApp to his own number). |

**Choosing the class.** Is there something he must do with his hands or feet by a time (pick up, call, leave, sign, bring)? → `do-by`. Must he only know or answer by a time (a plan to confirm, a change to be aware of before a meeting)? → `needs-you`. Neither? → `fyi` — and ask whether it is worth a message at all, or belongs in the rail (`narrate`) as a report of what you did.

**Subject first.** The tray card and the notification show the subject alone; the text must open with it so the message reads with no prior turn. "Card pickup, 17 HaNadiv — by 17:00, the branch closes then." Not "As mentioned this morning, …".

**Stakes** = what missing it costs: `low` inconvenience · `medium` money or a plan slips · `high` a commitment to someone or a real loss · `critical` safety or family only (the one thing that rings in quiet hours; DECISION-030). Stakes feed the policy's modality choice and the learning; they are not a phone level.

**The ladder is the machinery's job.** Never schedule your own repeat push or a chain of wakes for an ask. `escalation` defaults to `standard` on a do-by; `gentle` = re-push only; an explicit list `[{offset_minutes, rung}]` for an unusual shape. Acknowledgement (a tap, a reaction, his reply) stops it; you receive `[Tray] acknowledged / done / missed: <subject>` — on `missed`, decide whether a follow-up is warranted.

**Quiet hours.** `fyi` and `needs-you` are held and delivered in the morning digest (a HELD result means done — never resend). A `do-by` files its tray item immediately and the ladder starts at quiet-hours end; the tool result says so. If it truly must ring before morning, `stakes: "critical"` — and that had better be safety or family.

**Journal every ask** (class, stakes, why). That is what lets him say "that did not need a tray card" and what the nightly pass learns from.

## `level` — a floor, not the choice

`level` (`silent` / `notify` / `alert` / `critical`) survives for compatibility. On a `fyi` it is the way to say "this should buzz" (`notify`) rather than sit in chat; on `needs-you` / `do-by` the policy picks the level from stakes and context, and a `level` only raises it. The user's settings cap the effective level and quiet hours cap it further — choose for content, not time of day. Escalating an unacted item yourself by re-pushing at a higher level is the pre-DECISION-034 pattern; use `do-by` instead.

## Conversation Escalation

When you receive an `[Escalation]` system message, it means the user sent a message in a conversation that's normally ignored or batched. The system has temporarily elevated it to immediate for 30 minutes.

Your responsibilities:
1. Read the recent messages provided in the escalation notice to understand context
2. Stay attentive to messages from that conversation during the 30-minute window
3. You may NOT reply to the conversation — escalation is awareness only, not permission to respond
4. You CAN `push_to_user` with an appropriate notification level if something in the conversation needs the user's attention
5. When you receive `[Escalation Expiring]`, you MUST:
   - Journal the escalation: what was discussed, why the user engaged, what you observed
   - Decide: recommend changing the routing rule priority, or let it revert
   - If the conversation has become regularly relevant, suggest upgrading its priority
   - If it was a one-off, let it revert — note this in the journal

On session start, check `user_settings` for `active_escalations` — if any exist, you're mid-escalation and should be attentive to those conversations.
