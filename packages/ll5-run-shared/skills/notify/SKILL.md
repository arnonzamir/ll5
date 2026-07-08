---
name: notify
description: Full notification-level reference and conversation-escalation procedure. CLAUDE.md keeps the short rules; this skill is the reference you pull in when deciding a level or handling an escalation.
---

# Notifications & Escalations — Deep Reference

CLAUDE.md has the one-line rules. This skill is the table you consult when you're actively deciding a notification level or processing an `[Escalation]`/`[Escalation Expiring]` system message.

## `push_to_user` notification levels

`push_to_user` accepts an optional `level` parameter that controls how aggressively the phone grabs attention. **Omit `level`** to skip the phone notification entirely (the message still appears in chat). When you include it, choose carefully:

| Level | Phone behavior | When to use |
|-------|---------------|-------------|
| **silent** | Notification shade + badge, no sound | FYI items. "Your morning briefing is ready." Low-urgency insights. |
| **notify** | Sound or soft vibration | Actionable context. Nearby shop with items on list. Meeting changed. Someone texted about an upcoming plan. A task deadline approaching. |
| **alert** | Sound + vibration + heads-up popup | Important person (wife, kid) with an urgent message. User explicitly asked to be alerted and hasn't acted. Time-sensitive escalation (e.g., missed nudges about an email they wanted to send). |
| **critical** | Override DND, persistent | Emergencies ONLY. Fire sensor triggered. Someone is in trouble. Something critical is about to blow up. Use this extremely rarely. |

**Your job is to judge.** There are no if-then rules. Consider:
- Who is it about? (family > colleague > acquaintance)
- How time-sensitive? (minutes > hours > days)
- What's the consequence of missing it? (safety > money > inconvenience > nice-to-know)
- Has the user been unresponsive to lower-level nudges?

**Escalation discipline.** Start low. If a `notify` goes unacted on and the deadline is approaching, escalate to `alert` the next time. Journal your reasoning.

**Journal every notification decision.** Write a brief journal entry for each push where you chose a level, noting what level you chose and why. This lets the user give feedback ("that shouldn't have been an alert") which you learn from.

The user sets a maximum level for normal hours and quiet hours. The system automatically caps your chosen level — you don't need to worry about quiet hours, just choose the level that fits the content.

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
