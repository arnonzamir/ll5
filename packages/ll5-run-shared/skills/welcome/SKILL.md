---
name: welcome
description: LL5 session welcome — display status and process pending items
---

# Welcome

You are starting an LL5 personal assistant session. Do the following immediately:

## 1. Display Welcome Banner

Print this ASCII art exactly:

```
  ╦   ╦  ╔═╗
  ║   ║  ╠═╗
  ╩═╝ ╩═╝╚═╝  personal assistant
```

## 2. Status Summary

Below the banner, print a brief status line using the context provided in the user's message. Include:
- Current time and day
- GTD summary (actions, projects, inbox, overdue — whatever is non-zero)
- Pending web messages count (if any)

Keep it to 1-2 lines. Example: "Saturday 18:30 — 3 actions across 2 projects, 1 inbox item. 1 web message waiting."

## 3. Process Pending Web Messages

If there are pending web messages (count > 0), call `check_messages` immediately and process each one:
- Read the message content
- Act on it (create actions, capture to inbox, answer questions, etc.) following the GTD rules in CLAUDE.md
- Respond to each message via `send_message` with the appropriate channel and conversation_id
- Do NOT ask for permission to process — just do it and report what you did

## 4. Reconcile scheduled commitments

NOTE: `CronCreate` is DEPRECATED (Hard Rule 6 — all scheduling is now DB-backed ticklers, which are self-durable and need no reconciliation). This step is a LEGACY safety net only for any pre-existing `cron:` journal entries. Call `CronList` and compare against your journal: `read_journal({ status: "open", topic: "cron:" })` (matches any topic starting with `cron:`).

For every open journal entry with topic `cron:<name>`:
- If a routine with that name exists in CronList → fine, stay quiet.
- If NOT → the cron is missing. This means either Anthropic's backend lost it, OR you ran /loop in a previous session (which doesn't persist) and forgot to migrate it. Surface ONE line to the user: "Lost cron: `<name>` — <one-line purpose from journal>. Recreate?" and wait for their go-ahead.

If `read_journal` returns nothing under `cron:`, skip this step — there are no committed crons to verify.

## 5. Proactive Observations

After processing messages and the cron reconciliation, if there's anything noteworthy, mention ONE thing briefly:
- Overdue actions
- Projects with no next action
- Stale waiting-for items
- Inbox items to process

If nothing noteworthy: "You're clear."

## 6. Ready

End with a blank line. Don't say "how can I help" or similar. Just be ready.
