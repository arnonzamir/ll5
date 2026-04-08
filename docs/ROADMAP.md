# LL5 Roadmap

Unprioritized feature ideas and future directions. See PROGRESS.md for what's already built.

---

## ~~Health MCP~~ (DONE — Mar 31)

Built with Garmin integration: sleep, HR, body battery, HRV, VO2 Max, respiration, training readiness, activities, body composition. Dashboard UI. Generic repository pattern. Health polling scheduler: detects sleep/activity/HR anomaly/stress/energy/weight, 7-day baseline comparisons, batched system messages. **Remaining**: Android Health Connect API for real-time push.

---

## ~~Push Notification Levels~~ (DONE — Apr 3)

4 levels: silent/notify/alert/critical. Agent chooses per push, user sets ceiling + quiet hours. Android channels. FCM routing.

---

## ~~Geo Search~~ (DONE — Apr 5)

Built into awareness MCP (not separate): search_nearby_pois (Overpass), geocode_address (Nominatim), get_area_context, get_distance (OSRM).

---

## ~~Quick Camera → Agent~~ (DONE)

Android share sheet deployed — user shares image from gallery to LL5, uploads to gateway, agent sees it. **Remaining ideas**: photo observer (auto-send new photos), quick capture widget (home screen one-tap).

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

## ~~Bidirectional Chat Capture~~ (DONE for WhatsApp)

WhatsApp `fromMe` messages captured in webhook → written to ES with `from_me: true`, `processed: true`. Escalation triggers on user activity in ignored/batched chats. Agent sees "You sent" system messages for immediate/agent conversations.

### Remaining
- **Slack**: API (if workspace allows), accessibility service (fragile), or manual screenshots
- **Telegram**: Bot API reads conversations where bot is member
- **SMS**: Android SMS ContentProvider — sync on demand

---

## WhatsApp Message History Sync

Evolution API only stores messages received after connection. For groups and contacts with existing history, we need a backfill mechanism.

### Approach options:

1. **Evolution API `fetchMessages` with pagination** — Evolution stores messages in its internal DB (PostgreSQL). The `findMessages` endpoint may work with different query parameters (e.g., `where.key.remoteJid` vs `where.remoteJid`). Investigate the exact v2 API schema.

2. **WhatsApp Web export** — WhatsApp allows exporting chat history as `.txt` files. Build a parser that ingests exported chats → writes to ES `ll5_awareness_messages`. Manual but covers full history.

3. **Android WhatsApp ContentProvider** — on some devices, WhatsApp's local SQLite DB (`msgstore.db`) is accessible. The Android app could read it and push historical messages. Fragile (path changes between versions) but automated.

4. **Evolution webhook backfill** — when a new conversation is synced, trigger Evolution to fetch recent messages from the WhatsApp cloud backup. Evolution may support this via `fetchMessages` with broader parameters.

### What to store:
- Same format as webhook messages: sender, content, timestamp, is_group, group_name, from_me
- Write to ES `ll5_awareness_messages` with `source: "backfill"`
- Mark as `processed: true` (don't trigger notifications for old messages)

### Priority:
- Start with option 1 (investigate Evolution API deeper)
- Fallback to option 2 (WhatsApp export parser) for one-time backfill

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

## ~~Calendar Source Management UI~~ (DONE)

Built at `/calendar/settings` — per-calendar ignore/read/readwrite toggles, Google account connection status, reconnect button. **Remaining ideas**: color picker, auto-discovery notification for new calendars.

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

## ~~Someday/Maybe + Higher Horizons~~ (DONE)

Someday/maybe works end-to-end (list_type filter, create dialog, badges in UI). Horizons page with all levels (h=0-5). Weekly review skill covers both. Agent actively uses horizons for context.

---

## ~~User Management~~ (DONE — Apr 8)

All 5 phases built: AsyncLocalStorage concurrency fix, DB migration (auth_users + families), admin CRUD API (10 endpoints), dashboard admin UI, username login, rate limiting, PIN validation (6+ chars + blocklist), multi-user schedulers (per-user with 5min reconciliation), WhatsApp webhook user routing, onboarding wizard (5 steps). **Remaining**: per-user Claude Code agents (deployment concern, not code).

---

## Auth Hardening (Future)

Current: 6+ char PIN with bcrypt, rate limiting (5 attempts/15min), 7-day tokens with refresh. Sufficient for private family system.

**Future options (when needed):**
- **Device-bound sessions** — tie token to device fingerprint, stolen token useless on different device. Highest value, moderate effort.
- **Passkeys/WebAuthn** — passwordless, phishing-resistant. Best UX + security but complex to implement and device-bound (no cross-device).
- **Google OAuth SSO** — strong, familiar, no password to manage. Requires Google account per user, breaks for kids without Google.
- **TOTP 2FA** — PIN + authenticator app. Strong but kids can't manage it.
- **Admin passphrase** — require stronger passphrase (12+ chars, mixed) for admin accounts specifically.

**Not recommended:** Don't add complexity until there's a real threat or a user base beyond family. The bcrypt + rate limiting + token expiry + enabled flag covers the current threat model.

---

## Technical Debt & Infrastructure

- **SSE for Android chat**: replace polling with OkHttp SSE (web already uses SSE)
- ~~**Nightly journal consolidation**~~: DONE — gateway 2am scheduler + awareness MCP tools
- **Test coverage**: unit + integration tests for gateway, MCPs, channel MCP
- ~~**CI deploy**~~: DONE — GitHub Actions SSH deploy with GHCR docker login
- ~~**Session resume**~~: DONE — `./ll5 --resume` works with channel MCP
- ~~**UI list views audit**~~: DONE — all pages have headers, subtitles, search, edit/delete
- ~~**Uniform logging format**~~: DONE — audited (93% compliant), fixed critical offenders (shared was 0% → 100%)
- ~~**Duplicated auth-middleware**~~: DONE — extracted to @ll5/shared, 4 local copies deleted
