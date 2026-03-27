# Coolify Setup Guide for LL5

Practical, step-by-step guide to deploying all LL5 services on Coolify. This guide assumes you have read the [Deployment Plan](./deployment.md) for architectural context.

---

## Prerequisites

| Requirement | Details |
|---|---|
| Coolify instance | Running Coolify v4.x with admin access |
| GitHub repository | `arnonzamir/ll5` (private) |
| GitHub PAT | Personal access token with `read:packages` scope for pulling from GHCR |
| Domain name | A domain you control, with DNS pointing to the Coolify server |
| SSH access | Root or sudo access to the Coolify server for deployment automation |

### Minimum Server Resources

| Resource | Minimum | Recommended |
|---|---|---|
| CPU | 4 vCPUs | 6 vCPUs |
| RAM | 4 GB | 8 GB |
| Disk | 40 GB SSD | 80 GB SSD |
| Network | Public IPv4, ports 80/443 open | Same |

Breakdown: Elasticsearch alone needs 1-2 GB heap. PostgreSQL needs 512 MB-1 GB. Each Node.js MCP service uses 128-256 MB. The gateway uses 256-512 MB. Coolify and Traefik overhead is roughly 512 MB.

---

## 1. Create Coolify Project

1. Log in to your Coolify dashboard.
2. Click **Projects** in the left sidebar.
3. Click **+ New Project**.
4. Name it `ll5`.
5. Coolify creates a default "production" environment inside the project. You can use this as-is.
6. All services below will be created inside this project/environment. They will automatically share a Docker network, enabling inter-service communication by container name.

### Configure GHCR Authentication

Before adding any application services that pull from GHCR, register the container registry credentials:

1. In Coolify, go to **Keys & Tokens** (or **Private Registries** depending on your Coolify version).
2. Click **+ Add** and enter:
   - **Registry URL**: `ghcr.io`
   - **Username**: `arnonzamir` (your GitHub username)
   - **Password**: Your GitHub PAT with `read:packages` scope
3. Save. This credential will be available when configuring Docker image sources.

---

## 2. Infrastructure Services

### 2a. Elasticsearch 8.x

Elasticsearch is the backing store for the personal-knowledge, awareness, and messaging MCPs, and is also written to by the gateway.

**Create the service in Coolify:**

1. Inside the `ll5` project, click **+ New Resource**.
2. Select **Docker Image** (or **Service > Raw Docker Image**).
3. Configure:

| Setting | Value |
|---|---|
| Name | `elasticsearch` |
| Image | `docker.elastic.co/elasticsearch/elasticsearch:8.17.0` |
| Ports | None exposed externally. Internal port: `9200` |

**Environment variables:**

```
discovery.type=single-node
xpack.security.enabled=false
xpack.security.http.ssl.enabled=false
ES_JAVA_OPTS=-Xms1g -Xmx1g
```

Adjust `ES_JAVA_OPTS` based on available server RAM. Use `-Xms512m -Xmx512m` on a 4 GB server, `-Xms1g -Xmx1g` on 8 GB+.

**Persistent volume:**

| Container path | Purpose |
|---|---|
| `/usr/share/elasticsearch/data` | Index data |

In Coolify, add a persistent storage mount. Use a named volume (e.g., `ll5-es-data`) or bind mount to a host path like `/data/ll5/elasticsearch`.

**Health check:**

```
curl -f http://localhost:9200/_cluster/health || exit 1
```

Configure in Coolify: interval 30s, timeout 10s, retries 5, start period 45s.

**Resource limits:**

| Resource | Value |
|---|---|
| Memory | 1536 MB (minimum 768 MB) |
| CPU | 1.5 |

**Networking:** Internal only. Do NOT assign a domain or expose any ports externally. Other ll5 services reach it at `http://elasticsearch:9200` via the shared Docker network.

### 2b. PostgreSQL 16.x

PostgreSQL backs the gtd, google, and messaging MCPs.

**Create the service in Coolify:**

1. Inside the `ll5` project, click **+ New Resource**.
2. Select **Database > PostgreSQL** (Coolify has first-class PostgreSQL support), or use **Docker Image** with `postgres:16-alpine`.

