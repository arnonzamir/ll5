# opencode Variant Deployment

History, architecture, issues, and repeatable deployment procedure for the opencode agent runtime variant of LL5.

## Overview

Two interchangeable agent runtime variants power LL5:
- **Claude Code** — `arnonzamir/ll5-run-claude-code` (legacy)
- **opencode** — `arnonzamir/ll5-run-opencode` (current)

The opencode variant replaces Claude Code's proprietary runtime with the open-source [opencode](https://opencode.ai) server, using DeepSeek v4 Flash Free as the LLM provider. Shared content (persona, skills, prompts, MCP endpoints) lives in `packages/ll5-run-shared/` in the main ll5 repo.

## Architecture

```
User (Android / Web / WhatsApp)
         │
         ▼
  ┌─────────────┐     ┌──────────────────┐
  │   Gateway    │────▶│  agent-trigger   │
  │  (Express)   │     │  (POST /session  │
  │              │     │   /:id/prompt    │
  └─────────────┘     │   _async)         │
         │            └────────┬─────────┘
         │                     │
         │            ┌────────▼─────────┐
         │            │  opencode serve   │──▶ DeepSeek v4 Flash
         │            │  (port 4096)      │    (Zen API)
         │            └────────┬─────────┘
         │                     │
         │            ┌────────▼─────────┐
         │            │  correlation-id   │
         │            │  proxy (port 4097)│
         │            └────────┬─────────┘
         │                     │
         ▼                     ▼
   ┌──────────────────────────────────────┐
   │  6 MCP servers (ES/PG data layer)    │
   │  personal-knowledge, gtd, awareness, │
   │  google, messaging, health           │
   └──────────────────────────────────────┘
```

### Key differences from Claude Code variant

| Aspect | Claude Code | opencode |
|--------|-------------|----------|
| **Runtime** | Claude Code CLI (`claude -p`) | `opencode serve` (HTTP API) |
| **LLM** | Anthropic Claude | DeepSeek v4 Flash Free (via Zen API) |
| **Agent trigger** | Subprocess via `claude -p` | HTTP POST to `/session/:id/prompt_async` |
| **Plugin model** | Shell/Python hooks (PreToolUse, Stop, etc.) | TypeScript plugins via `@opencode-ai/plugin` SDK |
| **Workers** | `claude -p` subprocess with restricted config | SDK-based `client.session.create()/prompt()` |
| **Auth** | SSH-tunneled to gateway-client container | Native token auth via `LL5_TOKEN` |
| **Model cost** | Per-token Anthropic billing | Free (Zen API tier) |

## Repositories

| Repo | Contents | CI |
|------|----------|----|
| `arnonzamir/ll5` | Dockerfile, compose, gateway integration | Full stack CI (all MCPs + gateway + dashboard) |
| `arnonzamir/ll5-run-opencode` | Dockerfile, plugins (18 TS files), 7 worker scripts, opencode.json, entrypoint | `build-and-push.yml` → `ghcr.io/arnonzamir/ll5-run-opencode:latest` |

The `ll5-run-opencode` repo is self-contained — its Dockerfile builds an image with all plugins, workers, and config baked in. The main ll5 repo's `docker-compose.prod.yml` references the image via `ghcr.io/arnonzamir/ll5-run-${AGENT_VARIANT:-claude}:latest`.

## Deployment Procedure

### Prerequisites

- `AGENT_VARIANT=opencode` set in Coolify service env (or host `.env`)
- `OPENCODE_ZEN_API_KEY` set to a valid Zen API key
- `AUTH_SECRET` set (shared with gateway for token generation)
- `LL5_TOKEN` set (pre-minted `ll5.*` bearer token)

### Steps

1. **Build and push the variant image** (automatic via CI on push to `arnonzamir/ll5-run-opencode` main):
   ```sh
   git push origin main
   ```
   CI workflow: `.github/workflows/build-and-push.yml` in the variant repo.

2. **Deploy the main stack** (automatic via CI on push to `arnonzamir/ll5` main):
   ```sh
   git push origin main
   ```
   CI scp's `docker/docker-compose.prod.yml` to the host and triggers a Coolify deploy.

