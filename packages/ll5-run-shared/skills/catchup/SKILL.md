---
name: catchup
description: Load journal context at session start — review active observations, commitments, and recent entries
---

# Catch Up

Load and review your journal context to restore continuity from previous sessions.

## Steps

1. **Load open entries**: Call `read_journal(status: "open", limit: 30)` — these are active observations, commitments, unresolved threads
2. **Load recent entries**: Call `read_journal(since: "<24 hours ago ISO>", limit: 20)` — recent entries regardless of status, for fresh context
3. **Load user model**: Call `read_user_model()` — load all sections of accumulated user understanding
4. **Load active narratives**: Call `list_narratives({ status: "active", limit: 25 })` — top active threads in the user's world (people, groups, places, topics). Then call `list_narratives({ status: "active", stale_for_days: 14, limit: 10 })` separately to flag threads that haven't moved recently — those may need a gentle check-in if a relevant signal appears.
5. **Pay special attention to `active_context`** (current hot topics, mood, pending commitments)
6. **Review silently**: Absorb the context. Note:
   - Any **commitments** with deadlines — surface to user if overdue
   - Any **feedback** entries — adjust your behavior accordingly
   - Any **context** entries — understand current user state
   - Any **observations** or **patterns** — keep in mind for this session
   - **Narrative summaries** — these are the threads in the user's life (Tamar, the family group, workload, Rotem's mood, the bookshelf). When relevant entities come up later in the session, call `recall` to pull current state + recent observations.
7. **Brief internal summary**: Note to yourself what you've learned. Don't output this to the user unless asked.
8. **Check time**: Call `get_current_time` to orient yourself

## When to Use

- At the start of every new session (run automatically or when prompted)
- After a long idle period
- When the user says "catch up" or "what do you remember"
