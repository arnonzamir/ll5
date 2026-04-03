# GTD Review Skill

## Overview

Unified `/review` skill supporting two modes: **quick review** (daily, 3-5 min) and **weekly review** (comprehensive, 20-40 min). The key design choice: the agent *acts*, not just lists. It processes inbox items, creates actions, surfaces stalled projects — conversationally, not as a rigid checklist.

## Mode Detection

1. `/review weekly` or `/review quick` — explicit override
2. If today is the configured `weeklyReviewDay` (Friday) — default to weekly
3. If weekly review was completed within last 5 days — default to quick even on Friday
4. Fallback: quick

When inferred, confirm briefly: "It's Friday — time for your weekly review. Ready, or just a quick check?"

## Quick Review Phases

### Phase 1: Inbox Processing

**Tools:** `list_inbox`, `process_inbox_item`, `create_action`, `create_project`

- If empty: "Inbox is clear. Moving on."
- For each item: agent **proposes** its best interpretation and acts:
  - "This looks like a @phone action — 'Call dentist to schedule cleaning.' I'll create it."
  - User agrees or corrects. If ambiguous: "Taking this on, or someday?"
  - Two-minute rule: "This one's quick — could you do it now?"
  - Multi-step: "This sounds like a project. What's the first action?"
- Quick review: process up to 5, then offer to continue or move on
- Weekly review: process all, pause every 5

### Phase 2: Due/Overdue Actions

**Tools:** `list_actions(overdue: true)`, `list_actions(due_before: today)`

- If nothing: "Clean slate." (move on)
- Overdue: mention count once, gently. If 5+: "Looks like some dates were aspirational. Want to reset them?"
- If <3 overdue: walk through each — reschedule, do now, drop, or remove date
- Due today: list briefly, flag calendar conflicts

### Phase 3: Stalled Projects

**Tools:** `list_projects(status: "active")`

- Filter to projects with 0 next actions
- For each: "Project X has no next action. What's next?"
- Agent proposes if it can infer. If user doesn't know: suggest or defer
- If project is done but not marked: "Can I close this out?"

### Phase 4: Waiting-For Check

**Tools:** `list_actions(list_type: "waiting")`

- Show who, what, and age in days
- If older than 7 days: propose follow-up action
- If resolved: mark complete
- If recent: list briefly, no pressure

## Weekly Review — Additional Phases

### Phase 5: All Active Projects

Walk through ALL active projects (not just stalled). Group by area if areas exist.

- Healthy projects: brief acknowledgment. "Kitchen renovation: 3 actions. Looks good."
- Stale projects (no progress in 3+ weeks): "Keep, pause, or drop?"
- Ensure each has at least one next action

### Phase 6: Someday/Maybe

**Tools:** `list_actions(list_type: "someday")`

- "Quick scan — N items. Anything you want to activate?"
- User can activate (`update_action(list_type: "todo")`), drop, or leave as-is
- Don't pressure. Most will stay. That's fine.
- If 10+ items: "Want to scan them all, or just the oldest few?"

### Phase 7: Areas of Responsibility

**Tools:** `list_horizons(horizon: 2)`

- For each area: check if projects cover it
- "Your Health area has no active projects. Everything covered, or something falling through the cracks?"
- Prompt by category: "Any new commitments at work? Health appointments? Household things?"
- Capture anything untracked

### Phase 8: Calendar Look-Ahead

**Tools:** `list_events` (next 14 days), `list_ticklers` (next 14 days)

- Synthesize into narrative: "Next two weeks: 3 meetings, 1 deadline, 2 ticklers."
- Flag packed days, events needing prep, conflicts, related ticklers
- Create prep actions if needed

### Phase 9: Journal Review

**Tools:** `read_journal(status: "open")`, `resolve_journal`

- Focus on open commitments and unresolved feedback
- "You committed to X on [date]. Is this handled?"
- If handled: resolve. If needs action: create and resolve.
- Don't read every entry — summarize count, focus on actionable items

### Phase 10: Mind Sweep

**Tools:** `capture_inbox`

- "Anything on your mind we haven't captured?"
- If blank, prompt by category: Work? Home? Health? Money? People?
- Capture everything to inbox
- "Clean mind. That's the goal."

## Adaptive Behavior

### Compression
If system is clean (inbox empty, all projects healthy, nothing overdue): compress dramatically.
- Quick: one sentence summary
- Weekly: compress phases 1-4 to one line each, focus on forward-looking phases 5-10

### Fatigue Detection
If user gives short answers, says "yeah" repeatedly, or "can we wrap up":
- Offer to cut short: "We've covered the big items. Want to do someday and sweep another time?"
- Journal the partial completion
- A partial review is infinitely better than a skipped one

### System Health Gating
Call `get_gtd_health` at start. Use metrics to decide emphasis:
- `inbox_count > 10`: more time on inbox
- `projects_without_actions > 3`: emphasize stalled projects
- `overdue_count > 5`: suggest date cleanup
- `someday_count > 20`: batch the someday scan

## Agent Behavior Principles

- **Act, don't list.** Process items, don't just show them.
- **Ask when uncertain.** Commitment, priority, delegation need user input.
- **Never guilt.** Mention overdue once, gently. Normalize.
- **Match energy.** Morning: crisp. Evening: lighter. If user is tired: compress.
- **Journal the review.** Write a journal entry summarizing what was reviewed and patterns noticed.
- **Respect time.** Quick review <10 min. If inbox is huge, batch: "42 items. Let's process the top 10 now?"

## Skill Files

```
ll5-run/.claude/skills/
  review.md          — unified quick/weekly review (/review)
```

The existing `/daily` skill remains separate — it's a read-only morning snapshot (30 seconds), not an interactive review.

## Scheduler Integration

- `DailyReviewScheduler`: morning briefing → agent runs `/daily` (read-only snapshot)
- `WeeklyReviewReminder`: Friday → agent runs `/review` (enters weekly mode)
- Both already exist. The skill files just need to respond properly to the system messages.
