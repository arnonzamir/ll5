# Skills

Claude Code slash commands that orchestrate multi-turn GTD workflows using MCP tools.

## How Skills Work

Skills are prompt files that Claude Code loads when the user types a slash command (e.g., `/review`). The skill prompt instructs Claude on:

- The workflow structure (phases, decision trees, loops)
- Which MCP tools to call and in what order
- How to guide the conversation (what to ask, when to pause, when to summarize)
- Tone and formatting constraints

Skills live as `.md` files in the Claude Code project configuration. They do not contain code -- they are structured prompts that turn Claude into a facilitator for a specific workflow.

## Skill Index

| Command    | Purpose                          | Duration   | Interactive |
|------------|----------------------------------|------------|-------------|
| /review    | Weekly review (full GTD cycle)   | 20-40 min  | yes         |
| /daily     | Morning snapshot                 | 30 sec     | minimal     |
| /clarify   | Process inbox items              | 5-15 min   | yes         |
| /engage    | Context-aware action suggestions | 1 min      | light       |
| /sweep     | Guided brain dump                | 10-20 min  | yes         |
| /plan      | Project planning                 | 10-30 min  | yes         |

---

## /review -- Weekly Review

**Trigger:** `/review`

**Purpose:** Walk through the complete GTD weekly review: get clear, get current, get creative. Ensures every project has a next action, every waiting-for is still valid, and nothing is stuck.

**MCP tools used:**
- gtd: `list_inbox`, `process_inbox_item`, `list_projects`, `list_actions`, `create_action`, `update_action`
- awareness: `get_calendar_events`

### Conversation Flow

**Phase 1: CLEAR (Inbox to Zero)**
1. Call `list_inbox` to get all unprocessed items.
2. For each item, present it and ask: "What is this? Is it actionable?"
3. Based on user response, call `process_inbox_item` with the appropriate outcome (action, project, someday, reference, trash).
4. If actionable and takes < 2 minutes, flag it: "This sounds like a 2-minute item. Do it now?"
5. Continue until inbox is empty. Report: "Inbox clear. X items processed."

**Phase 2: PROJECTS (Get Current)**
1. Call `list_projects` to get all active projects.
2. For each project, display title and action count.
3. Flag projects with zero next actions: "This project has no next action. What's the next step?"
4. Flag stale projects (no activity in 2+ weeks): "This hasn't moved in a while. Still active?"
5. For each flagged project, create actions via `create_action` or move project to someday.
6. Report: "X projects reviewed, Y now have fresh next actions."

**Phase 3: WAITING (Follow-ups)**
1. Call `list_actions(list_type="waiting")`.
2. For each item, display: person, description, age in days.
3. Ask: "Any update on this? Should we follow up?"
4. If follow-up needed, create a new action. If resolved, mark complete.

**Phase 4: SOMEDAY (Reactivate or Cull)**
1. Call `list_actions(list_type="someday")`.
2. Present the list in groups.
3. For each: "Activate this? Keep on someday? Drop it?"
4. Process based on response.

**Phase 5: CALENDAR (Week Ahead)**
1. Call `get_calendar_events` for the next 7 days.
2. Display day-by-day summary.
3. Flag tight days (3+ events or back-to-back blocks).
4. Ask about prep needs: "Anything you need to prepare for these?"
5. Capture any prep items as actions.

**Phase 6: SWEEP (Mind Dump)**
1. Walk through categories one at a time: work, home/household, health, finances, people/relationships.
2. For each: "Anything on your mind about [category]?"
3. Capture each item via `capture_inbox`.
4. After all categories: "Got it all. X new items captured."

**Closing Summary:**
```
Weekly Review Complete
- Active projects: 12 (all have next actions)
- Waiting-for: 5 items (2 follow-ups created)
- Inbox: clear
- Week ahead: Tuesday and Thursday are packed
- Captured 7 new items during sweep
```

### Example Interaction (Phase 1 excerpt)

```
Claude: Starting your weekly review. Let's begin by clearing the inbox.
        You have 4 items. Here's the first:

        "Look into standing desk options" (captured 3 days ago from /sweep)

        What's this about -- is it something you want to act on?

User:   Yeah, I want to buy one. Need to research options first.

Claude: Got it. I'll create a project "Buy standing desk" with a first
        action "Research standing desk options and price range."
        Sound right?

User:   Yes.

Claude: Done. Next item:
        "Reply to Jake about dinner Friday" (captured yesterday)

        This sounds quick -- could you do it right now in under 2 minutes?

User:   Just did it.

Claude: Marked as done. 2 items left...
```

---

## /daily -- Morning Summary

**Trigger:** `/daily`

**Purpose:** Quick, read-only snapshot of the day ahead and GTD health. Gets the user oriented in under 30 seconds.