| Setting | Value |
|---|---|
| Name | `postgres` |
| Image | `postgres:16-alpine` |
| Ports | None exposed externally. Internal port: `5432` |

**Environment variables:**

```
POSTGRES_DB=ll5
POSTGRES_USER=ll5
POSTGRES_PASSWORD=<generate-a-strong-password>
```

**Persistent volume:**

| Container path | Purpose |
|---|---|
| `/var/lib/postgresql/data` | Database files |

Use a named volume (e.g., `ll5-pg-data`) or bind mount to `/data/ll5/postgres`.

**Health check:**

```
pg_isready -U ll5
```

Configure in Coolify: interval 10s, timeout 5s, retries 5.

**Resource limits:**

| Resource | Value |
|---|---|
| Memory | 512 MB |
| CPU | 1.0 |

**Networking:** Internal only, same as Elasticsearch.

**Database strategy -- single database with schema-level separation:**

All PostgreSQL-backed MCPs share the single `ll5` database. Each MCP's migration runner creates its own tables with service-prefixed names (e.g., `gtd_projects`, `google_oauth_tokens`). This approach is recommended because:

- Simpler connection management (one `DATABASE_URL` for all PG-backed services)
- Coolify only needs one PostgreSQL container
- Each MCP's migration runner is independent and idempotent
- If you later need isolation, move to separate databases without changing application code (just change `DATABASE_URL`)

The alternative (separate databases per MCP) is also supported. To do this, override `POSTGRES_DB` and create additional databases via an init script. See the lf project's approach in the "Patterns from Existing Projects" section at the end of this guide.

---

## 3. Application Services

All application services follow the same pattern. They pull pre-built Docker images from GHCR (built by the GitHub Actions CI pipeline).

### Service Template

Every service shares this base configuration:

| Setting | Value |
|---|---|
| Type | Docker Image |
| Registry | ghcr.io (authenticated, see step 1) |
| Port | 3000 (internal) |
| Restart policy | unless-stopped |
| Health check | Built into Docker image: `GET /health` on port 3000 |
| Resource limits | 256 MB RAM, 0.5 CPU (unless noted otherwise) |

Common environment variables for ALL application services:

```
NODE_ENV=production
PORT=3000
LOG_LEVEL=info
```

### 3a. personal-knowledge MCP

| Setting | Value |
|---|---|
| Name | `personal-knowledge` |
| Image | `ghcr.io/arnonzamir/ll5-personal-knowledge:latest` |
| Domain | `mcp-knowledge.<yourdomain>` |
| Depends on | elasticsearch |

**Environment variables:**

```
NODE_ENV=production
PORT=3000
LOG_LEVEL=info
API_KEY=<your-mcp-api-key>
ELASTICSEARCH_URL=http://elasticsearch:9200
```

**Resource limits:** 256 MB RAM, 0.5 CPU.

### 3b. gtd MCP

| Setting | Value |
|---|---|
| Name | `gtd` |
| Image | `ghcr.io/arnonzamir/ll5-gtd:latest` |
| Domain | `mcp-gtd.<yourdomain>` |
| Depends on | postgres |

**Environment variables:**

```
NODE_ENV=production
PORT=3000
LOG_LEVEL=info
API_KEY=<your-mcp-api-key>
DATABASE_URL=postgresql://ll5:<postgres-password>@postgres:5432/ll5
```

**Resource limits:** 256 MB RAM, 0.5 CPU.

On first startup, the gtd MCP runs its migration runner automatically, creating all required tables.

### 3c. awareness MCP

| Setting | Value |
|---|---|
| Name | `awareness` |
| Image | `ghcr.io/arnonzamir/ll5-awareness:latest` |
| Domain | `mcp-awareness.<yourdomain>` |
| Depends on | elasticsearch |

**Environment variables:**

```
NODE_ENV=production
PORT=3000
LOG_LEVEL=info
API_KEY=<your-mcp-api-key>
ELASTICSEARCH_URL=http://elasticsearch:9200
```

**Resource limits:** 256 MB RAM, 0.5 CPU.

### 3d. google MCP

| Setting | Value |
|---|---|
| Name | `google` |
| Image | `ghcr.io/arnonzamir/ll5-google:latest` |
| Domain | `mcp-google.<yourdomain>` |
| Depends on | postgres |

