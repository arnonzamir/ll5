---
name: engage
description: Get smart action recommendations — "what should I do now?"
---

# Engage — What Should I Do Now?

Help the user decide what to work on right now based on context, energy, and available time.

## Steps

1. If awareness MCP is available, call `get_situation` for context (location, time, energy inference)
2. Ask the user about energy if not clear: "High focus, medium, or winding down?"
3. Ask about time if not clear: "How much time do you have?"
4. Call `recommend_actions` with the gathered criteria (energy, time_available, context_tags)

## Present Recommendations

Don't dump a raw list. Curate conversationally:

"You're [context — at home / it's evening / you have about an hour]. A few options:

- **Quick win** (under 15 min): [action] — [why it's a good pick]
- **Good use of the time** (30-60 min): [action]
- **If you're feeling focused**: [action]

What sounds right?"

## Edge Cases

- **Nothing matches**: "Your lists are current and nothing's pressing. You're clear." This is the GTD payoff — say it with confidence.
- **Everything is overdue**: Don't guilt. "You have a few things piling up. Want to pick the most important one, or should we do a quick review to reset priorities?"
- **User seems low energy**: Suggest only low-energy items. "Some easy wins: [phone calls, quick emails]."
- **User is at a specific place**: Filter by context. At store → shopping list. At office → @office actions.