3. **Manual rollback** (switch to Claude Code variant):
   - Set `AGENT_VARIANT=claude` in Coolify env
   - Redeploy via `git push` to main

### Hot-redeploy (without CI)

If CI is unavailable or you need a quick container restart:

```sh
ssh root@95.216.23.208
docker compose -f /data/coolify/services/<uuid>/docker-compose.yml pull agent
docker compose -f /data/coolify/services/<uuid>/docker-compose.yml up -d agent
```

## Image Details

Base: `node:20-slim`.

Installed in image (Dockerfile):
- `opencode-ai@1.17.15` (global npm install)
- `tsx` (global — runs `.ts` scripts directly)
- `wget`, `ca-certificates`, `curl` (system packages)
- `@opencode-ai/sdk@1.17.15` (workspace npm install for worker scripts)
- Plugin deps in `.opencode/node_modules`

Baked into image:
- `opencode.json` — full config with 18 plugins, 6 MCP servers, 3 agents
- `scripts/` — 7 worker scripts (narrative-loop, reconcile-loop, continuity-probe, generate-token, register-session, correlation-id-proxy, session-backup, autoheal)
- `.opencode/plugins/` — 18 TypeScript plugin files
- `.opencode/lib/helpers.js` — shared `gw()` helper for gateway HTTP calls
- `docker-entrypoint.sh` — orchestrates all startup tasks

## Container Startup Sequence (`docker-entrypoint.sh`)

1. **Configure auth** — writes `~/.local/share/opencode/auth.json` from `OPENCODE_ZEN_API_KEY`
2. **Generate token** — uses `LL5_TOKEN` from env (or generates from `AUTH_SECRET`)
3. **Clean stale config** — removes old `opencode.jsonc` from home dir, symlinks config
4. **Set NODE_PATH** — adds `/workspace/node_modules` for SDK resolution
5. **Start correlation-id proxy** — `scripts/correlation-id-proxy.ts` on port 4097
6. **Start opencode server** — `opencode serve --port 4096 --print-logs`
7. **Register main session** — creates a session via SDK, POSTs to gateway
8. **Start worker loops** — reconcile, narrative, continuity-probe (hourly cadence)
9. **Start session backup** — every 5 min, posts session data to gateway `/sessions`
10. **Autoheal** — restart if container healthcheck fails

## Issues Encountered & Resolved

### 1. CI workflow: wrong repo reference (2026-07-08)

**Problem:** Main ll5 CI's `build-and-push.yml` referenced `arnonzamir/ll5-run-opencode-code` (wrong name). The variant repo had been renamed.

**Fix:** Changed to `arnonzamir/ll5-run-opencode` conditional mapping.

### 2. Container startup blocked by model name mismatch (2026-07-08)

**Problem:** opencode.json referenced `anthropic/claude-sonnet-4-20250514` as the model, but the opendcode variant uses DeepSeek via Zen API. Workers and web chat calls failed with `ProviderModelNotFoundError`.

**Fix:** Changed all model references to `opencode/deepseek-v4-flash-free` in both `opencode.json` and the gateway's `agent-trigger.ts`.

### 3. Session registration: SQL type inference (2026-07-08)

**Problem:** The gateway's `INSERT INTO agent_sessions` used `$2` as both a column value and a `jsonb_build_object` argument, causing a PostgreSQL "type inference" error.

**Fix:** Added explicit `::text` casts to the SQL.

### 4. `@opencode-ai/sdk` not resolved for worker scripts (2026-07-09)

**Problem:** The Dockerfile only ran `npm install --production` inside `.opencode/` (plugin deps). Worker scripts in `scripts/` imported from `@opencode-ai/sdk` (which is a workspace dependency in `package.json`) but `/workspace/node_modules` didn't exist.

**Fix:** Added `npm install` at the workspace root in the Dockerfile before the `.opencode` install.

### 5. Stale workspace volume shadows new image content (2026-07-09)

**Problem:** The docker-compose mounted a persistent volume `xkkcc0g4o48kkcows8488so4_agent-workspace-opencode` at `/workspace`. When the image was updated with new plugin/script files, the old files on the volume persisted and shadowed the new ones.

**Fix:** Removed the workspace volume mount from `docker-compose.prod.yml` (only `agent-home:/data/home` remains). Deleted the stale volume on the host after stopping the container.