**Environment variables:**

```
NODE_ENV=production
PORT=3000
LOG_LEVEL=info
API_KEY=<your-mcp-api-key>
DATABASE_URL=postgresql://ll5:<postgres-password>@postgres:5432/ll5
GOOGLE_CLIENT_ID=<your-google-oauth-client-id>
GOOGLE_CLIENT_SECRET=<your-google-oauth-client-secret>
GOOGLE_REDIRECT_URI=https://mcp-google.<yourdomain>/oauth/callback
ENCRYPTION_KEY=<32-byte-hex-string-for-token-encryption>
```

Generate `ENCRYPTION_KEY` with: `openssl rand -hex 32`

**Resource limits:** 256 MB RAM, 0.5 CPU.

The `GOOGLE_REDIRECT_URI` must match exactly what is configured in the Google Cloud Console OAuth credentials. Make sure the domain is the one you assign in Coolify.

### 3e. messaging MCP

| Setting | Value |
|---|---|
| Name | `messaging` |
| Image | `ghcr.io/arnonzamir/ll5-messaging:latest` |
| Domain | `mcp-messaging.<yourdomain>` |
| Depends on | elasticsearch |

**Environment variables:**

```
NODE_ENV=production
PORT=3000
LOG_LEVEL=info
API_KEY=<your-mcp-api-key>
ELASTICSEARCH_URL=http://elasticsearch:9200
EVOLUTION_API_URL=<your-evolution-api-base-url>
EVOLUTION_API_KEY=<your-evolution-api-key>
```

**Resource limits:** 256 MB RAM, 0.5 CPU.

### 3f. gateway

| Setting | Value |
|---|---|
| Name | `gateway` |
| Image | `ghcr.io/arnonzamir/ll5-gateway:latest` |
| Domain | `gateway.<yourdomain>` |
| Depends on | elasticsearch, postgres |

**Environment variables:**

```
NODE_ENV=production
PORT=3000
LOG_LEVEL=info
ELASTICSEARCH_URL=http://elasticsearch:9200
GEOCODING_API_KEY=<your-geocoding-api-key>
WEBHOOK_TOKENS={"<token1>":"<user-id-1>"}
```

`WEBHOOK_TOKENS` is a JSON object mapping webhook bearer tokens to user IDs. The phone sends its token in the request, and the gateway maps it to a user for data scoping.

**Resource limits:** 512 MB RAM, 1.0 CPU (the gateway handles more concurrent traffic than individual MCPs).

### 3g. auth (future)

Not yet implemented. When added, it will follow the same template with PostgreSQL as its backing store.

---

## 4. Networking

### Internal Network

Coolify automatically creates a Docker network for each project. All services within the `ll5` project share this network and can reach each other by container name:

| From | To | URL |
|---|---|---|
| Any MCP | Elasticsearch | `http://elasticsearch:9200` |
| Any MCP | PostgreSQL | `postgres:5432` |
| Gateway | Elasticsearch | `http://elasticsearch:9200` |

### External Access

Services that need external access (reachable from the internet):

| Service | Why | Domain |
|---|---|---|
| personal-knowledge | Claude Code connects remotely | `mcp-knowledge.<yourdomain>` |
| gtd | Claude Code connects remotely | `mcp-gtd.<yourdomain>` |
| awareness | Claude Code connects remotely | `mcp-awareness.<yourdomain>` |
| google | Claude Code connects remotely + OAuth callback | `mcp-google.<yourdomain>` |
| messaging | Claude Code connects remotely | `mcp-messaging.<yourdomain>` |
| gateway | Phone pushes GPS/IM/calendar data | `gateway.<yourdomain>` |

Services that must NOT be exposed externally:

| Service | Reason |
|---|---|
| elasticsearch | Database, internal only |
| postgres | Database, internal only |

### Traefik Reverse Proxy (Coolify-managed)

Coolify manages Traefik automatically. When you assign a domain to a service in Coolify, it:

1. Creates a Traefik router rule for that domain.
2. Points it to the service's internal port (3000 for all ll5 application services).
3. Provisions a TLS certificate via Let's Encrypt.
4. Handles HTTPS termination.

