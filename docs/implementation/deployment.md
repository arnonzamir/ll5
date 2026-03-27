# Deployment and Infrastructure Implementation Plan

This document covers the complete deployment pipeline: Dockerfiles, CI/CD via GitHub Actions, production deployment on Coolify, environment configuration, database initialization, and operational concerns.

---

## 1. Repository Structure

```
ll5/
  packages/
    personal-knowledge/   # MCP server (Elasticsearch)
    gtd/                  # MCP server (PostgreSQL)
    awareness/            # MCP server (Elasticsearch)
    google/               # MCP server (PostgreSQL)
    messaging/            # MCP server (Elasticsearch + external APIs)
    gateway/              # HTTP service (Elasticsearch + PostgreSQL)
    shared/               # Shared types, interfaces, utilities
  docs/
  docker/
    Dockerfile.mcp        # Shared Dockerfile for all MCP servers
    Dockerfile.gateway    # Gateway-specific Dockerfile
    docker-compose.yml    # Local development
    docker-compose.prod.yml  # Production reference (mirrors Coolify setup)
  .github/
    workflows/
      build-and-push.yml  # CI: build + push to GHCR
  CLAUDE.md
```

---

## 2. Docker Strategy

### 2.1 Shared MCP Dockerfile (`docker/Dockerfile.mcp`)

A single Dockerfile builds all five MCP servers. The target package is selected via the `PACKAGE_NAME` build argument.

```dockerfile
# ── Build stage ──────────────────────────────────────────────
FROM node:20-slim AS build

ARG PACKAGE_NAME
ENV PACKAGE_NAME=${PACKAGE_NAME}

WORKDIR /app

# Copy workspace root files needed for dependency resolution
COPY package.json package-lock.json tsconfig.base.json ./

# Copy shared package (all MCPs depend on it)
COPY packages/shared/ packages/shared/

# Copy target package
COPY packages/${PACKAGE_NAME}/ packages/${PACKAGE_NAME}/

# Install all dependencies (workspace-aware)
RUN npm ci --workspace=packages/shared --workspace=packages/${PACKAGE_NAME}

# Build shared first, then target
RUN npm run build --workspace=packages/shared
RUN npm run build --workspace=packages/${PACKAGE_NAME}

# ── Runtime stage ────────────────────────────────────────────
FROM node:20-alpine AS runtime

ARG PACKAGE_NAME
ENV PACKAGE_NAME=${PACKAGE_NAME}
ENV NODE_ENV=production

WORKDIR /app

# Copy built artifacts and production dependencies
COPY --from=build /app/packages/${PACKAGE_NAME}/dist ./dist
COPY --from=build /app/packages/${PACKAGE_NAME}/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/dist ./node_modules/@ll5/shared/dist
COPY --from=build /app/packages/shared/package.json ./node_modules/@ll5/shared/

# Non-root user for security
RUN addgroup -S app && adduser -S app -G app
USER app

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
```

Build commands:

```bash
# Build a specific MCP image
docker build -f docker/Dockerfile.mcp \
  --build-arg PACKAGE_NAME=personal-knowledge \
  -t ghcr.io/USERNAME/ll5-personal-knowledge:latest .

docker build -f docker/Dockerfile.mcp \
  --build-arg PACKAGE_NAME=gtd \
  -t ghcr.io/USERNAME/ll5-gtd:latest .
```

### 2.2 Gateway Dockerfile (`docker/Dockerfile.gateway`)

Identical structure to the MCP Dockerfile but without the `PACKAGE_NAME` arg -- it always targets `packages/gateway`.

```dockerfile
FROM node:20-slim AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/gateway/ packages/gateway/

RUN npm ci --workspace=packages/shared --workspace=packages/gateway
RUN npm run build --workspace=packages/shared
RUN npm run build --workspace=packages/gateway

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/packages/gateway/dist ./dist
COPY --from=build /app/packages/gateway/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/dist ./node_modules/@ll5/shared/dist
COPY --from=build /app/packages/shared/package.json ./node_modules/@ll5/shared/

RUN addgroup -S app && adduser -S app -G app
USER app

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
```

