# LL5 Handoff

Everything needed to continue working on the LL5 personal assistant system.

---

## Architecture

Claude Code is the agent. 5 MCP servers are the data layer. Gateway handles webhooks and chat. Dashboard is the web UI.

```
Claude Code (ll5-run workspace)
  ├── personal-knowledge MCP (ES) — facts, people, places, profile, data gaps, known_networks (BSSID→place bindings, manual + auto-learned)
  ├── gtd MCP (PG) — actions, projects, horizons, inbox, shopping, chat tools
  ├── awareness MCP (ES) — GPS, IM, entity statuses, calendar, situation, journal, user model, geo search (POI/distance/geocode), phone_statuses, wifi_connections
  ├── calendar MCP (PG+ES) — Unified timeline (Google+phone+tickler), Gmail, OAuth
  ├── health MCP (ES+PG) — sleep, heart rate, daily stats, activities, body comp, stress, trends
  ├── messaging MCP (PG) — WhatsApp send/receive, contacts, auto-match
  └── system MCP (local stdio, no storage) — battery, cpu, memory, disk, system_health for THIS Mac. Source in ll5/packages/system; registered in ll5-run/.mcp.json (absolute path to ll5/packages/system/dist/index.js). Pull-only; not deployed remotely.

Gateway (Express)
  ├── POST /webhook/:token — phone push data (GPS, IM, calendar)
  ├── POST /auth/token — PIN login, returns signed token
  ├── /chat/* — message queue REST endpoints
  ├── GET /chat/listen — SSE for real-time notifications (PG LISTEN/NOTIFY, 30s keepalive ping)
  ├── GET /admin/health — aggregate health (all MCPs + DBs + per-user channel liveness, cached from monitors)
  ├── /media, /media/:id/links — media file listing + linked entities (ES ll5_media, ll5_media_links)
  ├── /commands/* — device command queue (queue, pending, confirm)
  ├── Schedulers (13) — heartbeat (5min), calendar sync (30min), calendar review (periodic),
      daily briefing (morning), tickler alerts (1h), GTD health (4h), weekly review (Fri 14:00),
      message batch (30min), journal consolidation (2am), journal health/agent nudge (15min),
      health polling (20min, detects sleep/activity/HR/stress/energy/weight, 7-day baseline),
      mcp-health-monitor (2min ping all 7 services + tool error-rate scan, critical FCM on 2-in-a-row failure),
      channel-liveness-monitor (2min check for pending inbound msgs stalled >5min → critical FCM, 10min cooldown)
  ├── System message dedup — checks PG for recent duplicate before inserting
  └── Immediate + ignored messages mark ES doc as processed (prevents double-report/leak in batch review)

Dashboard (Next.js 15)
  ├── /login — user_id + PIN auth (all pages redirect here if unauthenticated)
  ├── Nav: display name from profile, grouped menus (Calendar, Organize, People & Places, Data), profile dropdown with logout
  ├── Build ID in footer (left-aligned, black)
  ├── Dashboard + calendar use local timezone (not UTC) for all date calculations
  ├── /dashboard — GTD status + chat panel (50/50)
  ├── /actions, /projects, /inbox, /shopping — GTD pages
  ├── /calendar — day/week timeline views with work hour coloring, current time line, configurable week start day
  ├── /calendar/settings — Google account connection + calendar source access modes
  ├── /calendar/ticklers — tickler list grouped by date (90 days), recurring badges
  ├── /phone-data — review phone-pushed data (locations, messages, calendar) with type/time filters
  ├── /settings/contacts — 3 tabs: People (with unlink per platform), Contacts (with link popover + auto-match wizard), Groups. Routing/permission/media controls on all.
  ├── /settings/notifications — People + Conversations + Keywords tabs, 4 priority levels (ignore/batch/immediate/agent)
  ├── Chat: SSE real-time (PG NOTIFY on insert+update), status indicators, typing dots, 30s safety sweep
  ├── /media — media gallery (images, videos, files) with gallery/list views, source filter, search, detail dialog
  ├── /health — health data browsing: overview, sleep, HR, daily stats, activities, body comp (only visible when source connected)
  ├── /settings/health — connect/disconnect health sources, trigger sync
  ├── /locations — Leaflet map with clustering, timeline, trail (z-0 to stay below nav)
  ├── /places — list + map split view (Leaflet markers for places with coordinates)
  ├── /people, /knowledge, /horizons — personal knowledge pages (people: server-side search, 24/page pagination, limit 200)
  ├── /export — full data backup download (JSON)
  ├── /profile — user settings
  └── /admin — system health, users, tools
```

