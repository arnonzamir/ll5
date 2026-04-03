# GTD Review Skill

## Purpose

Structured reviews that keep the GTD system healthy. Two modes: quick daily review and comprehensive weekly review. The agent drives the review conversationally — it's not a rigid checklist.

## Quick Review (`/review`)

Triggered daily (morning briefing) or on-demand. Takes 5-10 minutes.

### Flow

**Phase 1: Inbox Processing**
```
Agent: list_inbox → for each item:
  - If actionable and obvious → create_action (auto-assign context, energy, project)
  - If actionable but unclear → ask: "Is this a task? What's the next action?"
  - If reference material → upsert_fact / upsert_person
  - If trash → process_inbox_item(action: 'delete')
  - If someday → create_action(list_type: 'someday')
Agent tells user: "Processed 8 inbox items. Created 3 actions, filed 2 facts, 1 needs your input."
```

**Phase 2: Today's Actions**
```
Agent: list_actions(due: 'today') + list_actions(due: 'overdue')
  - Surface overdue items once, gently: "3 items from earlier this week"
  - Show today's actions grouped by context
  - If calendar has meetings: cross-reference for prep actions
Agent: "You have 5 actions today. Your 2pm meeting with Saar — any prep needed?"
```

**Phase 3: Stalled Projects**
```
Agent: list_projects(status: 'active') → filter those with 0 next actions
  - For each stalled project: "Project X has no next action. What's next?"
  - If user doesn't know → suggest or defer
```

**Phase 4: Waiting-For Check**
```
Agent: list_actions(list_type: 'waiting')
  - For each: "Waiting on X for Y — has this come through?"
  - If yes → complete it
  - If no and it's been a while → suggest follow-up action
```

## Weekly Review (`/weekly-review`)

Triggered Friday (via scheduler) or on-demand. Takes 20-30 minutes. Includes everything in quick review plus:

### Phase 5: All Active Projects
```
Agent: list_projects(status: 'active')
  For each project:
  - "Kitchen Renovation (3 actions, 1 completed this week). Still active?"
  - If no progress in 3+ weeks: "This hasn't moved. Keep, pause, or drop?"
  - Ensure each has at least one next action
```

### Phase 6: Someday/Maybe
```
Agent: list_actions(list_type: 'someday')
  - "Here are your someday items. Anything you want to activate?"
  - Group by theme if possible
  - Don't guilt — "These are here when you're ready"
```

### Phase 7: Horizons Check
```
Agent: list_horizons(level: 2) → areas of responsibility
  - "Your areas: Health, Family, Work, Home, Finances"
  - "Any area feeling neglected? Any new commitments?"
  - Don't force — just surface for reflection
```

### Phase 8: Calendar Forward Look
```
Agent: list_events(next 14 days)
  - "Next two weeks: 3 meetings, 1 deadline, 2 ticklers"
  - "Any prep needed for the board meeting on Tuesday?"
  - Create prep actions if user says yes
```

### Phase 9: Journal Review
```
Agent: read_journal(status: 'open', limit: 20)
  - Surface open commitments: "You committed to X — still on track?"
  - Surface unresolved feedback: "You mentioned Y didn't work — has that been addressed?"
  - Resolve entries that are done
```

### Phase 10: Mind Sweep
```
Agent: "Anything else on your mind? Worries, ideas, things you've been meaning to capture?"
  - Capture each to inbox or directly to actions
  - This is the GTD "empty your head" step
```

## Agent Behavior Principles

- **Act, don't list.** Process inbox items, don't just show them. Create actions, don't just suggest them.
- **Ask when uncertain.** Commitment level, priority, delegation — these need user input.
- **Never guilt.** "3 overdue items" not "You still haven't done X."
- **Match energy.** Morning review: crisp, action-oriented. Evening: lighter, reflective.
- **Journal the review.** Write a journal entry summarizing what was reviewed and any patterns noticed.
- **Respect time.** Quick review shouldn't take more than 10 minutes. If inbox is huge, batch it: "42 items in inbox. Let's process the top 10 now?"

## Skill File Structure

```
ll5-run/.claude/skills/
  review.md          — quick review (/review)
  weekly-review.md   — weekly review (/weekly-review)
```

Each skill file contains:
1. Description of when to use it
2. The phased workflow
3. MCP tools to use at each phase
4. Behavioral guidelines
5. Journaling rule (must journal the review outcome)

## Scheduler Integration

- **Daily**: `DailyReviewScheduler` sends system message at configured hour → agent runs `/review`
- **Weekly**: `WeeklyReviewReminder` sends system message on configured day/hour → agent runs `/weekly-review`
- Both already exist in the gateway — they just need the agent to have the skill files to respond to them properly.