You do not need to manually configure Traefik. Just enter the domain in the service settings in Coolify and ensure your DNS records point to the Coolify server IP.

### DNS Configuration

For each service domain, create an A record (or CNAME if behind Cloudflare) pointing to your Coolify server:

```
mcp-knowledge.<yourdomain>    A    <server-ip>
mcp-gtd.<yourdomain>          A    <server-ip>
mcp-awareness.<yourdomain>    A    <server-ip>
mcp-google.<yourdomain>       A    <server-ip>
mcp-messaging.<yourdomain>    A    <server-ip>
gateway.<yourdomain>           A    <server-ip>
```

If using Cloudflare, you can either proxy the records (orange cloud) or use a Cloudflare Tunnel. See the lf project's `coolify-fix-dns.sh` script for tunnel DNS troubleshooting patterns.

---

## 5. GitHub Actions Integration

### How CI/CD Works

The GitHub Actions workflow (`.github/workflows/build-and-push.yml`) handles building and pushing images:

1. On push to `main`, it detects which packages changed.
2. Builds Docker images in parallel using a matrix strategy.
3. Pushes images to GHCR with both `latest` and SHA tags:
   - `ghcr.io/arnonzamir/ll5-<service>:latest`
   - `ghcr.io/arnonzamir/ll5-<service>:<git-sha>`

### Triggering Coolify Redeploy

After GitHub Actions pushes new images, Coolify needs to redeploy. There are three approaches, listed from most to least recommended:

**Approach A: SSH-based deploy (recommended, proven in the lf project)**

Add a `deploy` job to the workflow that SSHes into the Coolify server and updates the running containers. This is what the lf project uses after finding the Coolify API unreliable:

```yaml
deploy:
  runs-on: ubuntu-latest
  needs: [build]
  if: always() && !cancelled() && needs.build.result == 'success'
  steps:
    - name: Setup SSH
      run: |
        mkdir -p ~/.ssh
        echo "${{ secrets.DEPLOY_SSH_KEY }}" > ~/.ssh/deploy_key
        chmod 600 ~/.ssh/deploy_key
        ssh-keyscan -H "${{ vars.SERVER_HOST }}" >> ~/.ssh/known_hosts 2>/dev/null

    - name: Deploy
      env:
        SERVER_HOST: ${{ vars.SERVER_HOST }}
        APP_UUID: ${{ secrets.COOLIFY_APP_UUID }}
        SHA: ${{ github.sha }}
      run: |
        SSH="ssh -i ~/.ssh/deploy_key root@${SERVER_HOST}"
        DIR="/data/coolify/services/${APP_UUID}"

        # Update image tags for rebuilt services
        $SSH "sed -i -E 's|(ghcr.io/arnonzamir/ll5-[a-z-]+:)[a-zA-Z0-9._-]+|\1${SHA}|g' ${DIR}/docker-compose.yml"

        # Pull and recreate
        $SSH "cd ${DIR} && docker compose pull && docker compose up -d"

        # Health check
        echo "Waiting for health checks..."
        for i in $(seq 1 24); do
          sleep 5
          STATUS=$(curl -s -o /dev/null -w '%{http_code}' "https://mcp-knowledge.${DOMAIN}/health" 2>/dev/null || echo "000")
          echo "  attempt $i/24: HTTP $STATUS"
          if [ "$STATUS" = "200" ]; then
            echo "Deploy successful!"
            break
          fi
        done

    - name: Cleanup
      if: always()
      run: rm -f ~/.ssh/deploy_key
```

Required GitHub repository configuration:
- **Secrets**: `DEPLOY_SSH_KEY` (SSH private key), `COOLIFY_APP_UUID` (from Coolify service URL)
- **Variables**: `SERVER_HOST` (server IP or hostname), `DOMAIN` (your base domain)

**Approach B: Coolify webhook**

Configure a webhook URL for each service in Coolify, then call it from the workflow:

```yaml
- name: Trigger Coolify redeploy
  run: curl -s -X GET "${{ secrets.COOLIFY_WEBHOOK_URL }}"
```

Simpler to set up but less reliable (the lf project moved away from this approach).

**Approach C: Coolify polling**

