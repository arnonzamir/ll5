# LL5 per-tenant agent runtime image (`ll5-agent-tenant`)

The image the **agent-orchestrator** runs, one container per tenant, for the
BYO-agent platform (see `docs/design/byo-agent-tenant-platform.md`).

## Why a separate image
The existing `ghcr.io/arnonzamir/ll5-agent:latest` runs the single admin agent
and is left **completely untouched** — this image is built *FROM* it and only
overrides the entrypoint. Your running deployment stays on the existing image
until you choose to cut over; that cutover is intentionally a manual decision.

## What differs from the base image (only 3 things)
1. Creds come from a mounted **`0600` env-file** at `$LL5_AGENT_ENV_FILE`
   (default `/run/ll5/agent.env`) — never `-e`/argv, so they're invisible to
   `ps` / `docker inspect`.
2. The LL5 token is the **orchestrator-issued agent token** (`LL5_AGENT_TOKEN`),
   written straight to `~/.ll5/token` — no username/PIN login.
3. Claude authenticates with the tenant's **`ANTHROPIC_API_KEY`** (BYO LLM),
   not a subscription token.
Plus a heartbeat loop → `POST /me/agent/heartbeat`.

Everything else — workspace, persona (`CLAUDE.md`), skills, hooks, the
`ll5-server` supervisor, the `ll5-channel` MCP, `mcp-autoheal`, the static
`.mcp.server.json` (MCP auth is dynamic via `get-mcp-auth.sh` → `~/.ll5/token`)
— is inherited unchanged.

## Env-file contract (written by the orchestrator, 0600, mounted read-only)
```
LL5_USER_ID=<tenant uuid>
LL5_AGENT_TOKEN=<ll5.* agent token>
ANTHROPIC_API_KEY=<sk-ant-...>
LL5_GATEWAY_URL=https://gateway.noninoni.click
MCP_BASE_DOMAIN=noninoni.click
```

## Build
```bash
# from repo root; needs GHCR login to pull the base + push the new tag
docker build -f docker/agent-runtime/Dockerfile.agent-tenant \
  --build-arg BASE_IMAGE=ghcr.io/arnonzamir/ll5-agent:latest \
  -t ghcr.io/arnonzamir/ll5-agent-tenant:latest .
docker push ghcr.io/arnonzamir/ll5-agent-tenant:latest
```
Or run the manual GitHub Action **build-agent-tenant** (`workflow_dispatch`).

## Verify before cutover (your reserved step)
1. Mint a test tenant + agent token + set its `ANTHROPIC_API_KEY` (a throwaway
   user via `/admin/invites` → onboard → `/settings/agent`).
2. Write a test env-file and run locally on the agent host:
   ```bash
   printf 'LL5_USER_ID=%s\nLL5_AGENT_TOKEN=%s\nANTHROPIC_API_KEY=%s\nLL5_GATEWAY_URL=https://gateway.noninoni.click\nMCP_BASE_DOMAIN=noninoni.click\n' \
     "$UID" "$TOKEN" "$KEY" > /run/ll5/test.env && chmod 600 /run/ll5/test.env
   docker run --rm -v /run/ll5/test.env:/run/ll5/agent.env:ro \
     -e LL5_AGENT_ENV_FILE=/run/ll5/agent.env \
     ghcr.io/arnonzamir/ll5-agent-tenant:latest
   ```
3. Confirm: token written, the 6 MCPs connect (`mcp-autoheal` log clean), the
   agent appears in `/admin/tenants` as **running** (heartbeat landing), and it
   responds in that tenant's chat thread. Confirm `ps`/`docker inspect` do NOT
   show the key.
4. Only then point production at it (the orchestrator's `AGENT_IMAGE` already
   defaults to `ghcr.io/arnonzamir/ll5-agent-tenant:latest`), and — if you want
   the admin agent under the orchestrator too — provision "tenant 0" and retire
   the standalone admin app at your discretion.

## Notes
- `MCP_BASE_DOMAIN` other than `noninoni.click` would need the `.mcp.server.json`
  hostnames regenerated; the default matches today's deployment.
- claude CLI here uses `ANTHROPIC_API_KEY`. If a tenant instead supplies a
  subscription `setup-token` in the future (backend already supports the
  `oauth_setup_token` kind), the entrypoint would export
  `CLAUDE_CODE_OAUTH_TOKEN` instead — gated by the ToS posture.
