# LL5 Roadmap

Unprioritized feature ideas and future directions.

---

## Health MCP

A health & fitness data layer. Must be generic (not tied to one device/platform), but Garmin Connect is the first integration target.

- **Data model**: heart rate, sleep, steps, stress, body battery, activities, body composition
- **Garmin integration**: wrap Garmin Connect API (OAuth2, activity polling, daily summaries)
- **Generic interface**: repository pattern so Fitbit/Apple Health/Whoop can plug in later
- **Agent use**: "How did I sleep?" / "Am I recovered enough for a run?" / correlate stress with calendar load
- **Proactive**: surface insights — "You've had 3 bad sleep nights, consider lighter schedule"

---

## Push Notification Levels

Currently FCM pushes are binary (send or don't). Need tiered urgency:

- **Notice now**: vibrate + sound + heads-up notification. For: immediate messages from family, urgent calendar alerts
- **Look next time**: silent notification, badge only. For: batch summaries, FYI updates, non-urgent agent insights
- **Background**: no notification at all, just available in the app. For: routine acks, system status
- **Implementation**: Android notification channels per urgency level, FCM `priority` field, agent decides which level based on message priority rules

---

## Quick Camera → Agent

Frictionless way to send a photo to the agent. Three approaches (in order of simplicity):

1. **Share from Photos** (best): Android share sheet integration — user takes photo normally, shares to LL5 from gallery. LL5 receives the image, uploads to gateway, sends to agent. No custom camera needed.
2. **Photo observer**: background hook that watches for new photos in the camera roll, auto-sends to agent with context (time, location)
3. **Quick capture widget**: home screen widget that opens camera → takes photo → sends directly to LL5. One tap.

All approaches: image goes to Google Photos normally AND to the agent via chat upload.

---

## Money Tracking MCP

Personal finance layer. Progressive build:

### Tier 1: Data capture
- Listen on tap-to-pay notifications (Android NotificationListenerService for Apple Pay/Google Pay/bank apps)
- Connect to bank & credit card accounts (screen scraping or API where available — Israeli banks have limited APIs)
- Categorize transactions automatically (merchant name → category)
- Store in PG: transactions, accounts, balances

### Tier 2: Intelligence
- Cash flow tracking: income vs expenses, monthly burn rate
- Projections: "At this rate, you'll have X by end of month"
- Day-to-day: "You've spent 2,400 on groceries this month, 20% above average"
- Planning: budget goals, savings targets, upcoming large expenses

### Tier 3: Recommendations
- "You're paying 3 subscriptions for similar services"
- "Your credit card interest is higher than a loan would be"
- "Move X to savings — it's been sitting idle for 2 months"

---

## Bidirectional Chat Capture

Currently only captures messages the user RECEIVES. Need to also capture what the user SENDS:

### WhatsApp
- Evolution API already sees outbound messages (`fromMe: true`) — currently filtered out in `processWhatsAppWebhook`. Enable capture (write to ES, don't notify agent unless relevant)
- Agent can then understand full conversations, not just one side

### Slack
- Android notification listener only sees incoming. Options:
  - Slack API (if workspace allows): read conversation history
  - Accessibility service: capture compose/send events (invasive, fragile)
  - Manual: user shares conversation screenshots to LL5

### Other chats (Telegram, SMS)
- Telegram: Bot API can read messages in conversations where bot is a member
- SMS: Android SMS ContentProvider has full sent/received history — sync on demand

---

## Email Sync from Phone

For email accounts where API access isn't available (e.g., work Exchange behind Workspace policies):

- Android app reads from the device's email ContentProvider (like calendar sync for freeBusyReader accounts)
- Syncs email metadata (sender, subject, date, snippet) to ES `ll5_awareness_emails`
- NOT full body — just enough for awareness ("you got 3 emails from HR today")
- Push via webhook like calendar events
- Agent can then answer: "Any important emails I missed?" / "What did Sarah email about?"
- Privacy: configurable per-account (sync/ignore), metadata only (no body unless explicitly shared)

---

## Calendar Source Management UI

Dashboard UI for selecting which calendars to sync, ignore, or configure. The `configure_calendar` tool already supports `ignore/read/readwrite` per calendar — this adds the visual interface.

- **Calendar list**: show all discovered calendars (Google, phone-pushed, future sources) with current access mode
- **Per-calendar toggle**: ignore / read / readwrite
- **Color picker**: assign display colors per calendar
- **Source badges**: Google, Phone, Tickler — so user knows where each calendar comes from
- **Auto-discovery**: when new calendars appear (from Google sync or phone push), show them as "new" for user to configure
- **Location**: calendar settings panel (gear icon on calendar page) — extend the existing settings UI

---

## GTD Review Skill

The agent should proactively drive the GTD review workflow — not just remind the user, but actually do the work.

**Before building**: walk through the full GTD review workflow with the user to nail down the details. The agent needs to understand: what "processed" means for each item type, when to ask vs act, and what the user's personal rules are.

### Inbox Processing
- Agent regularly scans the inbox (not just when prompted)
- For each item, determines: is it actionable? If yes → next action, project, calendar, or delegate. If no → trash, reference, or someday/maybe
- Agent processes what it can autonomously (obvious categorizations, known patterns)
- Asks the user only for items that need judgment (commitment level, priority, delegation)
- Goal: inbox zero as a steady state, not an occasional event

### Weekly Review (agent-driven)
- Agent runs the full review: collect loose ends, process inbox, review actions/waiting/projects, review calendar (past + upcoming), review someday/maybe, update horizons
- Generates a structured review report
- Pushes via `push_to_user` when review surfaces actionable insights
- Scheduled (Friday afternoon) but can also be triggered on demand

### Inbox Items from Chats
- Identify actionable items from WhatsApp/Slack/phone messages
- "Mom asked if we're coming Friday" → inbox item or action
- "Boss mentioned the Q3 deadline moved" → capture as fact + action
- Agent scans batch review summaries and immediate messages for implicit commitments, requests, and todos
- Requires understanding conversation context (bidirectional chat capture helps here)

---

## Someday/Maybe + Higher Horizons

Verify and extend GTD horizon support:

- **Someday/Maybe list**: already supported via `list_type: 'someday'` on actions — verify it works end-to-end (create, review, promote to active)
- **Higher horizons** (h=2 areas, h=3 goals, h=4 vision, h=5 purpose): already in `gtd_horizons` table — ensure the agent actively uses them for context when making decisions
- **Review integration**: weekly review should include someday/maybe scan ("anything here you want to activate?") and periodic horizon check ("are your projects aligned with your goals?")
- **Dashboard UI**: ensure all horizon levels are visible and editable

---

## Technical Debt & Infrastructure

- **SSE for Android chat**: replace polling with OkHttp SSE (web already uses SSE)
- **Nightly journal consolidation**: server-side Claude API call to distill daily journal entries
- **Test coverage**: unit + integration tests for gateway, MCPs, channel MCP
- **CI deploy**: automated SSH deploy in GitHub Actions (currently manual `docker compose pull && up`)
- **Session resume**: ensure `--resume` works with channel MCP, or document that `./ll5` is required