Configure Coolify to check for new `latest` images on an interval (every 5 minutes). No workflow changes needed, but introduces deployment delay.

### Required GitHub Secrets and Variables

| Name | Type | Value |
|---|---|---|
| `DEPLOY_SSH_KEY` | Secret | SSH private key for server access |
| `COOLIFY_APP_UUID` | Secret | UUID of the ll5 service in Coolify |
| `SERVER_HOST` | Variable | Server IP or hostname |
| `DOMAIN` | Variable | Your base domain (e.g., `example.com`) |

---

## 6. Secrets Management

### Where Secrets Live

| Secret | Where stored | Who uses it |
|---|---|---|
| `POSTGRES_PASSWORD` | Coolify env vars (postgres service) | postgres, gtd, google, gateway |
| `API_KEY` | Coolify env vars (per MCP service) | All MCP services |
| `GOOGLE_CLIENT_ID` | Coolify env vars (google service) | google MCP |
| `GOOGLE_CLIENT_SECRET` | Coolify env vars (google service) | google MCP |
| `ENCRYPTION_KEY` | Coolify env vars (google service) | google MCP |
| `EVOLUTION_API_KEY` | Coolify env vars (messaging service) | messaging MCP |
| `GEOCODING_API_KEY` | Coolify env vars (gateway service) | gateway |
| `WEBHOOK_TOKENS` | Coolify env vars (gateway service) | gateway |
| `DEPLOY_SSH_KEY` | GitHub Secrets | GitHub Actions deploy job |

### Shared vs Per-Service Secrets

**Shared secrets** (same value across multiple services):
- `API_KEY` -- can be shared across all MCPs for simplicity, or use different keys per MCP for better isolation. Shared is simpler; separate is more secure. Start shared, split later if needed.
- `DATABASE_URL` -- same connection string for all PG-backed services (since they share one database).
- `ELASTICSEARCH_URL` -- not a secret, but shared across ES-backed services.

**Per-service secrets** (unique to each service):
- `GOOGLE_CLIENT_SECRET`, `ENCRYPTION_KEY` -- google MCP only
- `EVOLUTION_API_KEY` -- messaging MCP only
- `GEOCODING_API_KEY`, `WEBHOOK_TOKENS` -- gateway only

### Secret Rotation Procedure

1. Generate the new secret value.
2. In Coolify, update the environment variable on the affected service(s).
3. Redeploy the service(s). Coolify injects environment variables at container start time, so the new value takes effect on redeploy.
4. If rotating `API_KEY`, also update the corresponding header value in the Claude Code MCP configuration.
5. If rotating `POSTGRES_PASSWORD`, update it on both the postgres service AND every service that includes it in `DATABASE_URL`.

---

## 7. First-Time Setup Checklist

Follow these steps in order. Do not skip ahead.

### Phase 1: Infrastructure

1. **Create Coolify project** named `ll5` (see section 1).
2. **Register GHCR credentials** in Coolify (see section 1).
3. **Deploy Elasticsearch** container (see section 2a).
4. **Verify Elasticsearch health:**
   - In Coolify, check container status shows "healthy".
   - Or SSH to the server and run: `docker exec <es-container> curl -s localhost:9200/_cluster/health`
   - Expected: `"status":"green"` (or `"yellow"` for single-node, which is normal).
5. **Deploy PostgreSQL** container (see section 2b).
6. **Verify PostgreSQL health:**
   - Container status shows "healthy" in Coolify.
   - Or: `docker exec <pg-container> pg_isready -U ll5`

### Phase 2: Application Services (deploy one at a time, verify each)

7. **Deploy personal-knowledge MCP** (see section 3a).
8. **Verify personal-knowledge health:**
   - `curl https://mcp-knowledge.<yourdomain>/health`
   - Expected: `{"status":"ok","service":"personal-knowledge","dependencies":{"elasticsearch":"connected"}}`
9. **Deploy gtd MCP** (see section 3b).
   - On first start, it automatically runs database migrations.
10. **Verify gtd health:**
    - `curl https://mcp-gtd.<yourdomain>/health`
    - Expected: `{"status":"ok","service":"gtd","dependencies":{"postgresql":"connected"}}`