## Repos

| Repo | Purpose |
|------|---------|
| arnonzamir/ll5 | Dev monorepo — all MCPs, gateway, dashboard, shared, docs |
| arnonzamir/ll5-run | Client workspace — CLAUDE.md, .mcp.json, skills, hooks, launcher |

## Server

| Item | Value |
|------|-------|
| IP | 95.216.23.208 |
| SSH | `ssh -i ~/.ssh/id_ed25519 root@95.216.23.208` |
| Coolify dashboard | https://cp.arnonzamir.co.il |
| Coolify API token | `eZRQh5pdR1WUKFLEYaNjgxI8nmnpH1QlW0iHz9cK52994642` |
| Coolify project UUID | `h48ssk80ko0sgscs0g0ws04o` |
| Service UUID | `xkkcc0g4o48kkcows8488so4` |
| Compose path | `/data/coolify/services/xkkcc0g4o48kkcows8488so4/docker-compose.yml` |
| Domain | noninoni.click (wildcard via Cloudflare) |

## Auth

| Item | Value |
|------|-------|
| AUTH_SECRET | `b2cf0d60414119aeb9df4828f952cdae712bad545251a943bd5bdb4e312dc4e2` |
| Admin user_id | `f08f46b3-0a9c-41ae-9e6a-294c697424e4` |
| Admin PIN | `1234` |
| Token format | `ll5.<base64url {uid,role,iat,exp}>.<32char hmac>` |
| Token TTL | 7 days |
| Token refresh | `POST /auth/refresh` — accepts valid or expired token (within 7-day grace), returns new token. Channel MCP auto-refreshes on startup + every 12h. |

## Google OAuth