### 2.3 Image Tagging

Every image is tagged with both the git SHA and `latest`:

```
ghcr.io/USERNAME/ll5-personal-knowledge:abc1234
ghcr.io/USERNAME/ll5-personal-knowledge:latest
ghcr.io/USERNAME/ll5-gtd:abc1234
ghcr.io/USERNAME/ll5-gtd:latest
...
ghcr.io/USERNAME/ll5-gateway:abc1234
ghcr.io/USERNAME/ll5-gateway:latest
```

---

## 3. GitHub Actions Workflow

### 3.1 Workflow File (`.github/workflows/build-and-push.yml`)

```yaml
name: Build and Push Images

on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      packages:
        description: 'Comma-separated packages to build (empty = all)'
        required: false
        default: ''

env:
  REGISTRY: ghcr.io
  IMAGE_PREFIX: ghcr.io/${{ github.repository_owner }}/ll5

jobs:
  detect-changes:
    runs-on: ubuntu-latest
    outputs:
      matrix: ${{ steps.set-matrix.outputs.matrix }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2

      - id: set-matrix
        run: |
          PACKAGES=("personal-knowledge" "gtd" "awareness" "google" "messaging" "gateway")

          # On manual dispatch with specific packages, use those
          if [[ "${{ github.event_name }}" == "workflow_dispatch" && -n "${{ inputs.packages }}" ]]; then
            IFS=',' read -ra PACKAGES <<< "${{ inputs.packages }}"
          fi

          # On push, check which packages changed (shared changes trigger all)
          if [[ "${{ github.event_name }}" == "push" ]]; then
            CHANGED=$(git diff --name-only HEAD~1 HEAD)
            SHARED_CHANGED=$(echo "$CHANGED" | grep -c "packages/shared/" || true)
            DOCKER_CHANGED=$(echo "$CHANGED" | grep -c "docker/" || true)

            if [[ "$SHARED_CHANGED" -eq 0 && "$DOCKER_CHANGED" -eq 0 ]]; then
              FILTERED=()
              for pkg in "${PACKAGES[@]}"; do
                if echo "$CHANGED" | grep -q "packages/$pkg/"; then
                  FILTERED+=("$pkg")
                fi
              done
              if [[ ${#FILTERED[@]} -gt 0 ]]; then
                PACKAGES=("${FILTERED[@]}")
              fi
            fi
          fi

          # Build JSON matrix
          JSON=$(printf '%s\n' "${PACKAGES[@]}" | jq -R . | jq -sc '{package: .}')
          echo "matrix=$JSON" >> "$GITHUB_OUTPUT"

  build:
    needs: detect-changes
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    strategy:
      matrix: ${{ fromJson(needs.detect-changes.outputs.matrix) }}
    steps:
      - uses: actions/checkout@v4

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Determine Dockerfile
        id: dockerfile
        run: |
          if [[ "${{ matrix.package }}" == "gateway" ]]; then
            echo "file=docker/Dockerfile.gateway" >> "$GITHUB_OUTPUT"
            echo "build_args=" >> "$GITHUB_OUTPUT"
          else
            echo "file=docker/Dockerfile.mcp" >> "$GITHUB_OUTPUT"
            echo "build_args=PACKAGE_NAME=${{ matrix.package }}" >> "$GITHUB_OUTPUT"
          fi

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          file: ${{ steps.dockerfile.outputs.file }}
          build-args: ${{ steps.dockerfile.outputs.build_args }}
          push: true
          tags: |
            ${{ env.IMAGE_PREFIX }}-${{ matrix.package }}:${{ github.sha }}
            ${{ env.IMAGE_PREFIX }}-${{ matrix.package }}:latest
          cache-from: type=gha,scope=${{ matrix.package }}
          cache-to: type=gha,mode=max,scope=${{ matrix.package }}
```

