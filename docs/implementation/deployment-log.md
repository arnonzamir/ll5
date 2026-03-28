# Deployment Log

What was deployed, where, how, and the gotchas we hit.

---

## Infrastructure

**Server:** `95.216.23.208` (Coolify host — resolves as `cp.arnonzamir.co.il`)
**SSH:** `ssh -i ~/.ssh/id_ed25519 root@95.216.23.208`
**Coolify API:** `https://cp.arnonzamir.co.il/api/v1/` with token `eZRQh5pdR1WUKFLEYaNjgxI8nmnpH1QlW0iHz9cK52994642`
**Domain:** `noninoni.click` (wildcard DNS via Cloudflare)

## Coolify Resources

| Resource | UUID |
|----------|------|
| Project (ll5) | `h48ssk80ko0sgscs0g0ws04o` |
| Environment (production) | `wc088wc4c0g4gokowckwc084` |
| Service (ll5) | `xkkcc0g4o48kkcows8488so4` |

Service compose is at: `/data/coolify/services/xkkcc0g4o48kkcows8488so4/docker-compose.yml`

## Running Services

| Service | Container Name | Image | Status |
|---------|---------------|-------|--------|
| Elasticsearch 8.15.0 | `elasticsearch-xkkcc0g4o48kkcows8488so4` | `elasticsearch:8.15.0` | Healthy |
| PostgreSQL 16 | `postgres-xkkcc0g4o48kkcows8488so4` | `postgres:16-alpine` | Healthy |
| personal-knowledge MCP | `personal-knowledge-xkkcc0g4o48kkcows8488so4` | `ghcr.io/arnonzamir/ll5-personal-knowledge:latest` | Healthy |
| gtd MCP | `gtd-xkkcc0g4o48kkcows8488so4` | `ghcr.io/arnonzamir/ll5-gtd:latest` | Healthy |

## URLs

| Endpoint | URL |
|----------|-----|
| personal-knowledge health | https://mcp-knowledge.noninoni.click/health |
| personal-knowledge MCP | https://mcp-knowledge.noninoni.click/mcp |
| gtd health | https://mcp-gtd.noninoni.click/health |
| gtd MCP | https://mcp-gtd.noninoni.click/mcp |

## Credentials

| Credential | Value |
|-----------|-------|
| MCP API Key | `8e5539dfe47e57fa65f841aeca4577db153b60bf162426b6` |
| User ID | `f08f46b3-0a9c-41ae-9e6a-294c697424e4` |
| PG User | `ll5` |
| PG Password | `changeme123` |
| PG Database | `ll5` |

## Client Configuration

The `ll5-run` workspace at `/Users/arnon/workspace/ll5-run` is configured to connect to both MCPs. Run `cd ~/workspace/ll5-run && claude` to use it.

MCP settings in `.claude/settings.json` use `streamable-http` transport with Bearer auth.

## Lessons Learned

### 1. Coolify API is unreliable for start/restart

The Coolify API `POST /services/{uuid}/start` and `/restart` endpoints queue requests that often never execute. The lf project already discovered this. **Always use SSH + `docker compose` for deployments.** The API is fine for creating resources and reading status.

### 2. Docker DNS resolution with multiple networks

When a container is on multiple Docker networks (e.g., both the service network `xkkcc...` and the `coolify` network), DNS resolution can return the wrong IP. The `coolify` network may shadow service names with stale entries.

**Fix:** Use the full container name (e.g., `postgres-xkkcc0g4o48kkcows8488so4`) instead of the service name (`postgres`) in connection strings. This resolves unambiguously.

### 3. PostgreSQL POSTGRES_PASSWORD is only used at first init

The `POSTGRES_PASSWORD` environment variable is read by the PG Docker entrypoint only when the data volume is empty (first boot). Changing it in the compose and restarting does NOT change the password. You must either:
- `ALTER USER ... WITH PASSWORD '...'` inside PG, or
- Delete the volume and reinit (`docker compose down -v && docker compose up -d`)

### 4. Elasticsearch version compatibility

ES data directories are not backwards-compatible. ES 8.17.0 writes Lucene 912 codec data that ES 8.15.0 cannot read. If you downgrade the ES image, you must wipe the data volume.

We use ES 8.15.0 because it was already cached on the server (used by the zlf project).

### 5. MCP StreamableHTTP transport requires per-request server instances

The MCP SDK's `StreamableHTTPServerTransport` in stateless mode (sessionIdGenerator: undefined) requires a fresh `McpServer` + `Transport` pair per request. Calling `mcpServer.connect(transport)` a second time on the same server throws "Already connected to a transport."

### 6. Traefik routing requires the coolify network

Coolify's Traefik proxy routes to containers on the `coolify` Docker network. Containers on other networks (like the service's internal network) are invisible to Traefik. Add the coolify network to services that need external access:

```yaml
networks:
  xkkcc0g4o48kkcows8488so4: null  # internal service network
  coolify: null                     # Traefik routing
```

And declare it at the bottom:
```yaml
networks:
  coolify:
    name: coolify
    external: true
```

### 7. Health check start_period matters

ES needs 45-120s to start. PG needs 15-30s for first init. Set appropriate `start_period` values or services with `depends_on: condition: service_healthy` will fail immediately.

### 8. GHCR images from private repos need auth

GitHub Container Registry images from private repos require `docker login ghcr.io`. Either make the repo public or configure registry auth on the server. We currently have the repo public.

## Deployment Procedure

To update the deployed MCPs after a code change:

```bash
# 1. Push to main (triggers GitHub Actions build)
git push

# 2. Wait for CI to build (~90s)
gh run list --limit 1

# 3. SSH to server and pull + restart
ssh -i ~/.ssh/id_ed25519 root@95.216.23.208
cd /data/coolify/services/xkkcc0g4o48kkcows8488so4
docker compose pull personal-knowledge gtd
docker compose up -d personal-knowledge gtd
# Reconnect to coolify network if containers were recreated
docker network connect coolify personal-knowledge-xkkcc0g4o48kkcows8488so4 2>/dev/null
docker network connect coolify gtd-xkkcc0g4o48kkcows8488so4 2>/dev/null
```