**MCP tools used:**
- awareness: `get_calendar_events`
- gtd: `list_actions`, `get_gtd_health`

### Conversation Flow

1. Call `get_calendar_events` for today.
2. Call `list_actions` with due date filter for today + overdue flag.
3. Call `get_gtd_health`.
4. Compose a concise summary (max 10 lines).
5. Add one proactive observation (pick the most relevant):
   - A waiting-for that's gone stale (> 7 days)
   - A project with no next action
   - An overdue action
   - A heads-up about tomorrow's calendar
6. Close with: "Anything on your mind for today?"

### Example Interaction

```
Claude: Good morning.

        Today: Stand-up at 9:30, Lunch with Maya at 12:30, Dentist at 4pm.
        Due today: "Send invoice to Acme" (work), "Buy groceries" (home).
        Overdue: "Review insurance renewal" (3 days overdue).
        GTD health: 2 items in inbox, 14 active projects, 6 waiting-for.

        Heads up: you've been waiting on Jake's contractor quote for 9 days.

        Anything on your mind for today?
```

---

## /clarify -- Inbox Processing

**Trigger:** `/clarify`

**Purpose:** Process inbox items one at a time using the GTD decision tree. Designed for when you have a few minutes and want to chip away at the inbox.

**MCP tools used:**
- gtd: `list_inbox`, `process_inbox_item`, `create_action`, `create_project`, `capture_inbox`

### Conversation Flow

1. Call `list_inbox`. If empty: "Inbox is clear. Nothing to process."
2. Present the first item with source and capture date.
3. Apply the GTD decision tree:
   - "Is this actionable?"
   - If no: reference, someday/maybe, or trash?
   - If yes: "Is this a single action or part of a larger outcome (project)?"
   - If single action: "Can you do it in under 2 minutes?" If yes, prompt to do it now.
   - If project: create project and define first next action.
   - Assign context, energy level, and time estimate if the user provides them.
4. Call `process_inbox_item` with the decision.
5. Move to the next item.
6. If user says "skip": mark as reviewed but leave in inbox, move on.
7. After every 5 items, offer to pause: "5 down, 8 to go. Keep going or take a break?"

### Example Interaction

```
Claude: You have 6 items in your inbox. Let's work through them.

        1/6: "Look into Kubernetes cert" (captured 5 days ago via /sweep)

        Is this something you want to act on?

User:   Yeah, someday. Not now.

Claude: Filed to someday/maybe.

        2/6: "Fix the leaky kitchen faucet" (captured 2 days ago)

        Actionable?

User:   Yes, I need to call a plumber.

Claude: Single action: "Call plumber about kitchen faucet."
        Any particular context or due date?

User:   Home context, do it this week.

Claude: Created. Due Friday. Next item...
```

---

## /engage -- What Should I Do Now?

**Trigger:** `/engage`

**Purpose:** Context-aware action recommendation. Uses the user's current situation (location, time, energy) to suggest what to work on right now.

**MCP tools used:**
- awareness: `get_situation`
- gtd: `recommend_actions`

### Conversation Flow

1. Call `get_situation` from the awareness MCP. This returns current location, time of day, recent context, and any active calendar events.
2. Call `recommend_actions` from the gtd MCP, passing the situation data. This returns prioritized actions that match the current context.
3. Present suggestions in three tiers:
   - **Quick (< 5 min):** small tasks you can knock out now.
   - **Medium (15-30 min):** focused work that fits the current slot.
   - **Deep (1+ hour):** larger blocks if the calendar is open.
4. If no actions match the current context: "Your lists are current and nothing's pressing. You're clear."
5. If the user picks one, optionally mark it as in-progress or complete when done.

### Example Interaction

```
Claude: You're at the office, it's 2:15pm, and your next meeting is at 4.
        You have a 1h45m window. Here's what fits:

        Quick wins:
        - Reply to Maya about venue options (5 min)
        - Review PR #42 (10 min)

        Medium:
        - Draft Q2 budget outline (30 min, due Friday)

        Deep:
        - Write architecture RFC for auth service (1.5h, high energy)

        What appeals?
```

---

## /sweep -- Mind Sweep

**Trigger:** `/sweep`

**Purpose:** Guided brain dump to get everything out of the user's head and into the inbox. Based on the GTD "incompletion trigger" lists.

**MCP tools used:**
- gtd: `capture_inbox`

### Conversation Flow

Walk through categories one at a time. For each, prompt the user and wait for their response. Capture everything they mention.

