# Docker, CI/CD, and Deployment Implementation Plan

Implementation plan for **Phase 4** (Dockerfiles + CI), **Phase 4.5** (Standalone→compose transition), and **Phase 5** (Compose + deploy) of the dual-run-variant migration.

**Scope owner**: DevOps Automator
**Depends on**: Phase 1 (shared content extraction) + Phase 3 (opencode repo creation)
**Coolify main stack UUID**: `xkkcc0g4o48kkcows8488so4`
**Old standalone agent Coolify app UUID**: `js8owk0g0cgog800ckc8ww0s`

---

## Phase 4: Dockerfiles + CI

### 4.1 Dockerfile.ll5-run-claude

**File**: `docker/Dockerfile.ll5-run-claude`

Build context is the ll5 repo root. CI checks out the variant repo (`ll5-run-claude-code`) to `variant-content/` before building. The `render-mcp-config.ts` script and `mcp-endpoints.json` come from the ll5 repo (shared content).

```dockerfile
# LL5 Claude Code variant agent image.
#
# Build context: ll5 repo root. CI checks out ll5-run-claude-code to
# variant-content/ before docker build. Shared content (CLAUDE.md, skills,
# prompts, mcp-endpoints.json) comes from packages/ll5-run-shared/ in ll5.
#
# Image tag: ghcr.io/arnonzamir/ll5-run-claude:latest
#
# Key design points:
#   - node:20-slim (Debian/glibc) — Claude Code CLI is exercised on glibc
#   - tmux: Claude Code requires a PTY for its TUI
#   - wget: healthcheck probes + render script HTTP checks
#   - HOME=/data/home: persisted via volume — stores onboarding bypass,
#     OAuth token, turn-context, posted-ledger
#   - ll5-server (NOT ll5 launcher): supervisor loop that pre-warms MCPs,
#     gathers opening context, relaunches claude --continue on autoheal kill
#   - No EXPOSE: Claude Code has no HTTP server (process-based healthcheck)
#   - MCP config rendered at build time from shared mcp-endpoints.json

FROM node:20-slim

# Claude Code requires a PTY (tmux) + wget for healthchecks/render script
RUN apt-get update && apt-get install -y --no-install-recommends \
      tmux wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI (subscription OAuth, not API key)
RUN npm install -g @anthropic-ai/claude-code

# tsx for render-mcp-config.ts build step
RUN npm install -g tsx

WORKDIR /workspace

# ---------- Shared content (from ll5 repo) ----------
COPY packages/ll5-run-shared/CLAUDE.md /workspace/CLAUDE.md
COPY packages/ll5-run-shared/skills/ /workspace/.claude/skills/
COPY packages/ll5-run-shared/prompts/ /workspace/prompts/
COPY packages/ll5-run-shared/mcp-endpoints.json /workspace/mcp-endpoints.json

# render-mcp-config.ts (from ll5 repo scripts/)
COPY scripts/render-mcp-config.ts /workspace/scripts/render-mcp-config.ts

# ---------- Variant-specific content (from ll5-run-claude-code repo) ----------
COPY variant-content/hooks/ /workspace/.claude/hooks/
COPY variant-content/channel/ /workspace/channel/
COPY variant-content/scripts/ /workspace/scripts/
COPY variant-content/ll5-server /workspace/ll5-server
COPY variant-content/tmux.conf /workspace/tmux.conf
COPY variant-content/.claude/agents/ /workspace/.claude/agents/
COPY variant-content/.mcp.reconcile.json /workspace/.mcp.reconcile.json
COPY variant-content/.mcp.narrate.json /workspace/.mcp.narrate.json
COPY variant-content/docker-entrypoint.sh /workspace/docker-entrypoint.sh
COPY variant-content/scripts/get-mcp-auth.sh /workspace/scripts/get-mcp-auth.sh

# ---------- Render MCP config from shared source-of-truth ----------
# Reads mcp-endpoints.json, emits .claude/settings.json with headersHelper
# pointing to get-mcp-auth.sh (emits Bearer + correlation-id headers).
RUN npx tsx /workspace/scripts/render-mcp-config.ts \
      --config /workspace/mcp-endpoints.json \
      --format claude \
      --output /workspace/.claude/settings.json

# ---------- Persistent $HOME ----------
# Stored on a volume: onboarding bypass (.claude.json), OAuth token
# (~/.ll5/token), turn-context, posted-ledger, claude.log
ENV HOME=/data/home
RUN mkdir -p /data/home/.ll5 /data/home/.claude

# ---------- Permissions ----------
RUN chmod +x /workspace/ll5-server \
             /workspace/docker-entrypoint.sh \
             /workspace/scripts/*.sh \
             /workspace/scripts/get-mcp-auth.sh

# ---------- Healthcheck: process-based (no HTTP server) ----------
# The entrypoint writes /workspace/healthcheck.sh on startup with the
# variant-specific probe. Compose's healthcheck calls it.
# Claude Code: pgrep claude + pgrep ll5-channel (both must be alive)

ENTRYPOINT ["/workspace/docker-entrypoint.sh"]
```

**Notes**:
- No `EXPOSE` — Claude Code has no HTTP server. Communication is via PG NOTIFY → channel bridge (SSE listener in `ll5-channel.mjs`).
- No multi-stage build — the variant content is scripts/configs, not compiled TypeScript. The `tsx` install is only for the `render-mcp-config.ts` RUN step.
- The `render-mcp-config.ts` COPY must come before the `variant-content/scripts/` COPY so both land in `/workspace/scripts/`. Docker COPY merges directory contents — `render-mcp-config.ts` is preserved.
- Runs as root (tmux + Claude Code need PTY access + $HOME volume ownership). The existing standalone agent also runs as root.

---

### 4.2 Dockerfile.ll5-run-opencode

**File**: `docker/Dockerfile.ll5-run-opencode`

```dockerfile
# LL5 opencode variant agent image.
#
# Build context: ll5 repo root. CI checks out ll5-run-opencode to
# variant-content/ before docker build. Shared content comes from
# packages/ll5-run-shared/ in ll5.
#
# Image tag: ghcr.io/arnonzamir/ll5-run-opencode:latest
#
# Key design points:
#   - node:20-slim (Debian/glibc)
#   - opencode CLI pinned (OPENCODE_VERSION build arg — pinned in Phase 2.5)
#   - No tmux: opencode runs as an HTTP server, not a TUI
#   - wget: healthcheck probes
#   - HOME=/data/home: persisted via volume — opencode state, session data
#   - EXPOSE 4096: opencode serve port (INTERNAL ONLY — not published in compose)
#   - MCP config rendered at build time from shared mcp-endpoints.json
#   - Plugin dependencies installed at build time

# Pinned in Phase 2.5 (P2.5-T1). Update after validating the vertical slice.
# Do NOT use `latest` — plugin API breaks between minor versions.
ARG OPENCODE_VERSION=0.6.10
FROM node:20-slim

ARG OPENCODE_VERSION
ENV OPENCODE_VERSION=${OPENCODE_VERSION}

# wget for healthchecks + ca-certificates for HTTPS to remote MCPs
RUN apt-get update && apt-get install -y --no-install-recommends \
      wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# opencode CLI — PINNED VERSION (not latest)
# Phase 2.5 validates event names + plugin API against this exact version.
# Bumping requires re-running all Phase 2.5 validations.
RUN npm install -g opencode-ai@${OPENCODE_VERSION}

# tsx for render-mcp-config.ts + worker scripts
RUN npm install -g tsx

WORKDIR /workspace

# ---------- Shared content (from ll5 repo) ----------
COPY packages/ll5-run-shared/CLAUDE.md /workspace/CLAUDE.md
COPY packages/ll5-run-shared/skills/ /workspace/.claude/skills/
COPY packages/ll5-run-shared/prompts/ /workspace/prompts/
COPY packages/ll5-run-shared/mcp-endpoints.json /workspace/mcp-endpoints.json

# render-mcp-config.ts (from ll5 repo scripts/)
COPY scripts/render-mcp-config.ts /workspace/scripts/render-mcp-config.ts

# ---------- Variant-specific content (from ll5-run-opencode repo) ----------
COPY variant-content/.opencode/ /workspace/.opencode/
COPY variant-content/scripts/ /workspace/scripts/
COPY variant-content/docker-entrypoint.sh /workspace/docker-entrypoint.sh

# ---------- Render MCP config from shared source-of-truth ----------
# Reads mcp-endpoints.json, emits an MCP-only fragment (NOT the full
# opencode.json — the variant repo's opencode.json has model/agent/plugin
# config that must NOT be overwritten). The entrypoint merges this fragment
# into the variant repo's opencode.json at startup.
RUN npx tsx /workspace/scripts/render-mcp-config.ts \
      --format opencode \
      --config /workspace/mcp-endpoints.json \
      --output /workspace/opencode-mcp-fragment.json

# ---------- Install plugin dependencies ----------
# .opencode/package.json lists the opencode SDK + any plugin deps.
COPY variant-content/.opencode/package.json /workspace/.opencode/package.json
RUN cd /workspace/.opencode && npm install --production

# ---------- Persistent $HOME ----------
# Stored on a volume: opencode state, session data, plugin state files
# (turn-context.json, posted-this-turn.jsonl, channel-health.json)
ENV HOME=/data/home
RUN mkdir -p /data/home

# ---------- Permissions ----------
RUN chmod +x /workspace/docker-entrypoint.sh \
             /workspace/scripts/*.ts

# ---------- Healthcheck: HTTP-based ----------
# The entrypoint writes /workspace/healthcheck.sh on startup.
# opencode: wget /health on port 4096.

# INTERNAL ONLY — compose does NOT publish this port.
# Gateway reaches the agent via http://agent:4096 on the Docker network.
EXPOSE 4096

ENTRYPOINT ["/workspace/docker-entrypoint.sh"]
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
```

