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
  ├── google MCP (PG) — Calendar, Gmail, OAuth [not deployed]
  └── messaging MCP (PG) — WhatsApp, Telegram [not deployed]

Gateway (Express)
  ├── POST /webhook/:token — phone push data (GPS, IM, calendar)
  ├── POST /auth/token — PIN login, returns signed token
  ├── /chat/* — message queue REST endpoints
  └── GET /chat/listen — SSE for real-time notifications (PG LISTEN/NOTIFY)

Dashboard (Next.js 15)
  ├── /login — user_id + PIN auth
  ├── /dashboard — GTD status + chat panel (50/50)
  ├── /actions, /projects, /inbox, /shopping — GTD pages
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

## Databases

**PostgreSQL** (ll5 database, user: ll5, password: changeme123):
- `gtd_horizons` — unified GTD h=0-5
- `gtd_inbox` — captured items
- `gtd_review_sessions` — review tracking
- `auth_users` — user accounts with PIN hash and role
- `chat_messages` — message queue with status lifecycle
- `notify_chat_message` — PG trigger for LISTEN/NOTIFY on new inbound messages

**Elasticsearch** (8.15.0, 10 indices):
- `ll5_knowledge_*` — facts, people, places, profile, data_gaps
- `ll5_awareness_*` — locations, messages, entity_statuses, calendar_events, notable_events

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
- FileChanged hook doesn't reliably wake Claude — use asyncRewake on Stop hook