**Categories (in order):**
1. **Work:** projects, deadlines, emails to send, meetings to schedule, decisions pending
2. **Home/household:** repairs, purchases, chores, bills, organizing
3. **Health:** appointments, medications, exercise goals, diet changes
4. **Finances:** bills, investments, insurance, tax, subscriptions to cancel
5. **People/relationships:** calls to make, messages to send, plans to make, gifts, favors
6. **Personal projects:** hobbies, learning, side projects, creative work
7. **Waiting on others:** things you're expecting from someone else
8. **Upcoming events:** travel, conferences, holidays, birthdays
9. **Nagging thoughts:** anything else that's on your mind, even vague unease

**For each category:**
- Ask: "What about [category]? Anything unfinished, pending, or on your mind?"
- Capture each item the user mentions via `capture_inbox`.
- If the user says "nothing" or "clear," move on.
- Do not judge, organize, or process. Just capture.

**After all categories:**
- Report total: "Captured 14 items across 9 categories."
- Offer next step: "Want to start processing these now with /clarify?"

### Example Interaction

```
Claude: Let's do a mind sweep. I'll walk through some categories -- just
        tell me everything that comes to mind. Don't filter, just dump.

        First: Work. Any projects, deadlines, emails, decisions?

User:   I need to finish the API docs. And schedule a 1:1 with Tom.
        Oh, and follow up on that vendor contract.

Claude: Got all three. Next: Home and household?

User:   Nothing right now.

Claude: Moving on. Health -- appointments, exercise, anything?

User:   I should schedule a dentist checkup. And I've been meaning to
        start running again.

Claude: Captured both.
        ...
        [continues through all categories]
        ...
        All done. Captured 11 items across 9 categories.
        Want to start processing them now with /clarify?
```

---

## /plan -- Project Planning (Natural Planning Model)

**Trigger:** `/plan` or `/plan <project name>`

**Purpose:** Walk through the GTD Natural Planning Model for a specific project: define purpose, envision outcome, brainstorm, organize, and identify next actions.

**MCP tools used:**
- gtd: `create_project`, `create_action`, `capture_inbox`

### Conversation Flow

If no project name is given, ask: "What project do you want to plan?"

**Phase 1: PURPOSE**
- "Why are we doing this? What's the motivation?"
- Capture the user's answer as the project purpose.

**Phase 2: OUTCOME**
- "What does done look like? If this project were finished perfectly, what would be true?"
- Capture as the project's success criteria / definition of done.

**Phase 3: BRAINSTORM**
- "What's involved? Just list everything that comes to mind -- don't worry about order."
- Capture everything freely. No judgment, no organizing yet.
- Prompt for more: "What else?" until the user says they're done.

**Phase 4: ORGANIZE**
- Present all brainstormed items back.
- "Let's group and sequence these. What are the major phases or categories?"
- Help the user cluster items into groups and put groups in rough order.
- Identify dependencies: "Does anything need to happen before something else?"

**Phase 5: NEXT ACTIONS**
- "What are the very first concrete actions to get this moving?"
- For each action: create via `create_action` with the project linked.
- Assign contexts and due dates if the user provides them.

**Closing:**
- Create the project via `create_project` with purpose, outcome, and organized plan.
- Report: "Project created with X actions. First action: [action]."

### Example Interaction

```
Claude: What project do you want to plan?

User:   Move to a new apartment.

Claude: Good. Let's start with purpose.
        Why do you want to move? What's driving this?

User:   Current place is too small, and I want to be closer to work.

Claude: Got it. Now the outcome:
        If this move went perfectly, what would be true when it's done?

User:   I'd be in a 2-bedroom within 20 min of the office, moved in and
        settled, by end of June.

Claude: Clear target. Now let's brainstorm.
        What's involved in making this happen? Just list everything.

User:   Research neighborhoods. Set budget. Browse listings. Visit places.
        Give notice to landlord. Pack. Hire movers. Set up utilities.
        Update address everywhere. Buy new furniture for second bedroom.

Claude: That's 10 items. Anything else?

User:   Transfer gym membership. Oh, and get renter's insurance.

Claude: 12 items. Let me group these:

        Research & Decision:
        - Research neighborhoods
        - Set budget
        - Browse listings
        - Visit places

        Logistics:
        - Give notice to landlord
        - Hire movers
        - Pack
        - Set up utilities

        Post-Move:
        - Update address everywhere
        - Buy furniture for second bedroom
        - Transfer gym membership
        - Get renter's insurance

        Does that grouping work? Any dependencies?

User:   Yeah. Can't give notice until I've signed a new lease.

Claude: Noted. Now -- what are the very first actions to get started?

User:   Figure out my budget, and start looking at listings in 3 neighborhoods.

Claude: Created project "Move to new apartment" with 2 next actions:
        1. "Determine moving budget" (due: this weekend)
        2. "Browse listings in target neighborhoods" (due: next Monday)
        Ready to go.
```