### 6. `wget` hangs on keepalive connections in entrypoint (2026-07-09)

**Problem:** The entrypoint used `wget -qO-` to probe the opencode health endpoint. The opencode server uses HTTP keepalive, so wget downloaded the HTML page but never exited — blocking the entire startup sequence.

**Fix:** Replaced all `wget` calls in the entrypoint with `curl --max-time 5` which properly exits after receiving the response body.

### 7. Missing `channel` field in gateway POST body (2026-07-09)

**Problem:** Both `ll5-channel.ts` (push_to_user/narrate tools) and `stop-mirror.ts` (session.idle backstop) called `gw("/chat/messages", { text, ... })` without `channel`, `content`, `direction`, or `role` fields. The gateway requires `channel` and `content`.

**Fix:** Updated all calls to match the Claude Code variant's gateway contract:
- `channel: "web"` (or `"cli"` for stop-mirror)
- `content: text` (not `text: args.text`)
- `direction: "outbound"`, `role: "assistant"`
- `notification_level` for push_to_user
- `idempotency_key` for dedup

## Troubleshooting

### Worker scripts fail with `ERR_MODULE_NOT_FOUND`

```log
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@opencode-ai/sdk'
```

**Cause:** `/workspace/node_modules` doesn't exist (SDK not installed at workspace root).

**Fix:** Rebuild image with `docker-entrypoint.sh` that includes `npm install` at root, or manually:
```sh
docker exec agent npm --prefix /workspace install
```

### `stop-mirror.ts` fails with `400 Missing required field: channel`

**Cause:** The plugin POSTs to `/chat/messages` without a `channel` field.

**Fix:** Ensure the deployed image has the latest `stop-mirror.ts` (commit `80b2729` or later). If the workspace volume persists, delete it and recreate.

### Container runs but healthcheck fails

**Cause:** The Docker HEALTHCHECK uses `/workspace/healthcheck.sh` which is written by the entrypoint. If the entrypoint hasn't completed (e.g., stuck on wget), the healthcheck script doesn't exist or fails.

**Fix:** Use `curl` instead of `wget` in the entrypoint. Restart the container.

### `/workspace` files are stale (old image content visible)

**Cause:** A persistent Docker volume `xkkcc0g4o48kkcows8488so4_agent-workspace-opencode` is mounted at `/workspace`, shadowing the image's files.

**Fix:**
```sh
docker compose stop agent
docker volume rm xkkcc0g4o48kkcows8488so4_agent-workspace-opencode
docker compose up -d agent
```

## Known Gaps vs Claude Code Variant

The opencode variant is functional but has these gaps compared to the Claude Code variant:

| Feature | Status | Priority |
|---------|--------|----------|
| `reply` tool (separate from `push_to_user`, supports `conversation_id`, marks delivered) | Missing | High |
| `stop-mirror` posts with `channel: "cli"` + `idempotency_key` (matches Claude variant contract) | Missing | High |
| `narrate` metadata `kind: "thinking"` (sends `"note"` instead) | Needs fix | Medium |
| `POST /today-card` — phone Today card | Missing | Medium |
| `POST /tray-items` — phone decision tray items | Missing | Medium |
| `POST /chat/upload` — image upload | Missing | Medium |
| Narration watchdog gateway POST ("Still working..." message) | Missing | Low |
| MCP probe failure notification | Missing | Low |
| Tool telemetry (`POST /telemetry/tool-result`) | Missing | Low |
| SSE listener for inbound messages | Not needed (opencode native events) | Won't fix |

## Related Files

| File | Purpose |
|------|---------|
| `docs/implementation/impl-opencode-variant.md` | Original implementation plan (2246 lines) |
| `docs/implementation/dual-run-variant-plan.md` | Parent plan for dual-variant migration |
| `docs/implementation/dual-run-MASTER-INDEX.md` | Master index of all implementation plans |
| `docs/implementation/impl-docker-cicd.md` | Docker + CI/CD implementation |
| `docs/implementation/verification-recheck-*.md` | Verification reports against the plan |
| `docs/PROGRESS.md` | Current progress and known issues |
| `docs/HANDOFF.md` | Server details, auth, deploy procedures |
