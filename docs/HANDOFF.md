# LL5 Handoff

Everything needed to continue working on the LL5 personal assistant system.

---

## Architecture

Claude Code is the agent. 5 MCP servers are the data layer. Gateway handles webhooks and chat. Dashboard is the web UI.

```
Claude Code (ll5-run workspace)
  ├── personal-knowledge MCP (ES) — facts, people, places, profile, data gaps, known_networks (BSSID→place bindings, manual + auto-learned)
  ├── gtd MCP (PG) — actions, projects, horizons, inbox, shopping, chat tools
  ├── awareness MCP (ES) — GPS, IM, entity statuses, calendar, situation, journal, user model, geo search (POI/distance/geocode), phone_statuses, wifi_connections, LocationService (get_current_location + where_is_user fuse GPS + wifi BSSID)
  ├── calendar MCP (PG+ES) — Unified timeline (Google+phone+tickler), Gmail, OAuth
  ├── health MCP (ES+PG) — sleep, heart rate, daily stats, activities, body comp, stress, trends
  ├── messaging MCP (PG) — WhatsApp send/receive, contacts, auto-match
  └── system MCP (local stdio, no storage) — battery, cpu, memory, disk, system_health for THIS Mac. Source in ll5/packages/system; registered in ll5-run/.mcp.json (absolute path to ll5/packages/system/dist/index.js). Pull-only; not deployed remotely.

Gateway (Express)
  ├── POST /webhook/:token — phone push data (GPS, IM, calendar); rate-limited 120 req/min/user, sliding window
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
  └── /admin — system health, users, tools, logs, audit, gps-cleanup (time-range + outside-Israel filter + one-click scan-and-delete)
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
| Token refresh | `POST /auth/refresh` — accepts valid or expired token (within 7-day grace), returns new token. Channel MCP auto-refreshes on startup + every 12h. Dashboard refreshes via `middleware.ts` when `secondsLeft < 2 days`; writes the new token to both `request.cookies` (so current-request server actions see it) and the response cookie. Beyond grace it clears the cookie and redirects to `/login?next=<path>`. |

## Google OAuth

| Item | Value |
|------|-------|
| Client ID | Set in Coolify env `GOOGLE_CLIENT_ID` |
| Client Secret | Set in Coolify env `GOOGLE_CLIENT_SECRET` |
| Redirect URI | `https://mcp-google.noninoni.click/oauth/callback` |
| Encryption Key | Set in Coolify env `ENCRYPTION_KEY` (generate with `openssl rand -hex 32`) |
| Scopes | calendar.readonly, calendar.events, gmail.readonly, gmail.send |
| Timezone | Two layers: (1) per-user value in `google_user_settings.timezone` (set via `set_timezone`), used for calendar tools that need user-personalized rendering. (2) Session/process TZ from `process.env.TZ` (read via `sessionTimezone()` from `@ll5/shared`) — this is the canonical TZ for agent-facing time formatting (heartbeat banner, `formatTime` paired output, tickler creation default). All MCP services run with `TZ=Asia/Jerusalem` in Coolify env. Agent-facing tool responses include both `utc` and `local` paired with a top-level `tz` envelope so the agent never has to convert. |
| Tickler Calendar | "LL5 System" (role=tickler). Found by searching Google Calendar list for "ll5"/"tickler" — never created programmatically. Defaults to 08:00, pass due_time for specific time. Supports `recurrence`: daily/weekly/weekdays/monthly/yearly or raw RRULE. `complete_tickler` deletes instance (series continues) or pass `delete_series=true` to stop the series. |
| Calendar Access Modes | ignore, read, readwrite (CRUD enforced per mode) |
| Availability Check | `check_availability` — 3 paths: google (server FreeBusy), device (phone CalendarProvider), device_freebusy (phone's Workspace OAuth → Google FreeBusy for same-domain coworkers) |

OAuth flow: Claude calls `get_auth_url` → user visits URL → Google redirects to callback → tokens stored automatically. Dashboard: Calendar settings → Google Account → Reconnect button (calls `/api/auth-url` REST endpoint).

Browser gotcha (Reconnect / onboarding Connect Google): the consent-URL new tab must be opened **synchronously inside the click handler** — Chrome/Safari drop the user-gesture flag across any `await`, so `window.open(auth_url)` called after the server action silently popup-blocks. Current pattern: `window.open('about:blank', '_blank')` at click time, then assign `popup.location.href` once the auth URL returns. Keep this shape if you add more OAuth entry points.

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
- **Canonical index definitions live in `packages/shared/src/indices/`** — the 7 `ll5_awareness_*` indices and `ll5_knowledge_networks` are imported from `@ll5/shared` by gateway, awareness MCP, and personal-knowledge MCP. Do NOT redefine these locally; writing to them through a drifted local mapping is what caused the pre-2026-04-23 `notable_events` invisibility bug (gateway wrote `{place_id, place_name, location, details, timestamp}` while the awareness reader expected `{summary, severity, payload, acknowledged, created_at}` — all gateway arrivals were silently unreadable). Gateway-owned infra indices (`ll5_session_history`, `ll5_app_log`, `ll5_audit_log`) stay in `gateway/src/server.ts`. Awareness-exclusive indices (`ll5_agent_journal`, `ll5_agent_user_model`, `ll5_media`, `ll5_media_links`) stay in `awareness/src/setup/indices.ts`. Personal-knowledge-exclusive indices (profile, places, facts, people, data_gaps) stay in `personal-knowledge/src/setup/indices.ts`.
- **Notable event shape (authoritative):** `{user_id, event_type, summary, severity, payload, acknowledged, acknowledged_at, created_at}`. Writers that need to emit an arrival-style event use `event_type: 'location_change'` with place details inside `payload`.
- `ll5_knowledge_*` — facts, people (with `status`: full/contact-only), places, profile, data_gaps, networks (BSSID→place, shared with gateway wifi processor)
- `ll5_awareness_*` — locations, messages, entity_statuses, calendar_events (synced from Google + phone), notable_events, phone_statuses, wifi_connections
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
- **Typecheck gate (Apr 23)**: every package build runs `tsc --noEmit` before the actual build. Root `tsconfig.json` has `noEmitOnError: true`, so strict TS errors in any package now fail the build instead of silently emitting broken JS. Run `npm run typecheck` locally to check all 11 packages. `gateway/tsconfig.json` excludes `src/**/__tests__/**` (vitest transpiles tests independently); any non-test TS error is a build-blocker.
- Auto-deploy: `appleboy/ssh-action@v1` SSHs to server, `docker login ghcr.io` using `GITHUB_TOKEN`, then `docker compose pull && up -d --remove-orphans`
- Health check: curls mcp-knowledge.noninoni.click/health (4 retries, non-blocking)
- Deploy only runs on main branch (skipped for workflow_dispatch)
- IMPORTANT: deploy pulls only our GHCR images, NOT database/third-party images. A `docker compose pull` would re-pull postgres/ES base images and recreate their containers, causing downtime. To upgrade postgres or ES, do it manually on the server.
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
- Coolify API unreliable for start/restart — use SSH. Specifically: the service *detail* endpoint (`GET /api/v1/services/:uuid`) returns stale `status: exited` while the *list* endpoint (`GET /api/v1/services`) reports live `running:*`. `POST /stop` refuses 400 `"Service is already stopped"` whenever detail is stale. Workaround: hit `POST /start?uuid=…` first to force Coolify to reconcile its state with reality, then `/stop` succeeds. Restarting a single container is cleaner over SSH: `docker restart <container-name>`.
- **Host is shared across projects** — the Coolify host (95.216.23.208 = cp.arnonzamir.co.il) runs ll5 alongside unrelated projects (loanforge/zlf, livewire, sopwith3, etc.). When diagnosing cascading ll5 failures, always check host-level pressure (`df -h`, `docker system df`, sibling project health) before assuming the direct component is the root. The Apr 16 WhatsApp outage was caused by a sibling project's runaway ES, not by any ll5 code. Active-project shortlist check: `docker volume ls | xargs -I{} du -sh /var/lib/docker/volumes/{} 2>/dev/null | sort -h | tail -10`.
- **Prisma pool does not self-heal on DB restart** — services backed by Prisma (Evolution API) hold their pool across Postgres flaps and keep logging `P1001 Can't reach database server` while the DB is back up. Rule of thumb: whenever a Prisma container's `Up Xd` > its Postgres's `Up Yh`, restart the Prisma container.
- **Incident playbook**: (1) `docker ps --format '{{.Names}}\t{{.Status}}' | grep <service>` on the host; (2) compare container uptime to its DB uptime; (3) `df -h` + `docker system df`; (4) `docker logs --tail 100 <container>`; (5) for WhatsApp specifically, call `get_account_status` and inspect `message_count_today` + the ES query `app=whatsapp, from_me=false` rather than trusting Evolution's `connectionState`; (6) restart the narrowest unit that would fix it — container first, service/stack only if needed.
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
- **Migrations now have a ledger (`schema_migrations`)** — each .sql runs exactly once per DB. Migration 000_schema_migrations.sql creates the table; `runMigrations` in `server.ts` inserts on successful apply. On first boot with the ledger in place, if `chat_messages` already exists (pre-ledger deploy), the runner backfills every existing file as "applied" so nothing re-runs. **Rule: once a migration is released and applied to prod, never edit it in place — write a new migration instead**. Also: when a future migration changes a trigger function's return type or language, prefer `DROP FUNCTION IF EXISTS <name>() CASCADE;` (drops attached triggers) then `CREATE FUNCTION ... CREATE TRIGGER ...` rather than `CREATE OR REPLACE FUNCTION` (which 42P13-fails on signature changes).
- **PG has no `ADD CONSTRAINT IF NOT EXISTS`** (as of 16) — historical note. Guard any `ALTER TABLE ADD CONSTRAINT` with a `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '...' AND conrelid = 'tbl'::regclass) THEN ... END IF; END $$;` block. Pre-ledger, this caused a gateway crash loop on Apr 21. With the ledger, this only matters for migrations you edit before first release — but keep the pattern out of muscle memory. Also watch for `CREATE TYPE` (no IF NOT EXISTS — wrap in DO block), `ALTER TYPE ADD VALUE` (same), raw INSERT without ON CONFLICT.
- **Partial-unique indexes + triggers that INSERT are a hidden foot-gun** — migration 020's `UNIQUE INDEX idx_chat_conversations_one_active ON chat_conversations(user_id) WHERE archived_at IS NULL` combined with migration 022's trigger-side `INSERT INTO chat_conversations ... ON CONFLICT (conversation_id) DO UPDATE` silently broke every `insertSystemMessage` caller for 37h. The `ON CONFLICT` key has to cover every constraint the row can collide on, including partial-unique indexes — otherwise 23505 aborts the parent INSERT. Migration 023 fixed it by scoping the trigger's secondary INSERT to channels that genuinely form threads (`web/android/cli`). General rule: when you add a partial-unique index, audit every trigger (and every app-layer INSERT) that can target the same table; add the right `ON CONFLICT` clause or simply don't INSERT that row. `system`-channel messages are ephemeral per-event — they don't belong in chat_conversations.
- **`/admin/health` now surfaces six silent-failure signals**: `services` (MCPs), `channels` (client bridge), `whatsapp`, `phones`, `system_messages` (insertSystemMessage counter), `schedulers` (per-scheduler last_ok_at/last_error_at/consecutive_failures, 3+ = unhealthy), `fcm` (access-token + per-send failures with reasons), `chat_indexer` (PG LISTEN reconnect count + last_error), `webhook` (phone-contact enrichment + calendar cleanup failures). Any non-zero counter on a healthy-looking system means something is rotting invisibly. Summary exposes unhealthy counts at the top level.
- **Active LL5-native conversation routing** — `getOrCreateActiveConversation` in `chat.ts` is the ONLY sanctioned path to resolve/create a user's active conversation. Never INSERT into `chat_conversations` outside this helper — hand-rolled INSERTs race against `idx_chat_conversations_one_active` and miss the archived-writes-grace-window reroute at the POST /messages layer. scheduler system messages use `gen_random_uuid()` per event (ephemeral, not a thread) and the trigger is scoped away from `channel='system'` accordingly.
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
- **Channel MCP liveness**: The stdio bridge at `ll5-run/channel/ll5-channel.mjs` keeps a single SSE connection open to `/chat/listen`. It aborts and reconnects on (a) 60s of idle (no keepalive received), (b) HTTP non-2xx, (c) token refresh. Liveness is written every 15s to `~/.ll5/channel-health.json` (`{connected, last_sse_data_at, idle_ms, reconnect_count, last_error, pid, mcp_probe_at, mcp_probes}`). The `channel_health` MCP tool exposes the same snapshot so Claude can self-diagnose. `unhandledRejection`/`uncaughtException` → `process.exit(1)` so Claude Code's MCP SDK respawns the child. Token refresh is atomic (tmpfile + rename) so the other 6 HTTP MCPs' `headersHelper` readers never see a truncated file.
- **MCP connectivity probe**: `ll5-run/channel/ll5-channel.mjs` runs a streamable-HTTP probe (same code path Claude Code uses) against all 6 remote MCPs 15s after startup and every 10 min. Results are stored in `state.mcp_probes[]` and exposed via the new `check_mcp_connectivity` tool. If any probe fails, a rate-limited (1/hour) system chat message is posted so the agent sees it. The probe is diagnostic only — if it succeeds but `/mcp` still shows failures, the cause is unambiguously Claude-Code-side (typically the 5s startup-handshake race).
- **Launcher hardening for MCP startup race**: `ll5-run/ll5` now `export MCP_TIMEOUT=30000` (Claude Code's default 5s cap races against 6 concurrent TLS+auth+init handshakes and silently fails a random subset) and pre-warms all 6 remote MCP `/health` endpoints in parallel before `exec claude`, so DNS + TLS session caches are hot when the MCP clients spawn.
- **Client-side MCP autoheal**: `ll5-run/scripts/mcp-autoheal.sh` is run every 5 min by launchd (`~/Library/LaunchAgents/com.ll5.mcp-autoheal.plist`). Reads `~/.ll5/channel-health.json`, tracks `consecutive_fail` in `~/.ll5/mcp-autoheal-state.json`, and invokes `reconnect-mcps.sh --apply --relaunch` after 2 consecutive failed probes. Rate-limited to ≤1 relaunch/hour. Logs at `~/.ll5/mcp-autoheal.log`. Manage via `launchctl load|unload|list ~/Library/LaunchAgents/com.ll5.mcp-autoheal.plist`.
- **Generic keystroke helper**: `ll5-run/scripts/type-to-terminal.sh` sends osascript keystrokes to the frontmost Terminal/iTerm tab only if its cwd is under an `--allow DIR` (refuses otherwise, exit 4). Supports `--text`, `--enter`, `--key NAME` (return/up/down/…), `--dry-run`. Used by `reconnect-mcps.sh` for the "type /mcp" recovery path; reusable for any TUI automation scoped to a project directory.
- **MCP status pulse (temporary)**: `packages/gateway/src/scheduler/mcp-status-pulse.ts` sends an FCM notify-level status summary every 2 h during active hours through 2026-04-21 (absolute expiry date, hard-coded), so the user gets regular visibility while the new failsafe monitors stabilise. After the expiry, the scheduler logs and stops on next tick; remove the registration from `scheduler/index.ts` in a follow-up once you're happy with silence-on-healthy.
- **MCP health monitor**: `packages/gateway/src/scheduler/mcp-health-monitor.ts` pings `/health` on all 7 services every 2 min (parallel, 5s timeout each), caches the snapshot in-memory (exported via `getHealthSnapshot()`), and additionally aggregates `ll5_app_log` for the last 15 min to catch "responds 200 but tool calls failing" — alerts when ≥10 calls show >25% error rate. FCM critical push on transition to unhealthy after 2 consecutive failures, FCM notify on recovery. Max 2 alerts per episode per service — counter resets on recovery. Gateway self-URL defaults to `http://127.0.0.1:${PORT ?? 3006}` (Coolify sets `PORT=3000` in prod).
- **Channel liveness monitor**: `packages/gateway/src/scheduler/channel-liveness-monitor.ts` detects the "zombie bridge" mode (channel MCP process alive, SSE hung) by querying `chat_messages` for inbound rows in `status='pending'` older than 5 min. Only alerts during active hours with a 10-min cooldown. This is the last-line defense — the client watchdog may miss it if the MCP process is still running but not delivering.
- **Character refresh**: `packages/gateway/src/scheduler/character-refresh.ts` re-pushes a condensed version of the `ll5-run/CLAUDE.md` "Your Role" section as a system message every 4h during active hours. Long sessions (days) drift off-character because the prompt is only loaded at session start; this is the cheap counter. Configurable via `user_settings.scheduler.character_refresh_hours`. Tag `[Character Refresh]` so the agent recognises it as a persona nudge, not new data. No FCM push.
- **Agent output monitor**: `packages/gateway/src/scheduler/agent-output-monitor.ts` closes a blind spot channel-liveness can't see — the channel MCP happily drains pending rows into `processing` but the agent itself never emits an assistant reply, so pending count is zero and everything looks green. Queries `COUNT(channel='system' inbound)` over `lookbackHours` (default 3h) vs `MAX(created_at) WHERE direction='outbound' AND role='assistant'`. Alerts when the agent has been silent ≥ `silenceHours` (default 2h) AND there were ≥ `minSystemInbound` triggers (default 2) in the window — a genuinely uneventful morning with no scheduler triggers stays quiet. FCM critical, 2-alert cap per episode, 30-min cooldown. Snapshot at `/admin/health.agent_output` + `summary.agent_output_stale`.
- **Client watchdog**: `ll5-run/watchdog/watchdog.sh` reads `~/.ll5/channel-health.json` and enforces two invariants during active hours (07–23 Asia/Jerusalem): (1) main claude session is running in ll5-run workspace (detected via `pgrep -f 'claude .*ll5-channel'`); (2) SSE idle time from the health file is <120s. Violations trigger a single FCM push (via `POST /chat/messages` with `notification_level`) with a 10-min cooldown. Does **not** attempt nohup-launched Claude restarts — that can't attach a TTY, it silently fails and spams the log.
- **WhatsApp flow monitor**: `packages/gateway/src/scheduler/whatsapp-flow-monitor.ts` catches the Evolution API "ghost connected" failure — `state: open` is a lie when the underlying Baileys WhatsApp Web socket has silently desynced. Every 15 min during active hours, queries ES `ll5_awareness_messages` for the last inbound WhatsApp doc (`app=whatsapp, from_me=false`). If there's at least one configured account and the age exceeds 6h, fires an FCM critical. 30-min cooldown, 2 alerts per episode cap. Snapshot exposed via `/admin/health` under `whatsapp[]`. Recovery: call `restart_whatsapp_account` MCP tool or restart the Evolution container in Coolify.
- **Phone liveness monitor**: `packages/gateway/src/scheduler/phone-liveness-monitor.ts` promotes the existing heartbeat string-warning into an actual FCM critical. Every 15 min during active hours, reads the freshest timestamp across `ll5_awareness_locations` + `ll5_awareness_phone_statuses`. If >3h stale, alerts the user to open LL5 on the phone. The `DeviceHeartbeatWorker` on Android pushes phone_status hourly regardless of GPS, so nothing arriving for 3h+ means the notification/location service is dead. 30-min cooldown, 2 alerts per episode cap. Snapshot exposed via `/admin/health` under `phones[]`.
- **`restart_whatsapp_account` MCP tool** (messaging): POSTs `/instance/restart/:name` against Evolution API for a given account. Used manually to recover from ghost-connected sessions. Sets status to `reconnecting`; call `get_account_status` 10–30s later to confirm it reached `open`.
- **`/chat` full-screen view (Apr 20)**: `packages/dashboard/src/app/(user)/chat/page.tsx` is a server component that reads the ll5_token cookie, fetches `/chat/conversations/active` + first 200 messages server-side, and hands them to `ChatRoot` (client). This kills the mount-time waterfall the dashboard tile has. `ChatRoot` installs the chat session (SSE + 15s visibility-gated safety sweep from `hooks/use-chat-store.ts`) once; components read store slices via zustand selectors with `useShallow`. **"Agent answered" validation**: `setThinking(false)` fires inside the SSE `new_message` handler for any non-user non-reaction message, so the "coach is thinking ▍" caret disappears the moment a real assistant message lands. **Conversation lifecycle** (the "latest channel selection / management logic"): handled in-store via `setConv`, which clears state and re-hydrates on new id; plus SSE `conversation_archived` pivots automatically to the new active via `/chat/conversations/active`; plus `sendChatMessage` auto-retries on 409 `conversation_archived` by calling `setConv(active_conversation_id)` and re-invoking itself. Single `ingest(source, msg)` funnel does binary-sorted insertion, id-keyed dedup, status-rank-aware merge (never regresses delivered → pending), and pending-temp promotion in-place to avoid flicker. `MessageBubble` has two variants — `unboxed` (coach-dot gutter, full-prose for `/chat`) and `bubble` (legacy widget). The dashboard tile keeps its own state (plain useState) so it doesn't regress. Warm tokens are additive to the existing palette — no existing component color changes.
- **Auth redirect (Apr 19)**: Web does the "no cookie → /login" redirect in `src/middleware.ts` now; that catches `(admin)/*` routes which had no layout-level check and would server-error for anonymous visits. Login `actions.ts` reads `formData.next` (hidden input populated from `?next=`), validates it starts with `/` and not `//` (open-redirect guard), and redirects there on success — falls back to `/dashboard`. `useSearchParams` in the login form requires a `<Suspense>` boundary (Next 15 SSG bailout) — `page.tsx` wraps the form accordingly. Android: `SettingsRepository.isAuthenticated: StateFlow<Boolean>` is seeded from the encrypted-prefs token on first access and updated in-place by `setAuthToken`. `AppNavigation` collects it and replaces the tabbed nav with `SettingsScreen` alone when false — this is cleaner than per-screen "not logged in" placeholders because the other tabs can't even be reached. `AuthGateViewModel` is a thin Hilt wrapper so the composable can get at the repo without plumbing it through every call site.
- **Unified conversations Android (Apr 19)**: ll5-android commit c413c10. `ChatApi` adds 3 endpoints; `ChatRepository.sendMessage` returns a structured `ChatSendResponse` for 409s (not an exception) so the ViewModel can pivot. ViewModel's `loadConversation` asks the server for the active id — DataStore is kept only as an offline fallback and is overwritten to match on each successful fetch. The user-facing "+" button is repurposed: instead of clearing state locally it opens the new-conversation dialog which posts to the server. Reaction rows flow through SSE like any other message but the renderer folds them under their parent via `replyToId`. Compact rendering uses Material Icons (`Schedule`/`Notifications`/`Build`/`Inventory2`) chosen by content heuristic. FCM service still opens MainActivity with no deep-link extras (conversation/message-id deep linking is a follow-up once server includes them in FCM payload). No swipe-to-reply gesture — long-press action sheet covers it; swipe is a follow-up.
- **Unified conversations dashboard UI (Apr 19)**: `packages/dashboard/src/components/chat-widget.tsx` rewrite + new `chat-sidebar.tsx`. Mount loads server's active convo via `/api/chat/conversations/active`; SSE subscribes to both `chat_messages` and `chat_conversations` channels. 409 handling: when POST `/api/chat/messages` returns `conversation_archived`, the widget pivots to `active_conversation_id` automatically (no user-visible retry). 201 response may include `conversation_id` differing from the requested one (30s grace reroute) — widget updates local `convId` to match. Reactions posted via `PATCH /api/chat/messages/:id` with `{reaction}`; removal via `{reaction: null}`. Reaction rows are detected client-side (reaction + reply_to_id set) and hoisted out of the main message stream into a strip under their parent bubble — they never render as their own bubble. Compact rows (`display_compact=true`) are folded into a "▾ N system events" collapsible band if consecutive entries fall within 60s. Conversation-summary seed messages render with an amber accent (distinguished via `metadata.kind === 'conversation_summary'`). API proxies are generic pass-throughs — adding backend fields to the gateway's payload surfaces automatically in the UI; only new route paths need a proxy file.
- **`list_people` cap (May 3)**: Zod max raised 200 → 5000 in `personal-knowledge/src/tools/people.ts`. The dashboard's contacts page needs the full set to categorize contacts correctly (the prior cap caused People↔Contacts flapping for users with >200 KB people). Other tools (`list_facts`, `list_places`, `list_data_gaps`) still cap at 200; only people was raised because that's the only set used as a *complete* discriminator on the dashboard.
- **/settings/contacts categorization (May 3)**: tab counts use filtered values across all 3 tabs (People/Contacts/Groups) — searching narrows every count consistently. Group/contact split in `fetchContactsForTab()` excludes any `platform_id` ending in `@g.us` (WhatsApp) or starting with `-` (Telegram) from Contacts even if the `messaging_contacts.is_group` column is wrong. `list_people` everywhere on this page raised from `limit:200` → `limit:5000` — the prior cap caused contacts linked to KB people #201+ to fail the `fullPersonIds.has()` discriminator and "jump" between People and Contacts on refresh.
- **WhatsApp message ES shape (May 3)**: every WhatsApp message indexed into `ll5_awareness_messages` now carries `conversation_id` (= remoteJid) and `conversation_name` (= resolved name → groupName fallback). `awareness.query_im_messages` returned nulls for these fields before; old rows still do (no backfill). Phone-pushed IM rows still won't carry JID-level conversation_id — phone payload doesn't include it. The `MessageBatchReviewScheduler` clusters by sender|app|conversation, includes group name + first/last snippet per cluster in its system message, and points the agent at `read_messages` for full thread fetch.
- **Authority/Delivery toggle UX (May 3)**: in `/settings/contacts` each toggle button now displays a column-specific label so the same DB value never reads identically across columns: Authority shows Blocked/Read/Reply; Delivery shows Drop/Batch/Notify (`Auto` was dropped — see tech debt). Coupled-bump rule: when both columns are `ignore` and the user clicks one off ignore, the other bumps to its first non-ignore level (permission→input, routing→batch) via a second `upsertContactSetting` call from the Row's onChange. Legacy rows with `routing='agent'` are normalized to `'immediate'` at display time via `displayRouting()`.
- **Authority vs Delivery (May 3)**: `/settings/contacts` columns now read "Authority" (= `contact_settings.permission`) and "Delivery" (= `contact_settings.routing`). The read-gate enforcement in `packages/messaging/src/utils/permission-checker.ts:getConversationPriority` now queries `contact_settings.permission` first via a join through `messaging_contacts` (groups match on platform_id JID; 1:1 matches via messaging_contacts.person_id → contact_settings.target_id with target_type='person'), falling back to legacy `notification_rules.priority` for unmigrated rows. The Authority column in the UI is now actually enforced. Routing already read contact_settings first via NotificationRuleMatcher.
- **NOTIFY metadata.kind (May 3, mig 024)**: the `notify_chat_message` trigger now projects a small `metadata` object onto the SSE payload — currently just `kind`. Add new fields to the `meta_proj` builder when a new client use appears. Keeps payload well under the 8KB NOTIFY limit while letting clients render kind-specific styles (e.g. ThinkingRow) the moment a row lands, instead of waiting for the safety-poll sweep.
- **Internal-voice channel (May 3)**: agent calls the `narrate` tool on the channel MCP to share what it's currently thinking/doing. Writes a chat row with `display_compact=true` and `metadata.kind="thinking"`. Web's `CompactRow` (in both `chat/message-bubble.tsx` and `chat-widget.tsx`) and android's `ThinkingRow` (in `ChatScreen.kt`) detect this kind and render asterisk-prefixed italic dim lines — Claude Code style, not bubbles. Android collapses to 2 lines with tap-to-expand. No FCM. Pure visual side-channel. CLAUDE.md (channel MCP repo) explains when to narrate vs reply vs push_to_user.
- **Unified conversations (Apr 19)**: web/android/cli share ONE active LL5-native conversation per user. External messengers (WhatsApp/Telegram) keep per-`remote_jid` conversations. Active invariant enforced at the DB level by `CREATE UNIQUE INDEX ... WHERE archived_at IS NULL`. `getOrCreateActiveConversation` handles the 23505 race on concurrent `/new` by re-selecting. `push_to_user` drops channel resolution entirely — gateway routes the `web`-channel outbound POST into the active conv. Archive/switch race: writes to a conversation archived <30s ago reroute to the new active (response includes `rerouted_from`); >30s returns `409 conversation_archived` with `active_conversation_id` so the client retries. Never silently drop. Reactions stored as dedicated rows with `content IS NULL`, `reaction` ∈ {`acknowledge`,`reject`,`agree`,`disagree`,`confused`,`thinking`}, `reply_to_id` set; rendering maps semantic names to Lucide icons client-side (swap icon pack without migration). XOR CHECK constraint enforces `(reaction IS NULL) <> (content IS NULL)`. `display_compact` column controls compact system-row rendering orthogonally to `role` (so `role='agent' display_compact=true` = tool echo; `role='system' display_compact=false` = escalation bubble). Search is ES-first via `ChatSearchIndexer` cluster-wide scheduler (tails NOTIFY on both `chat_messages` and `chat_conversations` channels, indexes into `ll5_chat_messages`/`ll5_chat_conversations` with multilingual analyzer for Hebrew), falls back to ILIKE on the user's last 500 conversations if ES throws. Channel MCP passes `reply_to_id`, `reaction`, `display_compact` through SSE meta; `conversation_archived`/`conversation_created` lifecycle events surface as compact notifications so Claude can journal the switch without ingesting a full bubble.











