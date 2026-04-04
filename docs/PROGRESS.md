# LL5 Progress

Current state of the LL5 personal assistant system.

---

## Current Status

**Phase:** Health MCP with dashboard UI, all MCPs operational

### Deployed Services (Coolify @ 95.216.23.208)

| Service | Status | URL |
|---------|--------|-----|
| personal-knowledge MCP | Live | mcp-knowledge.noninoni.click |
| gtd MCP | Live | mcp-gtd.noninoni.click |
| awareness MCP | Live | mcp-awareness.noninoni.click |
| health MCP | Live | mcp-health.noninoni.click |
| gateway | Live | gateway.noninoni.click |
| dashboard | Live | ll5.noninoni.click |
| Elasticsearch 8.15.0 | Healthy | internal |
| PostgreSQL 16 | Healthy | internal |

### Built, Ready to Deploy

| Service | Notes |
|---------|-------|
| google MCP | OAuth creds ready, needs Coolify service + deploy |
| messaging MCP | Needs Evolution API URL |

### Client (ll5-run)

| Component | Status |
|-----------|--------|
| MCP connections (3) | Working |
| GTD skills (6) | Written |
| Welcome launcher | Working |
| Chat bridge (SSE listener) | Working |
| Stop/FileChanged hooks | Configured |
| Auth (signed tokens + PIN) | Working |

## Tool Count

| MCP | Tools |
|-----|-------|
| personal-knowledge | 17 |
| gtd | 14 + 3 chat |
| awareness | 10 |
| google | 13 (10 + 3 tickler) |
| messaging | 8 |
| health | 8 (sleep, HR, daily stats, activities, body comp, trends, sources, sync) |
| **Total** | **73** |

## Recent Changes

