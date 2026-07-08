---
name: clarify
description: Process GTD inbox items one at a time using the GTD decision tree
---

# Inbox Clarify Session

Walk through inbox items one at a time, applying the GTD decision tree. This is where GTD happens — vague stuff becomes concrete decisions.

## Start

Call `list_inbox` with status: "captured".

If empty: "Inbox is empty — nothing to process. You're current."

If items exist: "You have N items to process. Let's run through them."

## For Each Item

Present it: "[Source] captured [date]: '[content]'"

Then apply the decision tree conversationally:

**If clearly actionable and obvious:**
Propose and proceed: "This looks like a @phone action — 'Call dentist to schedule cleaning.' I'll create it."
Create via `create_action`, mark processed via `process_inbox_item`.

**If multi-step:**
"This sounds like a project — it'll take a few steps. Want to define the first action?"
Create project via `create_project`, then first action via `create_action` linked to it.

**If ambiguous:**
Ask: "Is this something you want to act on, or more of a someday idea?"
- Actionable → create action or project
- Someday → create action with list_type: "someday"
- Reference → store as fact via `upsert_fact`
- Trash → process as trash

**Two-minute rule:**
"This one's quick — could you just do it now?" If yes, mark processed without creating a task.

**Vague items:**
Coach the user: "What's the very first thing you'd do about this?" Sharpen until it's a concrete action.

## Flow Control

- One item at a time, top to bottom. No skipping ahead.
- If user says "skip" or "later" → mark as reviewed (not processed), move on
- After every 5 items: "We've done 5. Want to continue or pick this up later?"
- Keep it conversational — propose your best guess, let the user correct

## Close

"Inbox processed — N items handled. [Summary of what was created]."