### 3.2 What the Workflow Does

1. **Change detection** -- on push to main, only rebuilds packages whose files actually changed. Changes to `packages/shared/` or `docker/` trigger a full rebuild of all packages.
2. **Matrix build** -- each package builds in parallel as a separate job.
3. **Docker layer caching** -- uses GitHub Actions cache (`type=gha`) to cache Docker layers per package, keeping build times low.
4. **Manual dispatch** -- allows triggering a build for specific packages or all packages from the GitHub UI.

---

## 4. Coolify Production Setup

### 4.1 Project Organization

Create a single Coolify project named `ll5` containing all services.

### 4.2 Infrastructure Services (Managed by Coolify)

These are created as Coolify-managed database/service resources:

#### Elasticsearch 8.x

- **Type**: Docker container (use Coolify's service creation or raw Docker image)
- **Image**: `docker.elastic.co/elasticsearch/elasticsearch:8.17.0`
- **Environment variables**:
  ```
  discovery.type=single-node
  xpack.security.enabled=false
  ES_JAVA_OPTS=-Xms512m -Xmx512m
  ```
- **Volume**: persistent volume for `/usr/share/elasticsearch/data`
- **Network**: internal Docker network only (no external exposure)
- **Service name**: `elasticsearch` (used as hostname by other containers)

#### PostgreSQL 16.x

- **Type**: Coolify-managed PostgreSQL resource
- **Version**: 16
- **Database**: `ll5`
- **Volume**: persistent volume for `/var/lib/postgresql/data`
- **Network**: internal Docker network only
- **Service name**: `postgres`

### 4.3 Application Services (Pull from GHCR)

Each application service is configured in Coolify as a "Docker Image" deployment (not git-based):

| Service              | Image                                        | Port |
|----------------------|----------------------------------------------|------|
| personal-knowledge   | `ghcr.io/USERNAME/ll5-personal-knowledge:latest` | 3000 |
| gtd                  | `ghcr.io/USERNAME/ll5-gtd:latest`               | 3000 |
| awareness            | `ghcr.io/USERNAME/ll5-awareness:latest`          | 3000 |
| google               | `ghcr.io/USERNAME/ll5-google:latest`             | 3000 |
| messaging            | `ghcr.io/USERNAME/ll5-messaging:latest`          | 3000 |
| gateway              | `ghcr.io/USERNAME/ll5-gateway:latest`            | 3000 |

Each service is configured with:

- **Restart policy**: `unless-stopped`
- **Health check**: built into the Docker image (see Dockerfile `HEALTHCHECK`)
- **Resource limits**: 256MB RAM / 0.5 CPU per MCP, 512MB RAM / 1 CPU for gateway (adjust based on observed usage)
- **Network**: all services on the same Coolify-managed Docker network

### 4.4 Networking and External Access

All containers share a single Docker network managed by Coolify. Internal communication uses service names as hostnames (e.g., `http://elasticsearch:9200`, `postgres://postgres:5432/ll5`).

**External access via Traefik (Coolify-managed)**:

Option A -- subdomain per MCP (recommended):

```
mcp-knowledge.yourdomain.com  → personal-knowledge:3000
mcp-gtd.yourdomain.com        → gtd:3000
mcp-awareness.yourdomain.com  → awareness:3000
mcp-google.yourdomain.com     → google:3000
mcp-messaging.yourdomain.com  → messaging:3000
gateway.yourdomain.com         → gateway:3000
```

Option B -- path-based routing under a single domain:

```
api.yourdomain.com/mcp/knowledge  → personal-knowledge:3000
api.yourdomain.com/mcp/gtd        → gtd:3000
api.yourdomain.com/mcp/awareness  → awareness:3000
api.yourdomain.com/mcp/google     → google:3000
api.yourdomain.com/mcp/messaging  → messaging:3000
api.yourdomain.com/gateway        → gateway:3000
```

In both options, Coolify handles TLS certificate provisioning via Let's Encrypt through its built-in Traefik integration. No manual certificate management is needed.

Elasticsearch and PostgreSQL are never exposed externally. They are only accessible on the internal Docker network.

### 4.5 Deployment Trigger

After GitHub Actions pushes a new `:latest` image to GHCR, trigger a redeploy in Coolify. Two approaches:

1. **Webhook** -- configure a Coolify webhook URL for each service. Add a final step in the GitHub Actions workflow that calls the webhook:
   ```yaml
   - name: Trigger Coolify redeploy
     run: |
       curl -s -X GET "${{ secrets.COOLIFY_WEBHOOK_URL_${{ matrix.package }} }}"
   ```

2. **Coolify polling** -- configure Coolify to check for new images on an interval (e.g., every 5 minutes). Simpler but introduces delay.

The webhook approach is preferred for immediate deployment after a successful build.

---

## 5. Environment Variables

### 5.1 Shared (All Services)

| Variable    | Description                     | Example         |
|-------------|---------------------------------|-----------------|
| `NODE_ENV`  | Runtime environment             | `production`    |
| `LOG_LEVEL` | Logging verbosity               | `info`          |
| `PORT`      | HTTP listen port                | `3000`          |

### 5.2 MCP Authentication

| Variable  | Description                          | Example              |
|-----------|--------------------------------------|----------------------|
| `API_KEY` | Bearer token for authenticating clients | `mcp-secret-key-...` |

Every MCP server validates incoming requests against this key. Each MCP can have its own key or share one -- separate keys are more secure.

### 5.3 Elasticsearch-Backed MCPs (personal-knowledge, awareness, messaging)

| Variable              | Description                    | Example                         |
|-----------------------|--------------------------------|---------------------------------|
| `ELASTICSEARCH_URL`   | Elasticsearch connection URL   | `http://elasticsearch:9200`     |

### 5.4 PostgreSQL-Backed MCPs (gtd, google)

| Variable       | Description                  | Example                                          |
|----------------|------------------------------|--------------------------------------------------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@postgres:5432/ll5` |

### 5.5 Gateway

| Variable              | Description                                | Example                              |
|-----------------------|--------------------------------------------|--------------------------------------|
| `ELASTICSEARCH_URL`   | Elasticsearch connection URL               | `http://elasticsearch:9200`          |
| `GEOCODING_API_KEY`   | API key for geocoding service              | `geo-key-...`                        |
| `WEBHOOK_TOKENS`      | JSON map of webhook token to user ID       | `{"tok1":"user1","tok2":"user2"}`    |

### 5.6 Google MCP

| Variable                | Description                           | Example                              |
|-------------------------|---------------------------------------|--------------------------------------|
| `DATABASE_URL`          | PostgreSQL connection string          | `postgresql://user:pass@postgres:5432/ll5` |
| `GOOGLE_CLIENT_ID`     | Google OAuth client ID                | `123456.apps.googleusercontent.com`  |
| `GOOGLE_CLIENT_SECRET`  | Google OAuth client secret           | `GOCSPX-...`                         |
| `GOOGLE_REDIRECT_URI`   | OAuth redirect URL                   | `https://mcp-google.yourdomain.com/oauth/callback` |
| `ENCRYPTION_KEY`        | Key for encrypting stored tokens     | `32-byte-hex-string`                 |

### 5.7 Messaging MCP

| Variable              | Description                     | Example                         |
|-----------------------|---------------------------------|---------------------------------|
| `ELASTICSEARCH_URL`   | Elasticsearch connection URL    | `http://elasticsearch:9200`     |
| `EVOLUTION_API_URL`   | Evolution API base URL          | `https://evolution.example.com` |
| `EVOLUTION_API_KEY`   | Evolution API authentication key| `evo-key-...`                   |

### 5.8 Coolify Environment Configuration

In Coolify, environment variables are set per service in the service settings UI. Sensitive values (API keys, secrets, database passwords) should use Coolify's secret management -- they are stored encrypted and injected at runtime.

---

## 6. Local Development

### 6.1 Docker Compose (`docker/docker-compose.yml`)

```yaml
version: "3.8"

services:
  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch:8.17.0
    environment:
      - discovery.type=single-node
      - xpack.security.enabled=false
      - ES_JAVA_OPTS=-Xms512m -Xmx512m
    ports:
      - "9200:9200"
    volumes:
      - es-data:/usr/share/elasticsearch/data

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: ll5
      POSTGRES_USER: ll5
      POSTGRES_PASSWORD: ll5dev
    ports:
      - "5432:5432"
    volumes:
      - pg-data:/var/lib/postgresql/data

volumes:
  es-data:
  pg-data:
```

### 6.2 Running Locally

Infrastructure only (most common during development):

```bash
docker compose -f docker/docker-compose.yml up -d
```

Then run individual MCPs with their dev script:

```bash
# Terminal 1
cd packages/personal-knowledge && npm run dev

# Terminal 2
cd packages/gtd && npm run dev

# etc.
```

Each MCP's dev script uses `tsx --watch` or equivalent for hot reload. Local environment variables are loaded from `.env` files in each package directory (gitignored).

### 6.3 Production Reference Compose (`docker/docker-compose.prod.yml`)

This file mirrors the production Coolify setup for reference and local testing of the full stack with built images. It is not used by Coolify itself.

```yaml
version: "3.8"

services:
  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch:8.17.0
    environment:
      - discovery.type=single-node
      - xpack.security.enabled=false
      - ES_JAVA_OPTS=-Xms1g -Xmx1g
    volumes:
      - es-data:/usr/share/elasticsearch/data

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: ll5
      POSTGRES_USER: ll5
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - pg-data:/var/lib/postgresql/data

  personal-knowledge:
    image: ghcr.io/USERNAME/ll5-personal-knowledge:latest
    environment:
      - ELASTICSEARCH_URL=http://elasticsearch:9200
      - API_KEY=${MCP_API_KEY}
      - LOG_LEVEL=info
    depends_on:
      - elasticsearch

  gtd:
    image: ghcr.io/USERNAME/ll5-gtd:latest
    environment:
      - DATABASE_URL=postgresql://ll5:${POSTGRES_PASSWORD}@postgres:5432/ll5
      - API_KEY=${MCP_API_KEY}
      - LOG_LEVEL=info
    depends_on:
      - postgres

  awareness:
    image: ghcr.io/USERNAME/ll5-awareness:latest
    environment:
      - ELASTICSEARCH_URL=http://elasticsearch:9200
      - API_KEY=${MCP_API_KEY}
      - LOG_LEVEL=info
    depends_on:
      - elasticsearch

  google:
    image: ghcr.io/USERNAME/ll5-google:latest
    environment:
      - DATABASE_URL=postgresql://ll5:${POSTGRES_PASSWORD}@postgres:5432/ll5
      - GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}
      - GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}
      - GOOGLE_REDIRECT_URI=${GOOGLE_REDIRECT_URI}
      - ENCRYPTION_KEY=${ENCRYPTION_KEY}
      - API_KEY=${MCP_API_KEY}
      - LOG_LEVEL=info
    depends_on:
      - postgres

  messaging:
    image: ghcr.io/USERNAME/ll5-messaging:latest
    environment:
      - ELASTICSEARCH_URL=http://elasticsearch:9200
      - EVOLUTION_API_URL=${EVOLUTION_API_URL}
      - EVOLUTION_API_KEY=${EVOLUTION_API_KEY}
      - API_KEY=${MCP_API_KEY}
      - LOG_LEVEL=info
    depends_on:
      - elasticsearch

  gateway:
    image: ghcr.io/USERNAME/ll5-gateway:latest
    ports:
      - "3000:3000"
    environment:
      - ELASTICSEARCH_URL=http://elasticsearch:9200
      - GEOCODING_API_KEY=${GEOCODING_API_KEY}
      - WEBHOOK_TOKENS=${WEBHOOK_TOKENS}
      - LOG_LEVEL=info
    depends_on:
      - elasticsearch
      - postgres

volumes:
  es-data:
  pg-data:
```

---

## 7. Claude Code MCP Configuration

To connect Claude Code to the remote MCP servers, configure the MCP endpoints in the project settings.

### 7.1 Project-Level Configuration (`.claude/settings.json`)

```json
{
  "mcpServers": {
    "personal-knowledge": {
      "type": "streamable-http",
      "url": "https://mcp-knowledge.yourdomain.com/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_API_KEY}"
      }
    },
    "gtd": {
      "type": "streamable-http",
      "url": "https://mcp-gtd.yourdomain.com/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_API_KEY}"
      }
    },
    "awareness": {
      "type": "streamable-http",
      "url": "https://mcp-awareness.yourdomain.com/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_API_KEY}"
      }
    },
    "google": {
      "type": "streamable-http",
      "url": "https://mcp-google.yourdomain.com/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_API_KEY}"
      }
    },
    "messaging": {
      "type": "streamable-http",
      "url": "https://mcp-messaging.yourdomain.com/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_API_KEY}"
      }
    }
  }
}
```

The `${MCP_API_KEY}` references an environment variable set in the shell or in a `.env` file that Claude Code reads. This keeps secrets out of the committed config file.

### 7.2 Local Development Configuration

For local development, point to `localhost` URLs instead:

```json
{
  "mcpServers": {
    "personal-knowledge": {
      "type": "streamable-http",
      "url": "http://localhost:3001/mcp"
    },
    "gtd": {
      "type": "streamable-http",
      "url": "http://localhost:3002/mcp"
    }
  }
}
```

---

## 8. Database Initialization

### 8.1 Elasticsearch Index Setup

Each Elasticsearch-backed MCP is responsible for creating its own indices on startup. The initialization logic runs at server start, before the health endpoint returns healthy.

```typescript
// Pattern used by each ES-backed MCP
async function ensureIndices(client: ElasticsearchClient) {
  const indices = [
    { name: 'knowledge-entries', mappings: { /* ... */ } },
    // ...
  ];

  for (const index of indices) {
    const exists = await client.indices.exists({ index: index.name });
    if (!exists) {
      await client.indices.create({
        index: index.name,
        body: { mappings: index.mappings, settings: index.settings },
      });
    }
  }
}
```

This is idempotent -- safe to run on every startup.

### 8.2 PostgreSQL Migrations

PostgreSQL-backed MCPs (gtd, google) use a simple migration runner. Migration files are numbered SQL files in each package:

```
packages/gtd/migrations/
  001_create_projects.sql
  002_create_tasks.sql
  003_add_task_contexts.sql
```

The migration runner:

1. Creates a `migrations` table if it does not exist.
2. Reads all `*.sql` files from the migrations directory.
3. Skips any already recorded in the `migrations` table.
4. Runs pending migrations in order, within a transaction.
5. Records each completed migration.

This runs on server startup, same as the Elasticsearch initialization.

```sql
-- Migration table (created automatically)
CREATE TABLE IF NOT EXISTS migrations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  applied_at TIMESTAMP DEFAULT NOW()
);
```

### 8.3 First Deploy

On the very first deployment:

1. Start Elasticsearch and PostgreSQL first (they have no dependencies).
2. Start the MCP servers -- each will create its indices/tables on startup.
3. Start the gateway last (it depends on infrastructure being ready).

In Coolify, set `depends_on` relationships or simply start services in this order manually on first deploy. After the initial setup, order does not matter because all services retry connections on startup.

---

## 9. Health Checks

Every MCP server and the gateway expose a `GET /health` endpoint that returns:

```json
{
  "status": "ok",
  "service": "personal-knowledge",
  "uptime": 3600,
  "dependencies": {
    "elasticsearch": "connected"
  }
}
```

Or on failure:

```json
{
  "status": "degraded",
  "service": "personal-knowledge",
  "dependencies": {
    "elasticsearch": "disconnected"
  }
}
```

The Docker `HEALTHCHECK` instruction pings this endpoint. Coolify uses the container health status to determine if a deployment succeeded and to restart unhealthy containers.

---

## 10. Monitoring and Logging

### 10.1 Logging

All services log structured JSON to stdout:

```json
{"level":"info","service":"gtd","msg":"Server started","port":3000,"timestamp":"2026-03-27T10:00:00Z"}
{"level":"error","service":"gtd","msg":"Database connection failed","error":"ECONNREFUSED","timestamp":"2026-03-27T10:00:01Z"}
```

Coolify captures stdout/stderr from each container and makes logs available in its UI. No additional log aggregation is needed initially.

### 10.2 Monitoring

- **Container health**: Coolify monitors Docker health checks and shows status in the dashboard.
- **Resource usage**: Coolify shows CPU and memory usage per container.
- **Uptime**: the `/health` endpoint can be monitored by an external uptime checker (e.g., UptimeRobot, Uptime Kuma) for alerting.

### 10.3 Alerting (Optional Enhancement)

Deploy Uptime Kuma as an additional Coolify service to monitor all health endpoints and send notifications (email, Telegram, etc.) on failures.

---

## 11. Rollback Strategy

### 11.1 Image-Based Rollback

Every image is tagged with the git commit SHA alongside `latest`. To roll back:

1. Find the last known good commit SHA (from git log or GitHub).
2. In Coolify, change the service image tag from `latest` to the specific SHA:
   ```
   ghcr.io/USERNAME/ll5-gtd:abc1234
   ```
3. Redeploy the service.

### 11.2 Database Compatibility

All database migrations are additive only:

- New columns use `DEFAULT` values or are nullable.
- New tables and indices are independent.
- No columns or tables are dropped.

This ensures that rolling back the application code to an older version still works with the newer database schema. If a destructive migration is ever necessary, it should be handled as a separate, planned operation with its own rollback procedure.

### 11.3 Rollback Procedure

1. Identify the faulty service and the last good image tag.
2. Update the image tag in Coolify.
3. Redeploy.
4. Verify health endpoint returns `ok`.
5. Check logs for errors.

---

## 12. Security Considerations

- **No public database access**: Elasticsearch and PostgreSQL are only accessible on the internal Docker network.
- **TLS everywhere**: all external traffic goes through Traefik with auto-provisioned Let's Encrypt certificates.
- **API key authentication**: every MCP endpoint requires a valid bearer token.
- **Non-root containers**: all application containers run as a non-root user.
- **Secret management**: sensitive environment variables are stored encrypted in Coolify, never committed to the repository.
- **GHCR authentication**: Coolify authenticates to GHCR using a personal access token with `read:packages` scope, stored as a Coolify credential.

---

## 13. Implementation Order

1. **Docker**: write `Dockerfile.mcp` and `Dockerfile.gateway`, verify local builds work.
2. **Local compose**: write `docker-compose.yml`, verify the full stack runs locally.
3. **GitHub Actions**: write `build-and-push.yml`, verify images are pushed to GHCR.
4. **Coolify infrastructure**: set up Elasticsearch and PostgreSQL in Coolify.
5. **Coolify applications**: add each MCP and gateway service, configure environment variables.
6. **DNS and TLS**: configure subdomains pointing to the VPS, let Coolify/Traefik handle certificates.
7. **Claude Code config**: configure MCP endpoints in `.claude/settings.json`.
8. **Verify end-to-end**: connect Claude Code to remote MCPs, execute a tool call, confirm data flows through.