- 2026-04-04: Fix MCP naming collision: "calendar" and "messaging" collide with Claude Code first-party plugins, renamed to ll5-calendar/ll5-messaging. headersHelper works with script-based auth.
- 2026-04-04: Fix calendar MCP auth: remove OAuth discovery route handlers that confused Claude Code's MCP SDK
- 2026-04-04: Auto token refresh: POST /auth/refresh endpoint (accepts expired tokens within 7-day grace), channel MCP auto-refreshes on startup + every 12h
- 2026-04-04: Calendar UI: Google connection status + reconnect button, tickler list (next 30 days) in settings panel. REST API endpoints for auth-url and connection-status on Google MCP.
- 2026-04-04: Conversation escalation — user sends message in ignored/batched chat → 30-min immediate window, agent notified with context, must journal decision on expiry. Persisted in user_settings for session survival. Repeated messages extend timer.
- 2026-04-04: Recurring ticklers: create_tickler supports recurrence param (daily/weekly/weekdays/monthly/yearly/raw RRULE), complete_tickler handles instance vs series deletion
- 2026-04-04: Fix phone calendar sync: use Instances API (expands recurring events), capture calendar name, attendees, description, status, availability, timezone offsets
- 2026-04-03: Design docs for roadmap items: geo-search MCP (separate service), health polling scheduler, data source config, GTD review skill (quick+weekly), agent routing rename
- 2026-04-03: Fix user_settings PUT deep merge (PG || is shallow, replaced with JS read-merge-write)
- 2026-04-03: Unified user_settings table (JSONB) — consolidates timezone (was in google_user_settings, user_notification_settings, env vars) and notification levels into one table. Gateway GET/PUT /user-settings endpoints. Calendar MCP and schedulers read timezone from user_settings. Profile page has timezone selector.
- 2026-04-03: Fix gateway Dockerfile: copy SQL migrations to dist (were never included in container)
- 2026-04-03: User notification levels — 4 levels (silent/notify/alert/critical), agent chooses level per push, user sets max ceiling + quiet hours. push_to_user gets level param, gateway caps + sends FCM, Android 4 notification channels, dashboard settings page, agent instructions with guidelines
- 2026-04-03: WhatsApp archived groups — grayed out + auto-ignore in notification/messaging settings, is_archived column in messaging_conversations
- 2026-04-03: Places auto-geocoding — upsert_place forward-geocodes address→lat/lon via Nominatim when coordinates not provided
- 2026-04-03: WhatsApp JID→name fix — webhook resolves group names from messaging_conversations DB, UI strips @domain from raw JIDs
- 2026-03-31: Health MCP dashboard UI — /health page with overview, sleep, heart rate, daily stats, activities, body composition tabs. /settings/health for source management (connect/disconnect/sync). Health link in nav only shows when a source is connected. Generic health concepts (not source-specific). Dashboard calls same MCP tools as agent.
- 2026-03-31: Health MCP added to docker-compose.prod.yml with ES+PG deps, traefik routing, ENCRYPTION_KEY
- 2026-03-31: Media gallery page in dashboard — gateway endpoints (GET /media, GET /media/:id/links) querying ES ll5_media + ll5_media_links, dashboard gallery/list views with search, source filter, detail dialog with preview, linked entities
- 2026-03-31: Tiered push notifications — 3 urgency levels (urgent/info/low). New Android channels ("urgent" with vibrate+sound+heads-up, "info" silent badge-only). FCM data payload includes `notification_level` field. Android skips notification for level "low". Legacy channels kept for backward compat.
- 2026-03-31: Actions page: list_type filter (todo/waiting/someday/all), list_type in create dialog, fix camelCase field mapping (dueDate/context/listType/waitingFor/projectTitle), someday+waiting badges in ActionRow. CLAUDE.md updated with explicit someday/maybe guidance for agent.
- 2026-03-31: Dashboard list view audit — added subtitles to all page headers (actions, projects, inbox, shopping, people, knowledge, horizons, phone-data, sessions), dynamic title for admin logs (Application Log / Audit Log), overflow-y-auto on user layout main, metadata exports for sessions page
- 2026-04-01: Journal consolidation system — user model ES index (ll5_agent_user_model), read/write_user_model tools in awareness MCP, nightly consolidation trigger (2am) in gateway scheduler
- 2026-04-01: Chat SSE: real-time via PG NOTIFY on all changes. Channel MCP strict filter (inbound+content only). Temp ID mapping for status updates.
- 2026-04-01: Fix chat message fetch: return latest N messages (was returning oldest N, cutting off recent messages)
- 2026-04-01: Chat progress feedback — status indicators (pending/processing/delivered/failed) + typing indicator in dashboard and Android
- 2026-03-31: Unified message priority system — 4 levels (ignore/batch/immediate/agent), conversation rules, single gateway rule matcher for all sources. Fix: earlier migrations must be forward-compatible with later constraint additions.
- 2026-03-31: Fix message dedup: immediate + ignored messages marked processed (no double-report/leak in batch), batch review drops time-window filter (no orphans), WhatsApp immediates no longer send FCM notification (agent-only path)
- 2026-03-31: check_availability: device_freebusy mode — uses phone's Workspace OAuth token for same-domain coworker availability
- 2026-03-31: Fix check_availability device fallback auth — generate ll5 token instead of using API_KEY
- 2026-03-31: Messaging UI: "Named only" filter + sort by name/permission for conversations
- 2026-03-31: People filter dropdown uses high-level groups (family/friend/colleague/acquaintance/other) instead of raw values
- 2026-03-31: check_availability with device fallback — Google FreeBusy + phone CalendarProvider for any synced account
- 2026-03-31: Fix FCM sender — `require('node:fs')` silently failed in ESM gateway, FCM pushes never sent
- 2026-03-30: Device command queue — gateway queues commands for Android app via FCM, with confirm/fail lifecycle
- 2026-03-30: System message dedup — prevents spam on gateway restart (checks PG for recent duplicates)
- 2026-03-30: Message priority rules (immediate/batch routing) + 5 proactive schedulers
- 2026-03-29: Fix calendar push: accept null fields, per-item validation (skip bad items, don't fail batch)
- 2026-03-29: Calendar UI: hover tooltips, click for full details with source, holiday banner, all-day overlay
- 2026-03-29: Unified calendar layer — reads from ES, writes through Google API + ES, renamed google→calendar MCP
- 2026-03-29: Audit log (ES ll5_audit_log) — all mutations in GTD + calendar MCPs write audit entries
- 2026-03-29: Checkbox completion with animated fade-out on actions + shopping list pages
- 2026-03-29: Per-tenant timezone (set_timezone tool), freeBusy support for read-only calendars, calendar settings UI
- 2026-03-29: Calendar integration: Google MCP with OAuth callback, tickler calendar, periodic review, dashboard calendar page + insights panel
- 2026-03-29: Location map page with Leaflet, clustering, timeline slider, trail visualization
- 2026-03-29: Shopping list fixed to parse grouped MCP response
- 2026-03-29: All dashboard pages: search, edit/delete, profile page
- 2026-03-29: Channel MCP bridge (replaces file-watcher approach) for real-time chat
- 2026-03-29: Android companion app with chat, location tracking, notification capture
- 2026-03-28: Chat message queue with PG LISTEN/NOTIFY + SSE
- 2026-03-28: Dashboard deployed with chat panel (50/50 split)
- 2026-03-28: Auth token system with role in payload
- 2026-03-28: All 5 MCPs built, 4 deployed
- 2026-03-28: Coolify infrastructure set up
- 2026-03-27: Design docs, monorepo foundation, first MCPs

## Known Issues

- Google MCP deployed with dual auth (ll5 tokens + API key), needs OAuth flow to connect Google account
- Fixed gateway migration 004 constraint (was missing 'system' channel, causing crash on restart)
- Production ES index `ll5_awareness_calendar_events` may have old field names (start/end vs start_time/end_time) — delete and recreate index on deploy
- Dashboard MCP client sometimes gets stale responses (needs cache-busting)
- FileChanged hook replaced by Channel MCP (channel approach works reliably)
- Gateway SSE listener needs reconnect-on-error improvement

## Tech Debt

- personal-knowledge and gtd MCPs have duplicated auth-middleware.ts (should use @ll5/shared)
- ES indices use 8.15.0 (not latest) due to server cache
- No tests for any MCP or gateway
- Dashboard pages fully implemented (no more stubs)
- Leaflet packages added to dashboard but lockfile was out of sync (fixed)