| Item | Value |
|------|-------|
| Client ID | Set in Coolify env `GOOGLE_CLIENT_ID` |
| Client Secret | Set in Coolify env `GOOGLE_CLIENT_SECRET` |
| Redirect URI | `https://mcp-google.noninoni.click/oauth/callback` |
| Encryption Key | Set in Coolify env `ENCRYPTION_KEY` (generate with `openssl rand -hex 32`) |
| Scopes | calendar.readonly, calendar.events, gmail.readonly, gmail.send |
| Timezone | Per-user via `set_timezone` tool, stored in `google_user_settings` table (default: Asia/Jerusalem) |
| Tickler Calendar | "LL5 System" (role=tickler). Found by searching Google Calendar list for "ll5"/"tickler" — never created programmatically. Defaults to 08:00, pass due_time for specific time. Supports `recurrence`: daily/weekly/weekdays/monthly/yearly or raw RRULE. `complete_tickler` deletes instance (series continues) or pass `delete_series=true` to stop the series. |
| Calendar Access Modes | ignore, read, readwrite (CRUD enforced per mode) |
| Availability Check | `check_availability` — 3 paths: google (server FreeBusy), device (phone CalendarProvider), device_freebusy (phone's Workspace OAuth → Google FreeBusy for same-domain coworkers) |

OAuth flow: Claude calls `get_auth_url` → user visits URL → Google redirects to callback → tokens stored automatically. Dashboard: Calendar settings → Google Account → Reconnect button (calls `/api/auth-url` REST endpoint).

Google MCP accepts both ll5 signed tokens (same as other MCPs) and legacy API key. Set `AUTH_SECRET` env var for token auth. Do NOT add explicit OAuth discovery route handlers (/.well-known/*, /register) — the default HTML 404 is correct. JSON 404s confuse Claude Code's MCP SDK into thinking auth is needed.

## Databases

**PostgreSQL** (ll5 database, user: ll5, password: changeme123):
- `gtd_horizons` — unified GTD h=0-5
- `gtd_inbox` — captured items
- `gtd_review_sessions` — review tracking
- `auth_users` — user accounts with PIN hash and role
- `chat_messages` — message queue with status lifecycle
- `notify_chat_message` — PG trigger for LISTEN/NOTIFY on new inbound messages
- Channel constraint includes: web, telegram, whatsapp, cli, android, system
- `device_commands` — command queue for Android app (pending/sent/confirmed/failed/expired), result_data JSONB for return values
- `fcm_tokens` — FCM registration tokens per user/device

**User Notification Levels** (4-level phone attention system):
- `silent` — IMPORTANCE_LOW, notification shade + badge, no sound (FYI items)
- `notify` — IMPORTANCE_DEFAULT, sound or soft vibration (contextual on-the-go updates)
- `alert` — IMPORTANCE_HIGH, sound + vibration + heads-up (urgent messages, escalations)
- `critical` — IMPORTANCE_HIGH + bypass DND (emergencies only)
- User sets max level for normal hours + quiet hours (stored in `user_notification_settings` table)
- Agent chooses level per `push_to_user` call; gateway caps based on settings + time
- `push_to_user` `level` param triggers FCM via POST /chat/messages `notification_level` field
- Agent must journal every notification level decision
- Legacy channels (`urgent`, `info`, `ll5_morning`, `ll5_tickler`, `ll5_urgent`, `ll5_general`) kept for backward compat

**Elasticsearch** (8.15.0 on server, 8.17.0 in repo compose — server pinned to 8.15.0):
- `ll5_knowledge_*` — facts, people (with `status`: full/contact-only), places, profile, data_gaps
- `ll5_awareness_*` — locations, messages, entity_statuses, calendar_events (synced from Google + phone), notable_events
- `ll5_agent_*` — journal (micro-entries), user_model (consolidated, versioned with history index), user_model_history (snapshots before overwrite)
- `ll5_health_*` — sleep, heart_rate, daily_stats (stress, body battery, HRV, VO2 Max, respiration), activities, body_composition
- `ll5_app_log` — all tool calls from all 6 MCPs (service, level, action, tool_name, duration_ms, user_id)
- `ll5_audit_log` — all mutations across all 6 MCPs + gateway (source, action, entity_type, entity_id, summary). Admin UI has hoverable entity IDs with detail tooltips.
- Note: calendar index has text-mapped calendar_id (use .keyword subfield for term queries)
- Calendar push accepts date-only strings and null values (Android Moshi sends explicit null, not undefined)
- Phone calendar sync uses Instances API (not Events API) — expands recurring events into individual occurrences. Captures calendar_name, attendees, description, status, availability per event.

## CI/CD

- GitHub Actions: `.github/workflows/build-and-push.yml`
- Builds changed packages on push to main, pushes to GHCR
- Auto-deploy: `appleboy/ssh-action@v1` SSHs to server, `docker login ghcr.io` using `GITHUB_TOKEN`, then `docker compose pull && up -d --remove-orphans`
- Health check: curls mcp-knowledge.noninoni.click/health (4 retries, non-blocking)
- Deploy only runs on main branch (skipped for workflow_dispatch)
- Secrets configured: `DEPLOY_SSH_KEY`, `COOLIFY_SERVICE_UUID` (GitHub secrets) + `SERVER_HOST` (GitHub variable)

## How to Deploy

```bash
git push  # triggers CI build + auto-deploy (~3-4 min total)
```

Deploy is fully automated: push to main triggers build, then SSH deploy with health check.

Manual deploy (if needed):
```bash
ssh -i ~/.ssh/id_ed25519 root@95.216.23.208
cd /data/coolify/services/xkkcc0g4o48kkcows8488so4
docker compose pull && docker compose up -d --remove-orphans
```

## How to Run Locally

```bash
cd ~/workspace/ll5-run
./ll5  # starts listener + Claude with greeting
```

## Key Lessons Learned

See docs/implementation/deployment-log.md for full details:
- MCP server names in `.mcp.json` must NOT be "calendar" or "messaging" — Claude Code SDK collides with first-party plugins and forces OAuth. Use `ll5-calendar`, `ll5-messaging` prefix.
- Coolify API unreliable for start/restart — use SSH
- Docker DNS shadows service names when on multiple networks — use full container names
- PG POSTGRES_PASSWORD only used at first init — ALTER ROLE for changes
- ES versions not backwards-compatible — can't downgrade with existing data
- MCP StreamableHTTP needs per-request server+transport pair
- FileChanged hook doesn't reliably wake Claude — Channel MCP is the working solution
- Gateway is ESM — never use `require()` for node builtins; use static `import` instead
- Gateway Dockerfile must copy `src/migrations` to `dist/migrations` (SQL files aren't compiled by tsc)
- **Unified user settings**: `user_settings` table with JSONB `settings` column. Gateway `GET/PUT /user-settings`. Structure: `{ timezone, work_week: { start_day, start_hour, end_hour }, notification: { max_level, quiet_max_level, quiet_start, quiet_end } }`. PUT does deep merge. `get_current_time` tool includes work schedule context (cached 5 min in channel MCP).
- **Design docs ready for review**: geo-search MCP (separate service with POI/distance/context tools), health polling scheduler (event detection + thresholds), data source config (per-source toggles), GTD review skill (quick+weekly with adaptive behavior), agent routing rename
- **Scheduler settings**: all intervals configurable via `user_settings.scheduler` JSONB. UI at `/settings/scheduler`. Env vars are fallbacks.
- **Scheduler audit trail**: every system message has `event_id` in metadata + content. Agent replies tracked via `in_response_to` correlation.
- **Data-rich heartbeat**: includes upcoming events (past+future from ES), pending message counts, overdue flags.
- **Agent nudge**: includes upcoming events + proactivity checklist. Fires when no journal entries in configured interval.
- **Conversation escalation**: user sends fromMe in ignored/batched WhatsApp conversation → 30-min immediate window. Stored in `user_settings.active_escalations` (survives restarts). Gateway checks `isEscalated()` in matcher, overrides priority to immediate. On expiry, agent must journal + decide priority. No reply permission — awareness only.
- WhatsApp webhook resolves group/contact names from messaging_conversations table. System messages include `[image attached: URL]` for image messages.
- WhatsApp images: pass full message object (not just key) to Evolution API `getBase64FromMediaMessage`. Falls back to direct URL if Evolution API fails.
- WhatsApp webhook resolves group/contact names from messaging_conversations table (shared PG)
- Places upsert auto-geocodes address→coordinates via Nominatim when lat/lon not provided (1 req/sec rate limit)
- People relationship field is free-text; UI groups them into family/friend/colleague/acquaintance/other for filtering
- Migrations that DROP+ADD constraints must include ALL values (not just original), since later migrations may have already inserted new values
- MCP-to-gateway calls need ll5 signed tokens (generateToken from @ll5/shared), not static API_KEY
- **Evolution API key**: stored encrypted in `messaging_whatsapp_accounts.api_key` using AES-256-GCM with the `ENCRYPTION_KEY` env var. If the key was stored as plain text (pre-encryption), it must be re-encrypted. Use the `encrypt()` function from `@ll5/messaging/utils/encryption`.
- **WhatsApp pushName enrichment**: webhook updates `messaging_contacts.display_name` from `pushName` on every 1:1 message, but only if current name is null/empty/phone-number-only. Won't overwrite good names.
- **Android share sheet**: deployed — user shares images from gallery to LL5, uploads to gateway, agent receives via system message. No separate design doc.
- **Bidirectional WhatsApp capture**: `fromMe` messages written to ES (`from_me: true`, `processed: true`). Agent sees "You sent" for immediate/agent conversations. Escalation on user activity in ignored/batched chats.
- **Source routing for replies**: System messages from WhatsApp include `metadata.source` with `{ platform, remote_jid, sender_name, is_group, group_name }`. PG NOTIFY trigger (migration 018) passes `source` in the payload. Channel MCP includes it in `meta.source`. Agent must use `send_whatsapp(to=remote_jid)` — never `reply()` — for WhatsApp messages. This fixes the bug where image message replies went to the wrong channel.
- **Admin logs**: Datadog-style LogExplorer at `/admin/logs` (app log) and `/admin/audit` (audit log). Faceted sidebar with ES aggregations, time range presets, sortable table, slide-out detail panel with entity tooltips. ES queries use `aggs` for dynamic facet counts.
- **Test suite**: 369 tests across 8 packages (shared: 21, gateway: 113, knowledge: 41, gtd: 45, awareness: 47, health: 35, messaging: 40, google: 27). Run per-package: `cd packages/PKG && npx vitest run`. Dashboard not covered.
- **Shared auth middleware**: `tokenAuthMiddleware` from `@ll5/shared` used by personal-knowledge, gtd, awareness, health MCPs. Config: `{ authSecret, legacy?: { apiKey, userId } }`. Messaging and google MCPs still have inline auth (different pattern).
- **Onboarding**: New users with `user_settings.onboarding.completed === false` are auto-redirected to `/onboarding`. 5 steps: profile name, timezone (browser-detected default), Google Calendar (optional), Android app (optional), complete. Admin user creation seeds the onboarding state. Existing users without the `onboarding` key are unaffected. Middleware injects `x-pathname` header for redirect loop prevention.
- **Multi-user schedulers**: `scheduler/index.ts` queries `auth_users WHERE enabled = true`, starts full scheduler set per user. `reconcileUsers()` runs every 5min to start/stop schedulers for new/disabled users. Falls back to webhookTokens if no users in DB.
- **WhatsApp webhook routing**: `utils/whatsapp-user-resolver.ts` maps Evolution API instance name → user_id via `messaging_whatsapp_accounts`, cached 5min. Falls back to webhookTokens[0].
- **PIN strength**: Blocklist in admin.ts rejects common PINs (1234, 0000, 1111-9999, 123456, etc.)
- **Admin API response format**: All list endpoints return wrapped objects (`{ users: [...] }`, `{ families: [...] }`), not bare arrays. Dashboard server actions must unwrap. User PK field is `user_id` (not `id`).
- **Admin API**: `/admin/users` (list/get/create/patch/pin/delete) + `/admin/families` (list/create/add member/remove member). All require `role: 'admin'` token. PIN hashed with bcrypt (12 rounds). Soft delete (enabled=false). User creation generates UUID + hashes PIN. Family members have role (parent/child/member).
- **Login rate limiting**: In-memory Map in auth.ts. 5 failed attempts per loginId → 429 for 15 minutes. Resets on success. Periodic cleanup.
- **AsyncLocalStorage in MCPs**: All 6 MCPs use `AsyncLocalStorage` for per-request user context instead of module-level variable. `getUserId()` throws if called outside request context. Fixes concurrency hazard under multi-user concurrent requests.
- **User management DB**: Migration 019 adds `role`, `enabled`, `display_name`, `username`, `updated_at` to `auth_users`. `families` and `family_members` tables for parent/child/member relationships. Login accepts username or UUID, checks `enabled = true`.
- **Data source toggles**: `user_settings.data_sources` JSONB with per-source `{ enabled: bool }`. Gateway `isSourceEnabled()` in `utils/data-source-config.ts` (60s cache). Checked before `processItem` (location/message/calendar) and WhatsApp webhook. Defaults to all enabled. Dashboard page: `/settings/data-sources`.
- **Documentation hygiene**: PROGRESS.md uses `bash` snippets instead of hardcoded counts (tool counts, page counts, etc.). `/doc-audit` skill in ll5-run audits all living docs against codebase reality. Run at session end or when drift is suspected.
- **Contacts page performance**: Setting changes are fire-and-forget (optimistic UI, no blocking). Data cached in sessionStorage (key: `ll5_contacts_cache`, 5min TTL). On revisit: instant paint from cache, background refresh if stale.
- **Contact-only persons**: Person records with `status: 'contact-only'` are lightweight stubs auto-created from messaging contacts. They enable per-contact routing without a full KB entry. The gateway matcher is unchanged — all routing resolves via person_id → contact_settings. Promote to `status: 'full'` to make a real KB person. Dashboard `/settings/contacts` has 3 tabs: People (full+contacts), Contacts (contact-only + unlinked), Groups.
- **Auto-match**: Person-first approach — fetches all unlinked people + named contacts, scores by name similarity (exact/contains/first-name), with Hebrew-Latin cross-script lookup table (~80 Israeli names). Threshold 0.65, up to 5 candidates per person. UI shows person card + contact candidates to pick from.
- **Contacts Named only filter**: Client-side filter excludes contacts whose display_name is a phone number, WhatsApp JID (@s.whatsapp.net, @lid, @g.us), or digits-only.
- **Contacts pagination**: Client-side 50/page for the Contacts tab in /settings/contacts.
- **Calendar event cleanup**: After processing calendar_event webhook items, gateway deletes phone-sourced ES events in the pushed time window that weren't in the batch — detects events deleted from the phone calendar.
- **Android calendar push**: Reduced from 7+60 days to 1+14 days (500→~100 events per push). device_calendar items silently accepted.
- Exclude __tests__ from tsc in all MCP tsconfigs (vitest handles test compilation)
- **Evolution API contact limitation**: `findContacts({where:{}})` times out on 2913 contacts. Single-JID queries work. `pushName` is the only name field — no phone address book access. Fix: Android phone contacts push enriches names from address book.
- **Android phone contacts push**: `ContactsRepository` reads `ContactsContract.CommonDataKinds.Phone`, pushes name+phone as `phone_contact` webhook items (batches of 200). Gateway `processPhoneContacts` normalizes phone numbers (strips non-digits, generates Israeli +972/0 variants), matches against `messaging_contacts.platform_id` JIDs, updates `display_name` only where current name is null/empty/phone-number-only/JID. Runs in `PushSyncWorker` every 15min alongside IM and GPS push. Requires `READ_CONTACTS` permission.
- **Gateway ENCRYPTION_KEY**: Gateway needs `ENCRYPTION_KEY` env var to decrypt Evolution API key for WhatsApp media download. Add to Coolify gateway service config (same value as messaging MCP). Without it, media download falls back to using the raw (encrypted) key, which fails silently.
- **Evolution API webhook events**: Subscribed to `MESSAGES_UPSERT`, `CONTACTS_UPSERT`, `CONTACTS_UPDATE`. Contact events route to `processWhatsAppContactWebhook` in gateway. Contact enrichment uses INSERT...ON CONFLICT (ensure-upsert) with weak-name detection (null/empty/phone-number/JID-as-name).
- **Evolution API participantAlt**: Group messages from `@lid` participants include `participantAlt` with the `@s.whatsapp.net` JID. Both JIDs get enriched with pushName on every message. This provides LID→phone number mapping.
- **backfill_contact_names tool**: MCP tool on messaging MCP. Paginates through all Evolution messages (`findMessages` with `where:{}`, limit=500), extracts latest pushName per sender JID, bulk-upserts to `messaging_contacts`. Safe to re-run (COALESCE preserves existing names).
- **Contact link popover z-index**: The `LinkPopover` wrapper gets `z-50` when open so the search dropdown renders above sibling rows and the column header.
- **Escalation message scoping**: `fetchRecentMessages` in `escalation.ts` now properly filters by conversation: groups match on `group_name.keyword`, 1:1 matches on sender phone + `is_group=false`. Previously used `minimum_should_match: 0` which returned all conversations. Escalation header now includes resolved contact name and chat type (1:1/group).
- **Channel MCP liveness**: The stdio bridge at `ll5-run/channel/ll5-channel.mjs` keeps a single SSE connection open to `/chat/listen`. It aborts and reconnects on (a) 60s of idle (no keepalive received), (b) HTTP non-2xx, (c) token refresh. Liveness is written every 15s to `~/.ll5/channel-health.json` (`{connected, last_sse_data_at, idle_ms, reconnect_count, last_error, pid}`). The `channel_health` MCP tool exposes the same snapshot so Claude can self-diagnose. `unhandledRejection`/`uncaughtException` → `process.exit(1)` so Claude Code's MCP SDK respawns the child.
- **MCP health monitor**: `packages/gateway/src/scheduler/mcp-health-monitor.ts` pings `/health` on all 7 services every 2 min (parallel, 5s timeout each), caches the snapshot in-memory (exported via `getHealthSnapshot()`), and additionally aggregates `ll5_app_log` for the last 15 min to catch "responds 200 but tool calls failing" — alerts when ≥10 calls show >25% error rate. FCM critical push on transition to unhealthy after 2 consecutive failures, FCM notify on recovery.
- **Channel liveness monitor**: `packages/gateway/src/scheduler/channel-liveness-monitor.ts` detects the "zombie bridge" mode (channel MCP process alive, SSE hung) by querying `chat_messages` for inbound rows in `status='pending'` older than 5 min. Only alerts during active hours with a 10-min cooldown. This is the last-line defense — the client watchdog may miss it if the MCP process is still running but not delivering.
- **Client watchdog**: `ll5-run/watchdog/watchdog.sh` reads `~/.ll5/channel-health.json` and enforces two invariants during active hours (07–23 Asia/Jerusalem): (1) main claude session is running in ll5-run workspace (detected via `pgrep -f 'claude .*ll5-channel'`); (2) SSE idle time from the health file is <120s. Violations trigger a single FCM push (via `POST /chat/messages` with `notification_level`) with a 10-min cooldown. Does **not** attempt nohup-launched Claude restarts — that can't attach a TTY, it silently fails and spams the log.











