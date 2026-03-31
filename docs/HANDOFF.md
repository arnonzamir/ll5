# LL5 Handoff

Everything needed to continue working on the LL5 personal assistant system.

---

## Architecture

Claude Code is the agent. 5 MCP servers are the data layer. Gateway handles webhooks and chat. Dashboard is the web UI.

```
Claude Code (ll5-run workspace)
  ├── personal-knowledge MCP (ES) — facts, people, places, profile, data gaps
  ├── gtd MCP (PG) — actions, projects, horizons, inbox, shopping, chat tools
  ├── awareness MCP (ES) — GPS, IM, entity statuses, calendar, situation
  ├── calendar MCP (PG+ES) — Unified timeline (Google+phone+tickler), Gmail, OAuth
  └── messaging MCP (PG) — WhatsApp, Telegram [not deployed]

Gateway (Express)
  ├── POST /webhook/:token — phone push data (GPS, IM, calendar)
  ├── POST /auth/token — PIN login, returns signed token
  ├── /chat/* — message queue REST endpoints
  ├── GET /chat/listen — SSE for real-time notifications (PG LISTEN/NOTIFY)
  ├── /commands/* — device command queue (queue, pending, confirm)
  ├── Schedulers — calendar sync (30min), calendar review (2h), daily briefing (7am),
      tickler alerts (1h), GTD health (4h), weekly review (Fri 14:00), message batch (30min)
  └── System message dedup — checks PG for recent duplicate before inserting

Dashboard (Next.js 15)
  ├── /login — user_id + PIN auth (all pages redirect here if unauthenticated)
  ├── Nav: display name from profile, grouped menus (Organize, People & Places, Data), profile dropdown with logout
  ├── Build ID in footer (left-aligned, black)
  ├── Dashboard + calendar use local timezone (not UTC) for all date calculations
  ├── /dashboard — GTD status + chat panel (50/50)
  ├── /actions, /projects, /inbox, /shopping — GTD pages
  ├── /calendar — day/week view, hover tooltips, click details with source, holiday banner, settings
  ├── /phone-data — review phone-pushed data (locations, messages, calendar) with type/time filters
  ├── /settings/notifications — People (Family/Friends/Work/Other) + Keywords tabs, 3 priority levels
  ├── /locations — Leaflet map with clustering, timeline, trail
  ├── /people, /places, /knowledge, /horizons — personal knowledge pages
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

## Google OAuth

| Item | Value |
|------|-------|
| Client ID | Set in Coolify env `GOOGLE_CLIENT_ID` |
| Client Secret | Set in Coolify env `GOOGLE_CLIENT_SECRET` |
| Redirect URI | `https://mcp-google.noninoni.click/oauth/callback` |
| Encryption Key | Set in Coolify env `ENCRYPTION_KEY` (generate with `openssl rand -hex 32`) |
| Scopes | calendar.readonly, calendar.events, gmail.readonly, gmail.send |
| Timezone | Per-user via `set_timezone` tool, stored in `google_user_settings` table (default: Asia/Jerusalem) |
| Tickler Calendar | "LL5 System" (role=tickler). Defaults to 08:00, pass due_time="all_day" for all-day |
| Calendar Access Modes | ignore, read, readwrite (CRUD enforced per mode) |
| Availability Check | `check_availability` tool — FreeBusy API + device fallback via CalendarProvider for non-sharing accounts |

OAuth flow: Claude calls `get_auth_url` → user visits URL → Google redirects to callback → tokens stored automatically.

Google MCP accepts both ll5 signed tokens (same as other MCPs) and legacy API key. Set `AUTH_SECRET` env var for token auth. Server blocks MCP OAuth discovery (returns 404 JSON for /.well-known/* and /register).

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

**Elasticsearch** (8.15.0, 10 indices):
- `ll5_knowledge_*` — facts, people, places, profile, data_gaps
- `ll5_awareness_*` — locations, messages, entity_statuses, calendar_events (synced from Google + phone), notable_events
- `ll5_app_log` — all tool calls, webhooks, errors (service, level, action, tool_name, duration_ms)
- `ll5_audit_log` — all mutations across MCPs
- Note: calendar index has text-mapped calendar_id (use .keyword subfield for term queries)
- Calendar push accepts date-only strings and null values (Android Moshi sends explicit null, not undefined)

## CI/CD

- GitHub Actions: `.github/workflows/build-and-push.yml`
- Builds all packages on push to main, pushes to GHCR
- Deploy step: SSH to server, `docker compose pull && up -d`
- Deploy needs `DEPLOY_SSH_KEY` + `COOLIFY_SERVICE_UUID` in GitHub secrets + `SERVER_HOST` variable

## How to Deploy

```bash
git push  # triggers CI build
# Wait ~3 min for build
ssh -i ~/.ssh/id_ed25519 root@95.216.23.208
cd /data/coolify/services/xkkcc0g4o48kkcows8488so4
docker compose pull && docker compose up -d
```

## How to Run Locally

```bash
cd ~/workspace/ll5-run
./ll5  # starts listener + Claude with greeting
```

## Key Lessons Learned

See docs/implementation/deployment-log.md for full details:
- Coolify API unreliable for start/restart — use SSH
- Docker DNS shadows service names when on multiple networks — use full container names
- PG POSTGRES_PASSWORD only used at first init — ALTER ROLE for changes
- ES versions not backwards-compatible — can't downgrade with existing data
- MCP StreamableHTTP needs per-request server+transport pair
- FileChanged hook doesn't reliably wake Claude — Channel MCP is the working solution
- Gateway is ESM — never use `require()` for node builtins; use static `import` instead