**Notes**:
- `OPENCODE_VERSION` is a build arg defaulting to `0.6.10`. The exact version is pinned in Phase 2.5 (P2.5-T1). CI can override via `--build-arg OPENCODE_VERSION=...`.
- `EXPOSE 4096` is informational only. The compose file does NOT map this port to the host. The gateway reaches it via the internal Docker network (`http://agent:4096`).
- Plugin dependencies install from `.opencode/package.json` — this includes the opencode SDK and any plugin-specific deps.
- No tmux — opencode runs as an HTTP server, not a PTY-based TUI.

---

### 4.3 build-and-push.yml — Full Modified Workflow

**File**: `.github/workflows/build-and-push.yml`

Changes from current:
1. `on:` block: add `repository_dispatch`, `schedule` (weekly fallback), `agent_variant` input
2. `detect-changes`: add `run-claude` + `run-opencode` to package list; handle dispatch + schedule; detect `ll5-run-shared` + `render-mcp-config.ts` changes
3. `build` job: add variant repo checkout, Node step skip for `run-*`, Dockerfile selection for variants
4. `deploy` job: add agent env vars, agent image pull, agent health check

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
      agent_variant:
        description: 'Agent variant to build (claude or opencode). Overrides packages list.'
        required: false
        default: ''
  # Variant repo pushes trigger this via repository_dispatch.
  # The variant repo's CI sends: gh api -X POST /repos/arnonzamir/ll5/dispatches \
  #   -f event_type=variant-update -f client_payload[package]=run-claude
  repository_dispatch:
    types: [variant-update]
  # Weekly fallback rebuild — catches failed dispatches or stale images.
  # Monday 03:00 UTC (low traffic).
  schedule:
    - cron: '0 3 * * 1'

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
          # findhub-poller disabled 2026-06-03 (Find Hub locate requests were ringing devices)
          # run-claude / run-opencode: agent variants (Phase 4)
          PACKAGES=("personal-knowledge" "gtd" "awareness" "google" "messaging" "health" "gateway" "dashboard" "vault" "run-claude" "run-opencode")

          # On manual dispatch with specific packages, use those
          if [[ "${{ github.event_name }}" == "workflow_dispatch" && -n "${{ inputs.packages }}" ]]; then
            IFS=',' read -ra PACKAGES <<< "${{ inputs.packages }}"
          fi

          # On manual dispatch with agent_variant, build only that variant
          if [[ "${{ github.event_name }}" == "workflow_dispatch" && -n "${{ inputs.agent_variant }}" ]]; then
            PACKAGES=("run-${{ inputs.agent_variant }}")
          fi

          # On repository_dispatch (variant repo pushed), build that package
          if [[ "${{ github.event_name }}" == "repository_dispatch" ]]; then
            PKG="${{ github.event.client_payload.package }}"
            PACKAGES=("$PKG")
          fi

          # On schedule (weekly fallback), rebuild both variants
          if [[ "${{ github.event_name }}" == "schedule" ]]; then
            PACKAGES=("run-claude" "run-opencode")
          fi

          # On push, check which packages changed (shared changes trigger all)
          if [[ "${{ github.event_name }}" == "push" ]]; then
            CHANGED=$(git diff --name-only HEAD~1 HEAD)
            # packages/shared/ OR packages/ll5-run-shared/ OR docker/ OR
            # scripts/render-mcp-config.ts → rebuild everything
            SHARED_CHANGED=$(echo "$CHANGED" | grep -cE "packages/(shared|ll5-run-shared)/" || true)
            DOCKER_CHANGED=$(echo "$CHANGED" | grep -c "docker/" || true)
            RENDER_CHANGED=$(echo "$CHANGED" | grep -c "scripts/render-mcp-config.ts" || true)

            if [[ "$SHARED_CHANGED" -eq 0 && "$DOCKER_CHANGED" -eq 0 && "$RENDER_CHANGED" -eq 0 ]]; then
              FILTERED=()
              for pkg in "${PACKAGES[@]}"; do
                # Infra packages: check packages/$pkg/ directory
                if [[ "$pkg" != "run-claude" && "$pkg" != "run-opencode" ]]; then
                  if echo "$CHANGED" | grep -q "packages/$pkg/"; then
                    FILTERED+=("$pkg")
                  fi
                fi
              done
              if [[ ${#FILTERED[@]} -gt 0 ]]; then
                PACKAGES=("${FILTERED[@]}")
              else
                # No infra packages changed and no shared/docker/render changes
                # → nothing to build (variant packages have no in-repo source
                # to diff against; they're triggered by repository_dispatch)
                PACKAGES=()
              fi
            fi
          fi

          # Build JSON matrix (empty array if no packages to build)
          if [[ ${#PACKAGES[@]} -eq 0 ]]; then
            echo "matrix={\"package\":[]}" >> "$GITHUB_OUTPUT"
          else
            JSON=$(printf '%s\n' "${PACKAGES[@]}" | jq -R . | jq -sc '{package: .}')
            echo "matrix=$JSON" >> "$GITHUB_OUTPUT"
          fi

  compose-drift-check:
    # Detects manual edits to the on-host docker-compose.yml so we catch drift
    # before the next deploy resyncs from the repo. Runs in parallel with build —
    # NOT in `needs:` for the deploy job, so failure here is visible/loud but
    # doesn't block deploy (deploy itself re-sources the repo file, which is
    # exactly the corrective action).
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Fetch on-host compose file
        id: fetch
        uses: appleboy/scp-action@v0.1.7
        continue-on-error: true
        with:
          host: ${{ vars.SERVER_HOST }}
          username: root
          key: ${{ secrets.DEPLOY_SSH_KEY }}
          source: /data/coolify/services/${{ secrets.COOLIFY_SERVICE_UUID }}/docker-compose.yml
          target: /tmp/host-compose/
          strip_components: 5

      - name: Diff host compose against repo
        run: |
          HOST_FILE="/tmp/host-compose/docker-compose.yml"
          REPO_FILE="docker/docker-compose.prod.yml"

          if [ ! -f "$HOST_FILE" ]; then
            echo "::notice::No on-host compose file found at /data/coolify/services/<uuid>/docker-compose.yml."
            echo "::notice::This is expected on a first deploy ever, or after the host service dir was wiped."
            echo "::notice::Skipping drift check — the next deploy will scp the repo file into place."
            exit 0
          fi

          normalize() {
            sed -E 's/[[:space:]]+$//' "$1" \
              | grep -Ev '^[[:space:]]*#' \
              | grep -Ev '^[[:space:]]*$'
          }

          normalize "$HOST_FILE" > /tmp/host.norm
          normalize "$REPO_FILE" > /tmp/repo.norm

          if diff -q /tmp/host.norm /tmp/repo.norm > /dev/null; then
            echo "Compose files match (ignoring trailing whitespace, comments, blank lines)."
            exit 0
          fi

          echo "::error title=Compose drift detected::On-host docker-compose.yml differs from docker/docker-compose.prod.yml"
          echo ""
          echo "==================================================================="
          echo "DRIFT DETECTED: on-host compose != repo docker/docker-compose.prod.yml"
          echo "==================================================================="
          echo ""
          echo "Don't edit on-host compose. CI will overwrite it from the repo on"
          echo "next deploy anyway. If you need a hot patch, commit it to the repo"
          echo "and push — that's the only safe path."
          echo ""
          echo "Recovery procedure: see 'Recovery procedure (post-2026-05-18 outage)'"
          echo "in docs/HANDOFF.md."
          echo ""
          echo "First ~50 lines of unified diff (host -> repo):"
          echo "-------------------------------------------------------------------"
          diff -u /tmp/host.norm /tmp/repo.norm | head -n 50 || true
          echo "-------------------------------------------------------------------"
          exit 1

  build:
    needs: detect-changes
    runs-on: ubuntu-latest
    if: needs.detect-changes.outputs.matrix != ''
    permissions:
      contents: read
      packages: write
    strategy:
      matrix: ${{ fromJson(needs.detect-changes.outputs.matrix) }}
    steps:
      # Always checkout ll5 repo first (build context for all packages)
      - uses: actions/checkout@v4

      # For variant packages (run-*), checkout the variant repo into
      # variant-content/ — this is the COPY source in the Dockerfile.
      # Uses VARIANT_REPO_READ_PAT (repo scope), NOT GHCR_READ_PAT (packages scope).
      - name: Checkout variant repo
        if: startsWith(matrix.package, 'run-')
        uses: actions/checkout@v4
        with:
          repository: arnonzamir/ll5-${{ matrix.package }}-code
          path: variant-content
          token: ${{ secrets.VARIANT_REPO_READ_PAT }}

      # findhub-poller is Python; run-* packages are variant content (no Node
      # build needed — Dockerfile COPYs scripts/configs, render-mcp-config.ts
      # runs inside the Docker build with tsx).
      - name: Set up Node.js
        if: matrix.package != 'findhub-poller' && !startsWith(matrix.package, 'run-')
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'

      - name: Install dependencies
        if: matrix.package != 'findhub-poller' && !startsWith(matrix.package, 'run-')
        run: npm ci

      - name: Build shared package
        if: matrix.package != 'findhub-poller' && !startsWith(matrix.package, 'run-')
        run: npm run build --workspace=packages/shared

      - name: Typecheck target package
        if: matrix.package != 'findhub-poller' && !startsWith(matrix.package, 'run-')
        run: npx tsc --noEmit --project packages/${{ matrix.package }}/tsconfig.json

      - name: Build target package
        if: matrix.package != 'findhub-poller' && !startsWith(matrix.package, 'run-')
        run: npm run build --workspace=packages/${{ matrix.package }}

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
          case "${{ matrix.package }}" in
            gateway)
              echo "file=docker/Dockerfile.gateway" >> "$GITHUB_OUTPUT"
              echo "build_args=" >> "$GITHUB_OUTPUT" ;;
            findhub-poller)
              echo "file=packages/findhub-poller/Dockerfile" >> "$GITHUB_OUTPUT"
              echo "build_args=" >> "$GITHUB_OUTPUT" ;;
            dashboard)
              echo "file=docker/Dockerfile.dashboard" >> "$GITHUB_OUTPUT"
              echo "build_args=BUILD_ID=${GITHUB_SHA::7}" >> "$GITHUB_OUTPUT" ;;
            vault)
              echo "file=docker/Dockerfile.vault" >> "$GITHUB_OUTPUT"
              echo "build_args=" >> "$GITHUB_OUTPUT" ;;
            run-claude)
              echo "file=docker/Dockerfile.ll5-run-claude" >> "$GITHUB_OUTPUT"
              echo "build_args=" >> "$GITHUB_OUTPUT" ;;
            run-opencode)
              echo "file=docker/Dockerfile.ll5-run-opencode" >> "$GITHUB_OUTPUT"
              echo "build_args=OPENCODE_VERSION=${{ secrets.OPENCODE_VERSION || '0.6.10' }}" >> "$GITHUB_OUTPUT" ;;
            *)
              echo "file=docker/Dockerfile.mcp" >> "$GITHUB_OUTPUT"
              echo "build_args=PACKAGE_NAME=${{ matrix.package }}" >> "$GITHUB_OUTPUT" ;;
          esac

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

  deploy:
    needs: build
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main' || github.event_name == 'repository_dispatch'
    steps:
      - uses: actions/checkout@v4

      - name: Copy compose to server (repo is source of truth)
        uses: appleboy/scp-action@v0.1.7
        with:
          host: ${{ vars.SERVER_HOST }}
          username: root
          key: ${{ secrets.DEPLOY_SSH_KEY }}
          source: docker/docker-compose.prod.yml
          target: /data/coolify/services/${{ secrets.COOLIFY_SERVICE_UUID }}/
          strip_components: 1
          overwrite: true

      - name: Deploy to server
        uses: appleboy/ssh-action@v1
        env:
          # MUST be the non-expiring read:packages PAT, NOT secrets.GITHUB_TOKEN.
          GHCR_TOKEN: ${{ secrets.GHCR_READ_PAT }}
          # findhub-poller secrets
          FINDHUB_WEBHOOK_TOKEN: ${{ secrets.FINDHUB_WEBHOOK_TOKEN }}
          FINDHUB_SECRETS_B64: ${{ secrets.FINDHUB_SECRETS_B64 }}
          FINDHUB_DEVICE_TYPES: ${{ secrets.FINDHUB_DEVICE_TYPES }}
          # ES auth
          ELASTIC_PASSWORD: ${{ secrets.ELASTIC_PASSWORD }}
          # Vault MCP machine-account secrets (DECISION-022)
          BW_CLIENTID: ${{ secrets.BW_CLIENTID }}
          BW_CLIENTSECRET: ${{ secrets.BW_CLIENTSECRET }}
          BW_PASSWORD: ${{ secrets.BW_PASSWORD }}
          # WhatsApp ingest queue + dedicated in-stack Evolution (DECISION-024)
          RABBITMQ_PASSWORD: ${{ secrets.RABBITMQ_PASSWORD }}
          EVOLUTION_GLOBAL_KEY: ${{ secrets.EVOLUTION_GLOBAL_KEY }}
          # ---- Agent variant (Phase 4/5) ----
          # Claude Code variant: subscription OAuth token (NOT ANTHROPIC_API_KEY).
          # The agent's entrypoint writes this to ~/.ll5/token.
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          # opencode variant: Zen API key for model access.
          OPENCODE_ZEN_API_KEY: ${{ secrets.OPENCODE_ZEN_API_KEY }}
          # Variant selection: "claude" or "opencode". Default: claude.
          AGENT_VARIANT: ${{ secrets.AGENT_VARIANT || 'claude' }}
        with:
          host: ${{ vars.SERVER_HOST }}
          username: root
          key: ${{ secrets.DEPLOY_SSH_KEY }}
          envs: GHCR_TOKEN,FINDHUB_WEBHOOK_TOKEN,FINDHUB_SECRETS_B64,FINDHUB_DEVICE_TYPES,ELASTIC_PASSWORD,BW_CLIENTID,BW_CLIENTSECRET,BW_PASSWORD,RABBITMQ_PASSWORD,EVOLUTION_GLOBAL_KEY,CLAUDE_CODE_OAUTH_TOKEN,OPENCODE_ZEN_API_KEY,AGENT_VARIANT
          command_timeout: 15m
          script: |
            echo "$GHCR_TOKEN" | docker login ghcr.io -u arnonzamir --password-stdin
            cd /data/coolify/services/${{ secrets.COOLIFY_SERVICE_UUID }}
            # Move the scp'd file into place atomically
            if [ -f docker-compose.prod.yml ]; then
              mv docker-compose.prod.yml docker-compose.yml
            fi

            # ===== Inject findhub-poller env (idempotent) =====
            if [ -n "$FINDHUB_WEBHOOK_TOKEN" ]; then
              touch .env
              grep -v '^FINDHUB_' .env > .env.findhub.tmp 2>/dev/null || true
              mv .env.findhub.tmp .env
              {
                printf 'FINDHUB_WEBHOOK_TOKEN=%s\n' "$FINDHUB_WEBHOOK_TOKEN"
                printf 'FINDHUB_SECRETS_B64=%s\n' "$FINDHUB_SECRETS_B64"
                printf "FINDHUB_DEVICE_TYPES='%s'\n" "$FINDHUB_DEVICE_TYPES"
              } >> .env
              echo "Injected FINDHUB_* into .env"
            else
              echo "WARN: FINDHUB_WEBHOOK_TOKEN secret empty — leaving .env untouched"
            fi

            # ===== Inject vault MCP machine-account secrets (idempotent) =====
            if [ -n "$BW_CLIENTID" ]; then
              touch .env
              grep -v '^BW_' .env > .env.bw.tmp 2>/dev/null || true
              mv .env.bw.tmp .env
              {
                printf 'BW_CLIENTID=%s\n' "$BW_CLIENTID"
                printf 'BW_CLIENTSECRET=%s\n' "$BW_CLIENTSECRET"
                printf 'BW_PASSWORD=%s\n' "$BW_PASSWORD"
              } >> .env
              echo "Injected BW_* into .env"
            else
              echo "WARN: BW_CLIENTID secret empty — vault MCP will run unconfigured"
            fi

            # ===== Inject ELASTIC_PASSWORD (idempotent) =====
            if [ -n "$ELASTIC_PASSWORD" ]; then
              touch .env
              grep -v '^ELASTIC_PASSWORD=' .env > .env.es.tmp 2>/dev/null || true
              mv .env.es.tmp .env
              printf 'ELASTIC_PASSWORD=%s\n' "$ELASTIC_PASSWORD" >> .env
              echo "Injected ELASTIC_PASSWORD into .env"
            else
              echo "WARN: ELASTIC_PASSWORD secret empty — leaving .env untouched"
            fi

            # ===== Inject WhatsApp ingest queue + Evolution secrets (idempotent) =====
            if [ -n "$RABBITMQ_PASSWORD" ]; then
              touch .env
              grep -v -E '^(RABBITMQ_PASSWORD|EVOLUTION_API_KEY|EVOLUTION_GLOBAL_KEY)=' .env > .env.wa.tmp 2>/dev/null || true
              mv .env.wa.tmp .env
              {
                printf 'RABBITMQ_PASSWORD=%s\n' "$RABBITMQ_PASSWORD"
                printf 'EVOLUTION_GLOBAL_KEY=%s\n' "$EVOLUTION_GLOBAL_KEY"
              } >> .env
              echo "Injected RABBITMQ_PASSWORD + EVOLUTION_GLOBAL_KEY into .env"
            else
              echo "WARN: RABBITMQ_PASSWORD secret empty — WhatsApp queue will run without a broker (inline fallback)"
            fi

            # ===== Inject agent variant env (idempotent) — Phase 4/5 =====
            # AGENT_VARIANT: selects which agent image to run ("claude" or "opencode").
            # OPENCODE_SERVER_URL: derived from AGENT_VARIANT — NOT set independently.
            #   This makes rollback truly single-var: change AGENT_VARIANT, deploy.
            #   opencode → http://agent:4096 (gateway triggers agent via HTTP)
            #   claude   → empty (gateway uses PG NOTIFY → channel bridge flow)
            AGENT_VARIANT="${AGENT_VARIANT:-claude}"
            if [ "$AGENT_VARIANT" = "opencode" ]; then
              OPC_URL="http://agent:4096"
            else
              OPC_URL=""
            fi
            touch .env
            grep -v -E '^(AGENT_VARIANT|OPENCODE_SERVER_URL|CLAUDE_CODE_OAUTH_TOKEN|OPENCODE_ZEN_API_KEY)=' .env > .env.agent.tmp 2>/dev/null || true
            mv .env.agent.tmp .env
            {
              printf 'AGENT_VARIANT=%s\n' "$AGENT_VARIANT"
              printf 'OPENCODE_SERVER_URL=%s\n' "$OPC_URL"
              printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$CLAUDE_CODE_OAUTH_TOKEN"
              printf 'OPENCODE_ZEN_API_KEY=%s\n' "$OPENCODE_ZEN_API_KEY"
            } >> .env
            echo "Injected AGENT_VARIANT=$AGENT_VARIANT OPENCODE_SERVER_URL=$OPC_URL into .env"

            # Ensure the dedicated Evolution's database exists (idempotent)
            docker exec postgres-${{ secrets.COOLIFY_SERVICE_UUID }} psql -U "${POSTGRES_USER:-ll5}" -d "${POSTGRES_DB:-ll5}" -tc "SELECT 1 FROM pg_database WHERE datname='evolution'" 2>/dev/null | grep -q 1 \
              || docker exec postgres-${{ secrets.COOLIFY_SERVICE_UUID }} psql -U "${POSTGRES_USER:-ll5}" -d "${POSTGRES_DB:-ll5}" -c 'CREATE DATABASE evolution OWNER '"${POSTGRES_USER:-ll5}"';' 2>/dev/null || true

            # ===== Pull GHCR-built images (never databases or third-party) =====
            for img in gateway dashboard personal-knowledge gtd awareness google messaging health vault; do
              docker pull ghcr.io/arnonzamir/ll5-$img:latest 2>/dev/null || true
            done
            # Pull the selected agent variant image
            docker pull ghcr.io/arnonzamir/ll5-run-${AGENT_VARIANT}:latest 2>/dev/null || true

            # NEVER use --remove-orphans here. On 2026-05-18 a --remove-orphans run
            # destroyed 7 manually-started containers that weren't in the compose.
            docker compose up -d

            # ===== Agent health check =====
            sleep 10
            AGENT_STATUS=$(docker compose ps agent --format json 2>/dev/null | jq -r '.State' 2>/dev/null || echo "unknown")
            if [ "$AGENT_STATUS" = "running" ]; then
              echo "Agent container running (variant: $AGENT_VARIANT)"
            else
              echo "::error::Agent container not running (status: $AGENT_STATUS, variant: $AGENT_VARIANT)"
              docker compose logs agent --tail 50 2>/dev/null || true
            fi

      - name: Health check
        run: |
          sleep 15
          for i in 1 2 3 4; do
            STATUS=$(curl -s -o /dev/null -w '%{http_code}' https://mcp-knowledge.noninoni.click/health 2>/dev/null || echo "000")
            echo "Health check attempt $i: HTTP $STATUS"
            if [ "$STATUS" = "200" ]; then
              echo "Deploy successful"
              exit 0
            fi
            sleep 10
          done
          echo "Warning: health check did not return 200, but containers may still be starting"
```

**Key changes explained**:

| Change | Why |
|---|---|
| `repository_dispatch` trigger | Variant repos (ll5-run-claude-code, ll5-run-opencode) push → trigger rebuild in ll5 |
| `schedule` cron (weekly Monday 03:00 UTC) | Fallback rebuild catches failed dispatches or stale cache |
| `agent_variant` workflow_dispatch input | Manual override to build/deploy a specific variant |
| `run-claude`/`run-opencode` in package list | Matrix packages named so image tags become `ll5-run-claude`/`ll5-run-opencode` (correct) |
| `startsWith(matrix.package, 'run-')` skip conditions | Node build steps crash on variant packages (no root `package.json` for them) |
| Variant repo checkout with `VARIANT_REPO_READ_PAT` | Needs `repo` scope (not `read:packages` like `GHCR_READ_PAT`) |
| `OPENCODE_VERSION` build arg from secret | Pinned version from Phase 2.5; overridable without code change |
| `ll5-run-shared` + `render-mcp-config.ts` change detection | Shared content changes trigger both variant rebuilds |
| Empty matrix handling | `repository_dispatch` or `schedule` with no changes → skip build job |
| Deploy `if` includes `repository_dispatch` | Variant repo pushes trigger full deploy (only agent container recreates in steady state) |

---

### 4.4 GitHub Secrets/Variables

Add these to the `arnonzamir/ll5` repository (Settings → Secrets and variables → Actions):

#### New Secrets

| Secret name | Purpose | Scope | Example |
|---|---|---|---|
| `VARIANT_REPO_READ_PAT` | Read access to variant repos (`ll5-run-claude-code`, `ll5-run-opencode`) for CI checkout. Needs `repo` scope (classic PAT) or `contents:read` (fine-grained). **NOT** `GHCR_READ_PAT` — that only has `read:packages`. | Build job: variant repo checkout | `ghp_...` or `github_pat_...` |
| `LL5_DISPATCH_PAT` | Token used by variant repos to trigger `repository_dispatch` on ll5. Needs `repo` scope on `arnonzamir/ll5`. Stored in the **variant repo** secrets, not here — but listed for completeness. | Variant repo CI → ll5 dispatch | `ghp_...` |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code subscription OAuth token. The agent entrypoint writes this to `~/.ll5/token`. **NOT** `ANTHROPIC_API_KEY` — this is a subscription token, not an API key. | Deploy job: injected into .env, read by agent container | `sk-ant-oat01-...` |
| `OPENCODE_ZEN_API_KEY` | opencode Zen API key for model access (opencode variant only). Empty when running Claude Code variant. | Deploy job: injected into .env, read by agent container | `zen-...` |
| `AGENT_VARIANT` | Default agent variant selection: `claude` or `opencode`. If absent, deploy script defaults to `claude`. | Deploy job: injected into .env | `claude` |
| `OPENCODE_VERSION` | Pinned opencode CLI version (build arg). Determined in Phase 2.5 (P2.5-T1). If absent, Dockerfile defaults to `0.6.10`. | Build job: `run-opencode` Docker build arg | `0.6.10` |

#### Existing Secrets (unchanged)

| Secret | Status |
|---|---|
| `GHCR_READ_PAT` | Unchanged — still used for `docker login` in deploy. **Does NOT replace `VARIANT_REPO_READ_PAT`** (different scope). |
| `DEPLOY_SSH_KEY` | Unchanged |
| `COOLIFY_SERVICE_UUID` | Unchanged (`xkkcc0g4o48kkcows8488so4`) |
| `ELASTIC_PASSWORD` | Unchanged |
| `BW_CLIENTID` / `BW_CLIENTSECRET` / `BW_PASSWORD` | Unchanged |
| `FINDHUB_*` | Unchanged |
| `RABBITMQ_PASSWORD` / `EVOLUTION_GLOBAL_KEY` | Unchanged |

#### GitHub Variables (Settings → Secrets and variables → Actions → Variables)

| Variable name | Purpose | Example |
|---|---|---|
| `SERVER_HOST` | Already exists — SSH host for deploy | (unchanged) |

No new variables required. `AGENT_VARIANT` is a secret (not a variable) because it controls deployment behavior and should not be visible in plain text in workflow logs.

#### Variant Repo Secrets (for reference — set in `ll5-run-claude-code` and `ll5-run-opencode` repos)

| Secret | Purpose |
|---|---|
| `LL5_DISPATCH_PAT` | Token to call `gh api -X POST /repos/arnonzamir/ll5/dispatches -f event_type=variant-update -f client_payload[package]=run-claude` |

---

## Phase 4.5: Standalone → Compose Transition

**This is the highest-risk operational step in the entire migration.**

The agent currently runs as a **separate Coolify app** (UUID `js8owk0g0cgog800ckc8ww0s`) with its own compose, its own image (`ghcr.io/arnonzamir/ll5-agent:latest`), and its own workspace volume. It is NOT in `docker-compose.prod.yml`.

After Phase 4, the new `ll5-run-claude` image is in GHCR. After Phase 5 (compose changes), the `agent` service is in `docker-compose.prod.yml`. Phase 4.5 is the transition: move the agent from standalone to compose.

**Prerequisite**: Phase 4 complete (both images build + push to GHCR). Phase 5's compose changes must be merged and deployed (the `agent` service block must be in the on-host `docker-compose.yml`).

### 4.5.1 Step-by-Step Procedure

All commands run on the production host via SSH as root.

#### Step 1: Identify the old standalone agent container + volume

```bash
# SSH to the host
ssh root@<SERVER_HOST>

# Find the old standalone agent container
docker ps --filter "name=agent" --format "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}"

# Expected: a container from Coolify app js8owk0g0cgog800ckc8ww0s
# Image: ghcr.io/arnonzamir/ll5-agent:latest
# Container name: something like <uuid>-agent-<hash> or agent-js8owk0g0cgog800ckc8ww0s

# Identify the old workspace volume
docker inspect <OLD_CONTAINER_ID> --format '{{json .Mounts}}' | jq '.[] | select(.Destination=="/workspace" or .Destination=="/workspace/ll5-run")'
# Note the Source volume name — this is the old workspace data to migrate.
```

#### Step 2: Stop the old standalone agent container

```bash
# Stop the old container (Coolify may restart it — see Step 4)
docker stop <OLD_CONTAINER_ID>

# Verify it's stopped
docker ps --filter "name=agent" --format "{{.ID}}\t{{.Names}}\t{{.Status}}"
# Expected: no agent container running (or the old one shows "Exited")
```

#### Step 3: Migrate workspace data to the new volume

The new compose uses a named volume `xkkcc0g4o48kkcows8488so4_agent-workspace-claude`. We need to copy the workspace data from the old volume to the new one.

```bash
# Get the old volume name (from Step 1)
OLD_VOLUME="<old-volume-name-from-step-1>"
NEW_VOLUME="xkkcc0g4o48kkcows8488so4_agent-workspace-claude"

# Create the new volume if it doesn't exist yet
docker volume create "$NEW_VOLUME" 2>/dev/null || true

# Copy workspace data using a throwaway alpine container
# -a preserves permissions/timestamps
docker run --rm \
  -v "$OLD_VOLUME:/from:ro" \
  -v "$NEW_VOLUME:/to" \
  alpine sh -c "cp -a /from/. /to/"

# Verify file count matches
OLD_COUNT=$(docker run --rm -v "$OLD_VOLUME:/from:ro" alpine sh -c "find /from -type f | wc -l")
NEW_COUNT=$(docker run --rm -v "$NEW_VOLUME:/to:ro" alpine sh -c "find /to -type f | wc -l")
echo "Old volume file count: $OLD_COUNT"
echo "New volume file count: $NEW_COUNT"
if [ "$OLD_COUNT" != "$NEW_COUNT" ]; then
  echo "::error::File count mismatch — investigate before proceeding"
  exit 1
fi
echo "Workspace data migrated successfully"
```

Also migrate `$HOME` data (onboarding bypass, token, turn-context, posted-ledger):

```bash
# The old container may have $HOME data on a separate volume or bind mount.
# Check the old container's mounts for /data/home or similar.
docker inspect <OLD_CONTAINER_ID> --format '{{json .Mounts}}' | jq '.[] | select(.Destination=="/data/home" or .Destination=="/home/node")'

# If $HOME data exists on the old volume, copy it to the new agent-home volume
OLD_HOME_VOLUME="<old-home-volume-if-exists>"
NEW_HOME_VOLUME="xkkcc0g4o48kkcows8488so4_agent-home"
docker volume create "$NEW_HOME_VOLUME" 2>/dev/null || true
if [ -n "$OLD_HOME_VOLUME" ]; then
  docker run --rm \
    -v "$OLD_HOME_VOLUME:/from:ro" \
    -v "$NEW_HOME_VOLUME:/to" \
    alpine sh -c "cp -a /from/. /to/"
  echo "Home data migrated to $NEW_HOME_VOLUME"
fi
```

#### Step 4: Remove the old standalone agent container

```bash
# Remove the old container
docker rm <OLD_CONTAINER_ID>

# Verify it's gone
docker ps -a --filter "name=agent" --format "{{.ID}}\t{{.Names}}\t{{.Status}}"
# Expected: no old agent container in the list
```

#### Step 5: Decommission the old Coolify app

**This is critical**: if Coolify restarts the old app, two agent containers will run simultaneously — both respond to PG NOTIFY, causing duplicate messages. This is the most dangerous silent failure in the plan.

```bash
# Option A: Delete the Coolify app via CLI (if available)
coolify app:delete js8owk0g0cgog800ckc8ww0s

# Option B: Via Coolify UI
# 1. Open Coolify dashboard
# 2. Find the app with UUID js8owk0g0cgog800ckc8ww0s (the standalone agent)
# 3. Settings → Delete Resource (NOT just stop — delete prevents auto-restart)
# 4. Confirm deletion
```

**Critical check**: After deletion, monitor for 30 minutes:

```bash
# Run this immediately after deletion, then again at 5min, 15min, 30min
docker ps --filter "name=agent" --format "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}"
# Expected: either NO agent container (before compose deploy) or ONLY the
# compose agent (after deploy). If the old container reappears, Coolify
# restarted it — the app was not properly deleted. Delete it again and
# check Coolify's "Auto Deploy" / "Force Docker Cleanup" settings.
```

#### Step 6: Verify only one agent container exists

```bash
# After deploying with compose (Step 7 below), verify:
docker ps --filter "name=agent" --format "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}"
# Expected: exactly ONE container:
#   agent-xkkcc0g4o48kkcows8488so4  ghcr.io/arnonzamir/ll5-run-claude:latest  Up
#
# If TWO containers exist: STOP IMMEDIATELY. The old Coolify app is still
# running. Delete it before proceeding.
```

#### Step 7: Deploy with AGENT_VARIANT=claude via compose

The compose changes (Phase 5) must already be merged and the `agent` service block present in the on-host `docker-compose.yml`. The deploy happens via the normal CI pipeline (push to main triggers `build-and-push.yml`).

```bash
# Ensure .env has AGENT_VARIANT=claude (the deploy script injects this, but
# verify manually for the transition):
cd /data/coolify/services/xkkcc0g4o48kkcows8488so4
grep '^AGENT_VARIANT=' .env
# Expected: AGENT_VARIANT=claude

# Pull the agent image
docker pull ghcr.io/arnonzamir/ll5-run-claude:latest

# Bring up the stack (this starts the agent service for the first time)
docker compose up -d

# Verify the agent container started
docker compose ps agent
# Expected: agent-xkkcc0g4o48kkcows8488so4  Up  (healthy)
```

### 4.5.2 Verification: Claude Code variant end-to-end via compose

After the compose deploy, verify the Claude Code agent works:

```bash
# 1. Container is running + healthy
docker compose ps agent
# Expected: "Up (healthy)" or "Up" within 45s start_period

# 2. Agent logs show startup sequence
docker compose logs agent --tail 100
# Expected: tmux session started, ll5-server running, channel bridge connected,
# MCP connections pre-warmed

# 3. Claude Code process is alive (process-based healthcheck)
docker exec agent-xkkcc0g4o48kkcows8488so4 pgrep -f "claude" > /dev/null && echo "claude: alive" || echo "claude: DEAD"
docker exec agent-xkkcc0g4o48kkcows8488so4 pgrep -f "ll5-channel" > /dev/null && echo "channel: alive" || echo "channel: DEAD"

# 4. Send a test message and verify the agent responds
# Via the gateway API or WhatsApp — send a simple message
# Check that the agent processes it (appears in claude.log)
docker exec agent-xkkcc0g4o48kkcows8488so4 tail -20 /data/home/.ll5/claude.log

# 5. MCP tools work (channel bridge can reach all 6 remote MCPs)
docker exec agent-xkkcc0g4o48kkcows8488so4 cat /workspace/channel-health.json
# Expected: all 6 MCPs show "healthy"

# 6. Audit log has correlation-ids (DECISION-012)
# Check the gateway's audit log for recent entries with session_id + trace_id
docker exec postgres-xkkcc0g4o48kkcows8488so4 psql -U ll5 -d ll5 -c \
  "SELECT session_id, trace_id, created_at FROM ll5_audit_log ORDER BY created_at DESC LIMIT 5;"
# Expected: recent rows with non-null session_id and trace_id

# 7. Only one agent container (the compose one)
docker ps --filter "name=agent" --format "{{.Names}}"
# Expected: agent-xkkcc0g4o48kkcows8488so4 (ONLY this one)
```

### 4.5.3 Rollback

If something goes wrong during the transition:

```bash
# 1. Stop the compose agent
cd /data/coolify/services/xkkcc0g4o48kkcows8488so4
docker compose stop agent

# 2. Re-enable the old Coolify app (if it was deleted, recreate it)
# Via Coolify UI: Create new resource → Docker Image →
#   ghcr.io/arnonzamir/ll5-agent:latest
# Configure with the same env vars + volume as before.

# 3. If the old container was not yet removed (Step 4 not done):
docker start <OLD_CONTAINER_ID>

# 4. Verify the old agent is running and responding
docker ps --filter "name=agent" --format "{{.Names}}\t{{.Status}}"
# Send a test message, verify agent responds

# 5. Investigate what went wrong with the compose agent
docker compose logs agent --tail 200
```

**Rollback safety**: The old standalone setup is the fallback. The workspace data was COPIED (not moved) to the new volume, so the old volume still has the original data. The old Coolify app can be re-enabled if the compose agent fails.

---

## Phase 5: Compose + Deploy

### 5.1 docker-compose.prod.yml: Agent Service Block

Add this service to `docker/docker-compose.prod.yml` (after the `vault` service, before the end of `services:`):

```yaml
  # ---------- Agent (variant-selectable) ----------
  # Runs the Claude Code or opencode variant, selected by AGENT_VARIANT.
  # Migrated from standalone Coolify app (js8owk0g0cgog800ckc8ww0s) to compose
  # in Phase 4.5. The agent is INTERNAL ONLY — no Traefik route, no published
  # port. The gateway reaches it at http://agent:4096 (opencode) or via
  # PG NOTIFY → channel bridge (Claude Code).
  agent:
    <<: *defaults
    image: ghcr.io/arnonzamir/ll5-run-${AGENT_VARIANT:-claude}:latest
    container_name: agent-xkkcc0g4o48kkcows8488so4
    environment:
      NODE_ENV: production
      TZ: ${TZ:-Asia/Jerusalem}
      # Gateway URL (internal Docker network)
      GATEWAY_URL: http://gateway:3000
      # MCP base domain for endpoint URLs
      MCP_BASE_DOMAIN: ${MCP_BASE_DOMAIN:-noninoni.click}
      API_KEY: ${API_KEY}
      USER_ID: ${USER_ID}
      # Claude Code variant: subscription OAuth token (NOT ANTHROPIC_API_KEY).
      # The entrypoint writes this to ~/.ll5/token. Empty when variant=opencode.
      CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN:-}
      # opencode variant: Zen API key for model access.
      # Empty when variant=claude.
      OPENCODE_ZEN_API_KEY: ${OPENCODE_ZEN_API_KEY:-}
    volumes:
      # Variant-specific workspace (NOT shared — stale state on variant switch)
      - agent-workspace-${AGENT_VARIANT:-claude}:/workspace
      # Persistent $HOME: onboarding bypass, OAuth token, turn-context,
      # posted-ledger, claude.log, opencode session data
      - agent-home:/data/home
    # NO ports published — internal Docker network only.
    # Gateway reaches http://agent:4096 for opencode variant.
    # Claude Code variant has no HTTP server (PG NOTIFY flow).
    depends_on:
      gateway:
        condition: service_healthy
    deploy:
      resources:
        limits:
          memory: 1024M
          cpus: "1.0"
    healthcheck:
      # Variant-specific: the entrypoint writes /workspace/healthcheck.sh
      # on startup. Claude Code: process-based (pgrep). opencode: HTTP probe.
      test: ["CMD-SHELL", "/workspace/healthcheck.sh || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 45s
    labels:
      # Prevent Coolify from auto-exposing the agent via Traefik.
      # The agent is internal-only — no public domain, no TLS cert.
      - "traefik.enable=false"
```

Add the volumes to the `volumes:` section:

```yaml
volumes:
  es-data:
    name: xkkcc0g4o48kkcows8488so4_es-data
    external: true
  pg-data:
    name: xkkcc0g4o48kkcows8488so4_pg-data
    external: true
  rabbitmq-data:
    name: xkkcc0g4o48kkcows8488so4_rabbitmq-data
  evolution-instances:
    name: xkkcc0g4o48kkcows8488so4_evolution-instances
  # Agent variant-specific workspace (Phase 4/5)
  agent-workspace-claude:
    name: xkkcc0g4o48kkcows8488so4_agent-workspace-claude
  agent-workspace-opencode:
    name: xkkcc0g4o48kkcows8488so4_agent-workspace-opencode
  # Agent persistent $HOME (shared across variants — onboarding bypass,
  # token, turn-context, posted-ledger are variant-agnostic)
  agent-home:
    name: xkkcc0g4o48kkcows8488so4_agent-home
```

**Design decisions**:

| Decision | Rationale |
|---|---|
| `image: ghcr.io/arnonzamir/ll5-run-${AGENT_VARIANT:-claude}:latest` | Parameterized by variant. Default `claude` for safety (current production variant). |
| `agent-workspace-${AGENT_VARIANT}` volume | Variant-specific — stale state on switch. Claude and opencode have completely different workspace structures. |
| `agent-home` shared volume | `$HOME` content (onboarding bypass, token) is variant-agnostic. Sharing avoids re-onboarding on variant switch. |
| NO `ports:` | Port 4096 is internal only. Publishing to host would expose the opencode server publicly. |
| `traefik.enable=false` | Prevents Coolify from auto-creating a Traefik route. The agent must not be publicly reachable. |
| `depends_on: gateway service_healthy` | Agent needs the gateway up (auth, chat endpoints, MCP proxying). |
| `start_period: 45s` | Claude Code supervisor + MCP pre-warm + channel bridge startup takes 20-30s. |
| 1024M memory limit | Claude Code + tmux + channel bridge + MCP connections. Current standalone has 2GB; 1GB is lean but sufficient. Monitor and adjust. |

---

### 5.2 Gateway Env Additions

Add `OPENCODE_SERVER_URL` to the gateway service's `environment` block in `docker/docker-compose.prod.yml`:

```yaml
  gateway:
    <<: *defaults
    image: ghcr.io/arnonzamir/ll5-gateway:latest
    container_name: gateway-xkkcc0g4o48kkcows8488so4
    environment:
      # ... existing env vars unchanged ...
      MCP_BASE_DOMAIN: ${MCP_BASE_DOMAIN:-noninoni.click}
      # Agent trigger (opencode variant only; empty = Claude Code NOTIFY flow)
      # Derived from AGENT_VARIANT in deploy script — NOT set independently.
      # This ensures single-var rollback: change AGENT_VARIANT → OPENCODE_SERVER_URL
      # auto-derives → deploy. No separate var to forget.
      #   opencode → http://agent:4096 (gateway triggers agent via HTTP POST)
      #   claude   → empty (gateway uses PG NOTIFY → channel bridge flow)
      OPENCODE_SERVER_URL: ${OPENCODE_SERVER_URL:-}
      ORCHESTRATOR_URL: ${ORCHESTRATOR_URL:-}
      ORCHESTRATOR_SECRET: ${ORCHESTRATOR_SECRET:-}
      # ... rest of existing env vars unchanged ...
```

**Why derived, not independent**: If `OPENCODE_SERVER_URL` were set independently of `AGENT_VARIANT`, a rollback that changes `AGENT_VARIANT=opencode` → `AGENT_VARIANT=claude` without also clearing `OPENCODE_SERVER_URL` would cause the gateway to send HTTP triggers to a non-existent opencode server (the Claude Code container has no HTTP server on 4096). The deploy script derives `OPENCODE_SERVER_URL` from `AGENT_VARIANT` so this can't happen:

```bash
# In deploy script:
if [ "$AGENT_VARIANT" = "opencode" ]; then
  OPC_URL="http://agent:4096"
else
  OPC_URL=""  # Claude Code: PG NOTIFY flow, no HTTP trigger
fi
```

---

### 5.3 Deploy Script Modifications

The full deploy step is shown in [4.3](#43-build-and-pushyml--full-modified-workflow) above. The agent-specific additions to the deploy script's `script: |` block are:

#### 5.3.1 New env: entries on the SSH action

```yaml
        env:
          # ... existing envs unchanged ...
          # ---- Agent variant (Phase 4/5) ----
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          OPENCODE_ZEN_API_KEY: ${{ secrets.OPENCODE_ZEN_API_KEY }}
          AGENT_VARIANT: ${{ secrets.AGENT_VARIANT || 'claude' }}
```

Updated `envs:` string:

```yaml
          envs: GHCR_TOKEN,FINDHUB_WEBHOOK_TOKEN,FINDHUB_SECRETS_B64,FINDHUB_DEVICE_TYPES,ELASTIC_PASSWORD,BW_CLIENTID,BW_CLIENTSECRET,BW_PASSWORD,RABBITMQ_PASSWORD,EVOLUTION_GLOBAL_KEY,CLAUDE_CODE_OAUTH_TOKEN,OPENCODE_ZEN_API_KEY,AGENT_VARIANT
```

#### 5.3.2 Agent env injection (idempotent .env upsert)

Inserted into the `script: |` block, after the WhatsApp/Evolution injection and before the Evolution DB creation:

```bash
            # ===== Inject agent variant env (idempotent) — Phase 4/5 =====
            # AGENT_VARIANT: selects which agent image to run ("claude" or "opencode").
            # OPENCODE_SERVER_URL: derived from AGENT_VARIANT — NOT set independently.
            #   This makes rollback truly single-var: change AGENT_VARIANT, deploy.
            #   opencode → http://agent:4096 (gateway triggers agent via HTTP)
            #   claude   → empty (gateway uses PG NOTIFY → channel bridge flow)
            AGENT_VARIANT="${AGENT_VARIANT:-claude}"
            if [ "$AGENT_VARIANT" = "opencode" ]; then
              OPC_URL="http://agent:4096"
            else
              OPC_URL=""
            fi
            touch .env
            grep -v -E '^(AGENT_VARIANT|OPENCODE_SERVER_URL|CLAUDE_CODE_OAUTH_TOKEN|OPENCODE_ZEN_API_KEY)=' .env > .env.agent.tmp 2>/dev/null || true
            mv .env.agent.tmp .env
            {
              printf 'AGENT_VARIANT=%s\n' "$AGENT_VARIANT"
              printf 'OPENCODE_SERVER_URL=%s\n' "$OPC_URL"
              printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$CLAUDE_CODE_OAUTH_TOKEN"
              printf 'OPENCODE_ZEN_API_KEY=%s\n' "$OPENCODE_ZEN_API_KEY"
            } >> .env
            echo "Injected AGENT_VARIANT=$AGENT_VARIANT OPENCODE_SERVER_URL=$OPC_URL into .env"
```

#### 5.3.3 Agent image pull

Added to the image pull loop (after the infra images):

```bash
            # ===== Pull GHCR-built images (never databases or third-party) =====
            for img in gateway dashboard personal-knowledge gtd awareness google messaging health vault; do
              docker pull ghcr.io/arnonzamir/ll5-$img:latest 2>/dev/null || true
            done
            # Pull the selected agent variant image
            docker pull ghcr.io/arnonzamir/ll5-run-${AGENT_VARIANT}:latest 2>/dev/null || true
```

#### 5.3.4 Agent health check after compose up

Added after `docker compose up -d`:

```bash
            docker compose up -d

            # ===== Agent health check =====
            sleep 10
            AGENT_STATUS=$(docker compose ps agent --format json 2>/dev/null | jq -r '.State' 2>/dev/null || echo "unknown")
            if [ "$AGENT_STATUS" = "running" ]; then
              echo "Agent container running (variant: $AGENT_VARIANT)"
            else
              echo "::error::Agent container not running (status: $AGENT_STATUS, variant: $AGENT_VARIANT)"
              docker compose logs agent --tail 50 2>/dev/null || true
            fi
```

**Idempotent upsert pattern explanation**: The pattern follows the existing `ELASTIC_PASSWORD` / `BW_*` / `FINDHUB_*` approach:
1. `touch .env` — ensure file exists
2. `grep -v -E '^(VAR1|VAR2)=' .env > .env.tmp` — strip old lines for these vars
3. `mv .env.tmp .env` — atomic replace
4. `printf 'VAR=value\n' >> .env` — append fresh values
5. Guard on non-empty: a missing secret never blanks a working .env

This is idempotent — running it multiple times produces the same result. It handles the case where the secret value changes (rotate token) and the case where the .env file doesn't exist yet (first deploy).

---

### 5.4 Variant-Specific Healthcheck

The entrypoint (`docker-entrypoint.sh`) writes `/workspace/healthcheck.sh` on startup. The compose healthcheck calls this script. The content differs per variant:

#### Claude Code variant: process-based healthcheck

Claude Code has no HTTP server. The healthcheck verifies that the key processes are alive.

**In `variant-content/docker-entrypoint.sh` (Claude Code variant)**:

```bash
#!/bin/bash
set -e

# ... startup logic (tmux, ll5-server, channel bridge, autoheal, loops) ...

# Write variant-specific healthcheck script
cat > /workspace/healthcheck.sh << 'HEALTHCHECK'
#!/bin/bash
# Claude Code variant healthcheck: process-based (no HTTP server)
# Both the claude process AND the channel bridge must be alive.
# If either dies, the supervisor (ll5-server) should relaunch — but if
# ll5-server itself died, this catches it.
pgrep -f "claude" > /dev/null 2>&1 || exit 1
pgrep -f "ll5-channel" > /dev/null 2>&1 || exit 1
exit 0
HEALTHCHECK
chmod +x /workspace/healthcheck.sh

# ... rest of entrypoint ...
```

**Why both processes**: `claude` is the Claude Code CLI process. `ll5-channel` is the channel bridge (`ll5-channel.mjs`) that connects the agent to the gateway via SSE. If `claude` dies but `ll5-channel` is alive, the supervisor should relaunch claude — but if the supervisor itself is dead, both will eventually die. If `ll5-channel` dies but `claude` is alive, the agent is running but can't send/receive messages — effectively broken.

#### opencode variant: HTTP-based healthcheck

opencode runs an HTTP server with a built-in `/health` endpoint.

**In `variant-content/docker-entrypoint.sh` (opencode variant)**:

```bash
#!/bin/bash
set -e

# ... startup logic (opencode serve, worker scripts, session registration) ...

# Write variant-specific healthcheck script
cat > /workspace/healthcheck.sh << 'HEALTHCHECK'
#!/bin/bash
# opencode variant healthcheck: HTTP probe to opencode server
# opencode serve runs on port 4096 with a built-in /health endpoint.
wget -qO- http://localhost:4096/health > /dev/null 2>&1 || exit 1
exit 0
HEALTHCHECK
chmod +x /workspace/healthcheck.sh

# ... rest of entrypoint (exec opencode serve) ...
```

#### Compose healthcheck config (both variants)

The compose service uses the same healthcheck config for both variants — the variant-specific logic is in the script the entrypoint writes:

```yaml
    healthcheck:
      test: ["CMD-SHELL", "/workspace/healthcheck.sh || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 45s
```

**Why `start_period: 45s`**: Both variants need time to start:
- Claude Code: tmux session → ll5-server → MCP pre-warm → claude --continue → channel bridge connect (~20-30s)
- opencode: opencode serve → plugin load → MCP connect → session registration (~10-20s)

45s gives enough headroom without marking the container unhealthy during normal startup.

---

### 5.5 Acceptance Criteria

#### Claude Code variant (Phase 4.5 verification)

| # | Check | Command | Expected |
|---|---|---|---|
| 1 | Agent container running | `docker compose ps agent` | `Up` status |
| 2 | Only one agent container | `docker ps --filter "name=agent" --format "{{.Names}}"` | `agent-xkkcc0g4o48kkcows8488so4` only |
| 3 | Claude process alive | `docker exec agent-xkkcc0g4o48kkcows8488so4 pgrep -f claude` | PID(s) returned |
| 4 | Channel bridge alive | `docker exec agent-xkkcc0g4o48kkcows8488so4 pgrep -f ll5-channel` | PID(s) returned |
| 5 | Healthcheck passing | `docker inspect agent-xkkcc0g4o48kkcows8488so4 --format '{{.State.Health.Status}}'` | `healthy` |
| 6 | MCP connectivity | `docker exec agent-xkkcc0g4o48kkcows8488so4 cat /workspace/channel-health.json` | All 6 MCPs healthy |
| 7 | Agent responds to message | Send test message via WhatsApp/API | Agent processes + responds |
| 8 | Correlation-ids in audit log | `SELECT session_id, trace_id FROM ll5_audit_log ORDER BY created_at DESC LIMIT 5` | Non-null session_id + trace_id |
| 9 | Old Coolify app deleted | Coolify UI: app `js8owk0g0cgog800ckc8ww0s` not listed | Absent |
| 10 | No duplicate messages | Send 1 test message, check `chat_messages` | Exactly 1 message from agent |

#### opencode variant (Phase 5 verification)

| # | Check | Command | Expected |
|---|---|---|---|
| 1 | Agent container running | `docker compose ps agent` | `Up` status |
| 2 | opencode server healthy | `docker exec agent-xkkcc0g4o48kkcows8488so4 wget -qO- http://localhost:4096/health` | 200 OK |
| 3 | Healthcheck passing | `docker inspect agent-xkkcc0g4o48kkcows8488so4 --format '{{.State.Health.Status}}'` | `healthy` |
| 4 | Session registered | `SELECT agent_sessions->'main' FROM user_settings WHERE user_id=$USER_ID` | Non-null session UUID |
| 5 | Gateway triggers reach agent | Send test system message; check agent logs | `POST /session/:id/prompt_async` received |
| 6 | Full metadata reaches agent | Check agent context for source routing + scheduler event | Metadata present in context |
| 7 | All 6 MCPs work | Test each: personal-knowledge, gtd, awareness, google, messaging, health | Tool calls succeed |
| 8 | Correlation-ids in audit log | `SELECT session_id, trace_id FROM ll5_audit_log ORDER BY created_at DESC LIMIT 5` | Non-null session_id + trace_id |
| 9 | Skill works | Execute `/daily` or `/review` via agent | Skill runs; output coherent |
| 10 | `push_to_user` reaches gateway | Agent calls `push_to_user`; check `chat_messages` | New message in PG |
| 11 | `external-authority-gate` blocks | Externally-triggered turn + state-changing tool call | Tool denied; agent receives deny message |
| 12 | Background workers start | Check `agent_sessions` for `narrative_loop` + `reconcile_loop` | Both session types registered |
| 13 | Workers complete a cycle | Monitor worker logs for one iteration | Narrative-loop + reconcile-loop complete |
| 14 | Session history writes to ES | `GET ll5_session_history/_count` in ES | Count increases after turns |
| 15 | `recall_everything` finds history | Execute recall; check results | Session history docs returned |
| 16 | `OPENCODE_SERVER_URL` correct | `grep OPENCODE_SERVER_URL .env` | `http://agent:4096` |
| 17 | No port published | `docker port agent-xkkcc0g4o48kkcows8488so4` | Empty (no port mappings) |
| 18 | Traefik not routing | `curl -s -o /dev/null -w '%{http_code}' https://agent.noninoni.click/health` | 404 or connection refused (no route) |

#### Rollback verification (either variant → claude)

| # | Check | Command | Expected |
|---|---|---|---|
| 1 | Set `AGENT_VARIANT=claude` | `grep AGENT_VARIANT .env` | `AGENT_VARIANT=claude` |
| 2 | `OPENCODE_SERVER_URL` auto-cleared | `grep OPENCODE_SERVER_URL .env` | `OPENCODE_SERVER_URL=` (empty) |
| 3 | Deploy | Push to main or `workflow_dispatch` | Deploy succeeds |
| 4 | Claude Code image pulled | `docker images \| grep ll5-run-claude` | Image present |
| 5 | Claude Code container running | `docker compose ps agent` | `Up` status, image `ll5-run-claude` |
| 6 | Gateway trigger is no-op | `grep OPENCODE_SERVER_URL .env` | Empty → triggerAgent returns early |
| 7 | PG NOTIFY flow works | Send test message | Agent responds via channel bridge |

---

## Summary: Files Changed

| File | Change | Phase |
|---|---|---|
| `docker/Dockerfile.ll5-run-claude` | **New** — Claude Code variant Dockerfile | 4 |
| `docker/Dockerfile.ll5-run-opencode` | **New** — opencode variant Dockerfile | 4 |
| `.github/workflows/build-and-push.yml` | **Modified** — variant packages, dispatch, schedule, Node skips, variant checkout, Dockerfile selection, deploy env injection, agent pull + health | 4 + 5 |
| `docker/docker-compose.prod.yml` | **Modified** — agent service block, agent volumes, gateway `OPENCODE_SERVER_URL` env | 5 |
| GitHub secrets | **New** — `VARIANT_REPO_READ_PAT`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENCODE_ZEN_API_KEY`, `AGENT_VARIANT`, `OPENCODE_VERSION` | 4 |
| GitHub secrets (variant repos) | **New** — `LL5_DISPATCH_PAT` in each variant repo | 4 |
| Host operations | Stop + remove old container, migrate volumes, delete old Coolify app | 4.5 |