11. **Deploy awareness MCP** (see section 3c).
12. **Verify awareness health:**
    - `curl https://mcp-awareness.<yourdomain>/health`
13. **Deploy google MCP** (see section 3d).
    - Ensure `GOOGLE_REDIRECT_URI` matches the Coolify domain exactly.
14. **Verify google health:**
    - `curl https://mcp-google.<yourdomain>/health`
15. **Deploy messaging MCP** (see section 3e).
16. **Verify messaging health:**
    - `curl https://mcp-messaging.<yourdomain>/health`
17. **Deploy gateway** (see section 3f).
18. **Verify gateway health:**
    - `curl https://gateway.<yourdomain>/health`

### Phase 3: Integration

19. **Configure Claude Code MCP connections** (see section 8).
20. **Test end-to-end:** Open Claude Code, invoke a tool from each MCP, and confirm data flows through.
21. **Configure phone automation** to push data to the gateway webhook endpoint.

---

## 8. Claude Code Configuration

Add the following MCP server configuration to your Claude Code settings. This goes in your user-level or project-level `.claude/settings.json`:

```json
{
  "mcpServers": {
    "personal-knowledge": {
      "type": "streamable-http",
      "url": "https://mcp-knowledge.<yourdomain>/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_API_KEY}"
      }
    },
    "gtd": {
      "type": "streamable-http",
      "url": "https://mcp-gtd.<yourdomain>/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_API_KEY}"
      }
    },
    "awareness": {
      "type": "streamable-http",
      "url": "https://mcp-awareness.<yourdomain>/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_API_KEY}"
      }
    },
    "google": {
      "type": "streamable-http",
      "url": "https://mcp-google.<yourdomain>/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_API_KEY}"
      }
    },
    "messaging": {
      "type": "streamable-http",
      "url": "https://mcp-messaging.<yourdomain>/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_API_KEY}"
      }
    }
  }
}
```

The `${MCP_API_KEY}` reference is resolved from an environment variable in your shell. Set it before launching Claude Code:

```bash
export MCP_API_KEY="your-api-key-here"
```

Or add it to your shell profile (`.zshrc`, `.bashrc`) so it persists across sessions.

---

## 9. Monitoring and Troubleshooting

### Checking Logs in Coolify

1. Open the `ll5` project in Coolify.
2. Click on any service.
3. Click the **Logs** tab.
4. Logs stream in real time. All ll5 services output structured JSON to stdout:
   ```json
   {"level":"info","service":"gtd","msg":"Server started","port":3000,"timestamp":"2026-03-27T10:00:00Z"}
   ```

Alternatively, SSH to the server and use Docker directly:

```bash
# Tail logs for a specific service
docker logs --tail 100 -f <container-name>

# List all ll5 containers
docker ps --filter "label=com.docker.compose.project=ll5"
```

### Common Issues and Fixes

| Symptom | Likely Cause | Fix |
|---|---|---|
| MCP returns `{"status":"degraded","dependencies":{"elasticsearch":"disconnected"}}` | Elasticsearch not running or not on same Docker network | Check ES container health in Coolify. Verify both services are in the same project. |
| `ECONNREFUSED` to postgres:5432 | PostgreSQL not running or wrong network | Same as above. Check PG container health. |
| 502 Bad Gateway on the domain | Service not healthy, Traefik cannot route | Check service logs. The container may be in a crash loop. Check health endpoint. |
| TLS certificate not provisioning | DNS not pointing to server, or port 80 blocked | Verify DNS A record. Ensure port 80 is open (Let's Encrypt uses HTTP-01 challenge). |
| GHCR pull fails: `unauthorized` | GHCR credentials not configured or expired | Re-register the GitHub PAT in Coolify's registry settings. Ensure the PAT has `read:packages` scope. |
| Image not found on GHCR | CI pipeline has not run for this service | Check GitHub Actions. Run workflow manually via workflow_dispatch. |
| Database migrations fail on startup | Wrong `DATABASE_URL` or PG not ready | Check the MCP's logs for the exact SQL error. Verify connection string. |
| Gateway returns 401 on webhook | Wrong or missing webhook token | Verify the token sent by the phone matches a key in `WEBHOOK_TOKENS` JSON. |

### How to Restart a Service

1. In Coolify, click on the service.
2. Click **Restart**.

Or via SSH:

```bash
# Find the container name
docker ps --filter "label=com.docker.compose.project=ll5" --format "{{.Names}}"

# Restart it
docker restart <container-name>
```

### How to Rollback to a Previous Image

Every image is tagged with the git commit SHA alongside `latest`. To rollback:

1. Find the last known good commit SHA from `git log` or the GitHub commits page.
2. In Coolify, go to the service settings.
3. Change the image tag from `latest` to the specific SHA:
   ```
   ghcr.io/arnonzamir/ll5-gtd:abc1234def
   ```
4. Redeploy.
5. Verify the health endpoint.

Rollbacks are safe because all database migrations are additive only (no destructive schema changes). The older code will work with the newer schema.

---

## 10. Patterns Learned from Existing Projects

### From the lf (LoanForge) project

The lf project is the most mature Coolify deployment in this workspace. Key patterns that apply to ll5:

**Docker Compose structure for Coolify:**

The lf project maintains a `docker-compose.coolify.yml` for the Coolify-specific configuration and a `docker-compose.prod.yml` as the full production reference. In Coolify, the service is configured as a "Docker Compose" type, and Coolify reads the compose file from `/data/coolify/services/<uuid>/docker-compose.yml` on the server.

- All services are on a named bridge network (e.g., `loanforge-net`).
- Every service has explicit resource limits (`deploy.resources.limits.memory` and `cpus`).
- Every service has JSON file logging with rotation (`max-size: "10m"`, `max-file: "3"`).
- Infrastructure services use `depends_on` with `condition: service_healthy`.
- Application services use Traefik labels for domain routing:
  ```yaml
  labels:
    - "traefik.enable=true"
    - "traefik.http.routers.backend.rule=Host(`api.${DOMAIN}`)"
    - "traefik.http.routers.backend.tls=true"
    - "traefik.http.routers.backend.tls.certresolver=letsencrypt"
    - "traefik.http.services.backend.loadbalancer.server.port=8080"
  ```

**CI/CD deployment via SSH (not Coolify API):**

The lf project originally used the Coolify REST API to trigger redeploys but found it unreliable (restart commands queued but never executed, and escaping in Traefik labels broke routing). The current approach:

1. GitHub Actions builds and pushes images to GHCR.
2. A deploy job SSHes into the server.
3. Uses `sed` to update image tags in the Coolify-managed compose file on disk.
4. Runs `docker compose pull && docker compose up -d` to deploy.
5. Polls the health endpoint to confirm success.
6. Prints container logs on failure for debugging.

This pattern is directly applicable to ll5 and is the recommended deployment approach.

**Multiple Coolify "services" for logical grouping:**

The lf project splits into three Coolify services: `zlf-app` (main app + databases), `zlf-mocks` (mock external services), and `zlf-obs` (observability stack). Each has its own UUID and compose file. For ll5, a single Coolify service containing all containers is sufficient given the smaller scale.

**PostgreSQL init script for multiple databases:**

The lf project uses an entrypoint wrapper to create additional databases on first boot:

```yaml
entrypoint: ["/bin/sh", "-c"]
command:
  - |
    cat > /docker-entrypoint-initdb.d/init-databases.sh <<'INITDB'
    #!/bin/bash
    set -e
    psql -v ON_ERROR_STOP=1 --username "$$POSTGRES_USER" --dbname "$$POSTGRES_DB" <<-EOSQL
        CREATE DATABASE additional_db;
        GRANT ALL PRIVILEGES ON DATABASE additional_db TO $$POSTGRES_USER;
    EOSQL
    INITDB
    chmod +x /docker-entrypoint-initdb.d/init-databases.sh
    exec docker-entrypoint.sh postgres
```

This pattern is useful if you decide to use separate databases per MCP instead of the recommended single-database approach.

**Cloudflare Tunnel integration:**

The lf project includes scripts for setting up Cloudflare Tunnels as an alternative to direct port exposure. This involves:
- Creating a CNAME record pointing to `<tunnel-id>.cfargotunnel.com`
- Ensuring the record is proxied (orange cloud in Cloudflare dashboard)
- A DNS fix script for common tunnel issues

This is optional for ll5 but provides better security by not exposing the server's IP address.

### From the mcps (predecessor) project

The mcps project was the monolithic predecessor to ll5. Its architecture doc confirms:
- Deployment via Coolify with Docker Compose and GitHub auto-deploy.
- 4 PostgreSQL instances managed by Coolify.
- Single container (NestJS monolith) with 2 GB memory limit, 512 MB reservation.
- Port 3000 for HTTP.
- Migrations run at startup, fully idempotent.

The ll5 architecture decomposes this monolith into independent MCP servers, each with its own container. The deployment patterns (Coolify + GHCR + health checks + startup migrations) carry forward directly.

---

## Appendix: Quick Reference

### All Services at a Glance

| Service | Image | Port | Storage | Domain |
|---|---|---|---|---|
| elasticsearch | `elasticsearch:8.17.0` | 9200 | Volume | (internal) |
| postgres | `postgres:16-alpine` | 5432 | Volume | (internal) |
| personal-knowledge | `ghcr.io/arnonzamir/ll5-personal-knowledge` | 3000 | None | `mcp-knowledge.<domain>` |
| gtd | `ghcr.io/arnonzamir/ll5-gtd` | 3000 | None | `mcp-gtd.<domain>` |
| awareness | `ghcr.io/arnonzamir/ll5-awareness` | 3000 | None | `mcp-awareness.<domain>` |
| google | `ghcr.io/arnonzamir/ll5-google` | 3000 | None | `mcp-google.<domain>` |
| messaging | `ghcr.io/arnonzamir/ll5-messaging` | 3000 | None | `mcp-messaging.<domain>` |
| gateway | `ghcr.io/arnonzamir/ll5-gateway` | 3000 | None | `gateway.<domain>` |

### All Environment Variables

| Variable | Services | Secret? | Example |
|---|---|---|---|
| `NODE_ENV` | All app services | No | `production` |
| `PORT` | All app services | No | `3000` |
| `LOG_LEVEL` | All app services | No | `info` |
| `API_KEY` | All MCP services | Yes | `mcp-secret-...` |
| `ELASTICSEARCH_URL` | personal-knowledge, awareness, messaging, gateway | No | `http://elasticsearch:9200` |
| `DATABASE_URL` | gtd, google | Yes (contains password) | `postgresql://ll5:pass@postgres:5432/ll5` |
| `GOOGLE_CLIENT_ID` | google | No | `123.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | google | Yes | `GOCSPX-...` |
| `GOOGLE_REDIRECT_URI` | google | No | `https://mcp-google.example.com/oauth/callback` |
| `ENCRYPTION_KEY` | google | Yes | `64-char-hex` |
| `EVOLUTION_API_URL` | messaging | No | `https://evolution.example.com` |
| `EVOLUTION_API_KEY` | messaging | Yes | `evo-key-...` |
| `GEOCODING_API_KEY` | gateway | Yes | `geo-key-...` |
| `WEBHOOK_TOKENS` | gateway | Yes | `{"tok1":"user-uuid-1"}` |
| `POSTGRES_DB` | postgres | No | `ll5` |
| `POSTGRES_USER` | postgres | No | `ll5` |
| `POSTGRES_PASSWORD` | postgres | Yes | Generated |
| `discovery.type` | elasticsearch | No | `single-node` |
| `xpack.security.enabled` | elasticsearch | No | `false` |
| `ES_JAVA_OPTS` | elasticsearch | No | `-Xms1g -Xmx1g` |

### Total Resource Budget

| Service | RAM | CPU |
|---|---|---|
| Elasticsearch | 1536 MB | 1.5 |
| PostgreSQL | 512 MB | 1.0 |
| personal-knowledge | 256 MB | 0.5 |
| gtd | 256 MB | 0.5 |
| awareness | 256 MB | 0.5 |
| google | 256 MB | 0.5 |
| messaging | 256 MB | 0.5 |
| gateway | 512 MB | 1.0 |
| **Total** | **3840 MB** | **6.0** |

Add approximately 512 MB for Coolify/Traefik overhead, bringing the total to roughly 4.5 GB.
