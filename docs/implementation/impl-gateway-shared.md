# Implementation Plan: Gateway + Shared Content (Phases 1 & 2)

Parent plan: `docs/implementation/dual-run-variant-plan.md`

This document covers **Phase 1** (extract shared content to `packages/ll5-run-shared/`) and **Phase 2** (gateway agent-trigger abstraction). All code is actual implementation, not pseudocode, unless marked otherwise.

---

## Phase 1: Extract Shared Content to ll5

### 1.1 File Inventory

Files moved from `ll5-run-claude-code` (separate repo) into `packages/ll5-run-shared/` in ll5:

| # | Source (ll5-run-claude-code) | Destination (ll5) | Notes |
|---|---|---|---|
| 1 | `CLAUDE.md` | `packages/ll5-run-shared/CLAUDE.md` | Persona, 14 Hard Rules, GTD coaching |
| 2 | `.claude/skills/*/SKILL.md` (17 skills) | `packages/ll5-run-shared/skills/<name>/SKILL.md` | Flat `skills/` dir, drop `.claude/` prefix |
| 3 | `prompts/narrative-loop.md` | `packages/ll5-run-shared/prompts/narrative-loop.md` | Background worker prompt |
| 4 | `prompts/reconcile-loop.md` | `packages/ll5-run-shared/prompts/reconcile-loop.md` | Reconcile worker prompt |
| 5 | `.mcp.server.json` | `packages/ll5-run-shared/mcp-endpoints.json` | Source of truth for MCP endpoints (schema redesigned — see 1.3) |

New files created in ll5:

| # | Path | Purpose |
|---|---|---|
| 6 | `packages/ll5-run-shared/mcp-endpoints.json` | MCP endpoint source-of-truth (redesigned schema) |
| 7 | `scripts/render-mcp-config.ts` | Renders `mcp-endpoints.json` into variant-specific MCP configs |
| 8 | `packages/ll5-run-shared/README.md` | Documents the shared-content contract + rendering flow |

**NOT moved** (stays variant-specific in ll5-run-claude-code):
- Hooks (`.claude/hooks/*.sh`)
- Channel bridge (`channel/ll5-channel.mjs`)
- Worker scripts (`scripts/narrative-loop.sh`, `scripts/reconcile-loop.sh`, etc.)
- `ll5-server` supervisor
- `get-mcp-auth.sh` (variant-specific: reads `~/.ll5/token`, emits correlation-id headers)
- `.mcp.reconcile.json`, `.mcp.narrate.json` (rendered from shared source-of-truth, but the rendering happens in CI — the source files themselves are generated, not committed)
- Subagent definitions (`.claude/agents/*.md`)
- `docker-entrypoint.sh`, `tmux.conf`

### 1.2 Path Reference Audit

CLAUDE.md and skills reference runtime paths inside the agent container. The Dockerfile COPYs shared content to the **same `/workspace/` locations** the agent already expects, so most references are unaffected. The audit categories:

#### Category A: Container runtime paths (NO CHANGE needed)

These reference paths inside the running container, not repo paths. The Dockerfile maps shared content to identical container locations:

| Reference | Container path | Source after extraction | Affected? |
|---|---|---|---|
| `CLAUDE.md` location | `/workspace/CLAUDE.md` | `COPY packages/ll5-run-shared/CLAUDE.md /workspace/CLAUDE.md` | No |
| Skills location | `/workspace/.claude/skills/*/SKILL.md` | `COPY packages/ll5-run-shared/skills/ /workspace/.claude/skills/` | No |
| Prompts location | `/workspace/prompts/*.md` | `COPY packages/ll5-run-shared/prompts/ /workspace/prompts/` | No |
| `~/.ll5/token` | `$HOME/.ll5/token` → `/data/home/.ll5/token` | Variant-specific (`get-mcp-auth.sh` reads it) | No |
| `scripts/get-mcp-auth.sh` | `/workspace/scripts/get-mcp-auth.sh` | Variant-specific content, COPY'd by Dockerfile | No |

**Action**: Verify by grepping CLAUDE.md and all SKILL.md files for path references. Any reference to `/workspace/...` or `~/...` is a container path — no change needed.

#### Category B: MCP config path (CHANGED — rendered, not static)

| Reference | Old path | New path | Action |
|---|---|---|---|
| `.mcp.server.json` (Claude Code) | `/workspace/.mcp.server.json` (committed) | `/workspace/.claude/settings.json` (rendered by `render-mcp-config.ts`) | If CLAUDE.md or skills reference `.mcp.server.json` by name, update to `.claude/settings.json` or remove the reference (the agent doesn't need to know the config filename) |
| MCP server names | `ll5-knowledge`, `ll5-gtd`, etc. | `personal-knowledge`, `gtd`, `awareness`, `google`, `messaging`, `health` (matching actual compose service names) | **Renamed** — `mcp-endpoints.json` uses actual service names |

**Action**: `rg -i 'mcp\.server\.json|\.mcp\.server' packages/ll5-run-shared/` after extraction. Update any hits to reference the rendered config path or remove.

#### Category C: Hook/script references in skills (ANTICIPATED — verify)

Skills may instruct the agent to run scripts or reference hook behavior:

| Anticipated reference | Example | Action |
|---|---|---|
| `scripts/narrative-loop.sh` | "The narrative loop runs at..." | No change — script is variant-specific, stays at `/workspace/scripts/` |
| `scripts/reconcile-loop.sh` | "Run reconcile via..." | No change — same reason |
| `.claude/hooks/external-authority-gate.sh` | "Hard Rule 13 is enforced by..." | No change — hook stays at `/workspace/.claude/hooks/` |
| `scripts/evals/live_eval.py` | "Eval recording..." | No change — variant-specific |

**Action**: `rg -i 'scripts/|\.claude/hooks/|get-mcp-auth' packages/ll5-run-shared/` after extraction. These are behavioral references (the agent is told what exists), not path dependencies. Update only if a skill instructs the agent to `cat` or `read` a specific file path that has changed.

#### Category D: Cross-references between shared files (VERIFY)

Skills may reference other skills or CLAUDE.md by relative path:

| Anticipated reference | Action |
|---|---|
| `../CLAUDE.md` from a skill | No change — container path `/workspace/.claude/skills/<name>/SKILL.md` → `../../CLAUDE.md` still resolves |
| `../<other-skill>/SKILL.md` | No change — same relative structure in container |

**Action**: `rg -i 'SKILL\.md|CLAUDE\.md' packages/ll5-run-shared/skills/` after extraction. Verify cross-references resolve in the container's `/workspace/.claude/skills/` layout.

#### Audit checklist (run after extraction):

```bash
# 1. Find all path-like references in shared content
rg -n '(~/|/workspace/|\.claude/|scripts/|\.mcp|get-mcp-auth)' packages/ll5-run-shared/

# 2. Find cross-file references
rg -n '(CLAUDE\.md|SKILL\.md|\.mcp\.server)' packages/ll5-run-shared/

# 3. Find hardcoded URLs/domains that should be env-driven
rg -n '(noninoni\.click|localhost|127\.0\.0\.1)' packages/ll5-run-shared/
```

### 1.3 MCP Config Rendering

#### Input: `mcp-endpoints.json` schema

```json
{
  "$schema": "https://ll5.dev/mcp-endpoints.schema.json",
  "baseDomainEnv": "MCP_BASE_DOMAIN",
  "endpoints": {
    "personal-knowledge": {
      "subdomain": "mcp-knowledge",
      "path": "/mcp",
      "auth": "agent-token",
      "correlationIds": true
    },
    "gtd": {
      "subdomain": "mcp-gtd",
      "path": "/mcp",
      "auth": "agent-token",
      "correlationIds": true
    },
    "awareness": {
      "subdomain": "mcp-awareness",
      "path": "/mcp",
      "auth": "agent-token",
      "correlationIds": true
    },
    "google": {
      "subdomain": "mcp-google",
      "path": "/mcp",
      "auth": "agent-token",
      "correlationIds": true
    },
    "health": {
      "subdomain": "mcp-health",
      "path": "/mcp",
      "auth": "agent-token",
      "correlationIds": true
    },
    "messaging": {
      "subdomain": "mcp-messaging",
      "path": "/mcp",
      "auth": "agent-token",
      "correlationIds": true
    }
  },
  "workers": {
    "reconcile": {
      "allow": ["gtd", "personal-knowledge", "google", "messaging"]
    },
    "narrate": {
      "allow": ["personal-knowledge", "awareness", "gtd", "google"]
    }
  }
}
```

Field semantics:
- `baseDomainEnv`: environment variable name to read for the base domain (e.g. `MCP_BASE_DOMAIN=noninoni.click`)
- `endpoints.<key>`: one entry per remote MCP. `auth: "agent-token"` means the `headersHelper`/plugin injects the Bearer token dynamically (not static). `correlationIds: true` means the auth mechanism also injects `X-LL5-Session-Id` + `X-LL5-Trace-Id` headers.
- `workers.<name>.allow`: allowlist of endpoint keys this worker can access. Absence from `allow` = denied (allowlist model, not denylist).

#### Output 1: Claude Code `.claude/settings.json`

```json
{
  "mcpServers": {
    "personal-knowledge": {
      "type": "streamable-http",
      "url": "https://mcp-knowledge.noninoni.click/mcp",
      "headersHelper": "/workspace/scripts/get-mcp-auth.sh"
    },
    "gtd": {
      "type": "streamable-http",
      "url": "https://mcp-gtd.noninoni.click/mcp",
      "headersHelper": "/workspace/scripts/get-mcp-auth.sh"
    }
  }
}
```

- `headersHelper`: Claude Code calls this script before each MCP request. The script emits JSON headers on stdout: `{"Authorization": "Bearer <token>", "X-LL5-Session-Id": "<sid>", "X-LL5-Trace-Id": "<tid>"}`. The token is read from `~/.ll5/token` (refreshed by the channel bridge). This is variant-specific content (`get-mcp-auth.sh` lives in ll5-run-claude-code), but the config that references it is rendered from the shared source-of-truth.

#### Output 2: opencode `opencode-mcp-fragment.json` (MCP section only — merged with variant repo's opencode.json at startup)

The render script outputs ONLY the `mcp` section — NOT a complete `opencode.json`. The variant repo's `opencode.json` contains model, agent, and plugin config that must NOT be overwritten. The `docker-entrypoint.sh` merges this fragment into the variant repo's `opencode.json` at startup using a simple JSON merge (shallow-merge the `mcp` key).

```json
{
  "mcp": {
    "personal-knowledge": {
      "type": "remote",
      "url": "https://mcp-personal-knowledge.noninoni.click/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_API_KEY}"
      }
    },
    "gtd": {
      "type": "remote",
      "url": "https://mcp-gtd.noninoni.click/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_API_KEY}"
      }
    }
  }
}
```

> **Note**: The subdomain in the URL must match the Traefik routing rules in `docker-compose.prod.yml`. For `personal-knowledge`, the Traefik rule is `Host(\`mcp-knowledge.noninoni.click\`)` (not `mcp-personal-knowledge`). The `render-mcp-config.ts` script must use the `subdomain` field from `mcp-endpoints.json` which maps `personal-knowledge → mcp-knowledge`. For opencode, the proxy sidecar (§3.3 of impl-security.md) uses the service name as the path (`/personal-knowledge`), so the URL in `opencode.json` is `http://127.0.0.1:4097/personal-knowledge` (proxy-local), not the public Traefik URL.

- opencode does not support `headersHelper` (dynamic per-call headers). Static `Authorization` header is set from env. Correlation-id injection (`X-LL5-Session-Id`, `X-LL5-Trace-Id`) is handled by the `correlation-id-injector.ts` plugin (Phase 3).
- The `${MCP_API_KEY}` is resolved by opencode from the container environment. The rendering script emits it as a literal placeholder; opencode substitutes env vars at load time.

#### Output 3: Worker restricted configs

For Claude Code variant, the script renders separate files:
- `.mcp.reconcile.json` — only `workers.reconcile.allow` endpoints
- `.mcp.narrate.json` — only `workers.narrate.allow` endpoints

For opencode variant, per-agent permissions are in `opencode.json` agent configs (handled by the opencode variant's own config, not this script — the script only renders the `mcp` section). The worker scripts reference their restricted config via `--mcp-config .mcp.reconcile.json` (Claude Code) or `opencode --agent reconcile-worker` (opencode).

#### Full implementation: `scripts/render-mcp-config.ts`

```typescript
#!/usr/bin/env tsx
/**
 * Render variant-specific MCP configs from the shared source-of-truth
 * (packages/ll5-run-shared/mcp-endpoints.json).
 *
 * Usage:
 *   npx tsx scripts/render-mcp-config.ts \
 *     --format claude \
 *     --output /workspace/.claude/settings.json
 *
 *   npx tsx scripts/render-mcp-config.ts \
 *     --format opencode \
 *     --output /workspace/opencode.json \
 *     --section mcp
 *
 *   npx tsx scripts/render-mcp-config.ts \
 *     --format claude \
 *     --worker reconcile \
 *     --output /workspace/.mcp.reconcile.json
 *
 * Env:
 *   MCP_BASE_DOMAIN — base domain for MCP endpoints (e.g. "noninoni.click")
 *   MCP_API_KEY     — static bearer token (opencode format only; emitted as ${MCP_API_KEY} placeholder)
 */
import fs from 'node:fs';
import path from 'node:path';

type Format = 'claude' | 'opencode';

interface McpEndpoint {
  subdomain: string;
  path: string;
  auth: 'agent-token' | 'static' | 'none';
  correlationIds: boolean;
}

interface WorkerConfig {
  allow: string[];
}

interface McpEndpointsConfig {
  baseDomainEnv: string;
  endpoints: Record<string, McpEndpoint>;
  workers: Record<string, WorkerConfig>;
}

function loadConfig(configPath: string): McpEndpointsConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`MCP endpoints config not found: ${configPath}`);
  }
  const raw = fs.readFileSync(configPath, 'utf-8');
  return JSON.parse(raw) as McpEndpointsConfig;
}

function resolveBaseDomain(config: McpEndpointsConfig): string {
  const val = process.env[config.baseDomainEnv];
  if (!val) {
    throw new Error(
      `Environment variable ${config.baseDomainEnv} not set — cannot resolve MCP base domain`,
    );
  }
  return val;
}

function buildUrl(ep: McpEndpoint, baseDomain: string): string {
  return `https://${ep.subdomain}.${baseDomain}${ep.path}`;
}

function filterEndpointKeys(config: McpEndpointsConfig, worker?: string): string[] {
  if (!worker) return Object.keys(config.endpoints);
  const w = config.workers[worker];
  if (!w) throw new Error(`Unknown worker: ${worker}. Available: ${Object.keys(config.workers).join(', ')}`);
  return w.allow;
}

function renderClaude(
  config: McpEndpointsConfig,
  baseDomain: string,
  worker?: string,
): Record<string, unknown> {
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const key of filterEndpointKeys(config, worker)) {
    const ep = config.endpoints[key];
    if (!ep) throw new Error(`Endpoint "${key}" referenced by worker but not defined in endpoints`);
    mcpServers[key] = {
      type: 'streamable-http',
      url: buildUrl(ep, baseDomain),
      headersHelper: '/workspace/scripts/get-mcp-auth.sh',
    };
  }
  return { mcpServers };
}

function renderOpencode(
  config: McpEndpointsConfig,
  baseDomain: string,
  worker?: string,
): Record<string, unknown> {
  const mcp: Record<string, Record<string, unknown>> = {};
  for (const key of filterEndpointKeys(config, worker)) {
    const ep = config.endpoints[key];
    if (!ep) throw new Error(`Endpoint "${key}" referenced by worker but not defined in endpoints`);
    mcp[key] = {
      type: 'streamable-http',
      url: buildUrl(ep, baseDomain),
      headers: {
        Authorization: 'Bearer ${MCP_API_KEY}',
      },
    };
  }
  return { mcp };
}

function parseArgs(argv: string[]): {
  format: Format;
  output: string | null;
  worker: string | undefined;
  configPath: string;
} {
  let format: Format = 'claude';
  let output: string | null = null;
  let worker: string | undefined;
  let configPath = 'packages/ll5-run-shared/mcp-endpoints.json';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const getVal = (flag: string): string | undefined => {
      if (arg === flag) return argv[++i];
      if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
      return undefined;
    };
    const v: string | undefined = getVal('--format') ?? getVal('--output') ?? getVal('--worker') ?? getVal('--config');
    if (arg.startsWith('--format')) format = (v as Format) ?? format;
    else if (arg.startsWith('--output')) output = v ?? output;
    else if (arg.startsWith('--worker')) worker = v ?? worker;
    else if (arg.startsWith('--config')) configPath = v ?? configPath;
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: render-mcp-config.ts [options]

Options:
  --format <claude|opencode>  Output format (default: claude)
  --output <path>             Write to file (default: stdout)
  --worker <name>             Render only the allowlisted endpoints for this worker
  --config <path>             Path to mcp-endpoints.json (default: packages/ll5-run-shared/mcp-endpoints.json)
  --help                      Show this help

Env:
  MCP_BASE_DOMAIN  Base domain for MCP URLs (required)`);
      process.exit(0);
    }
  }

  if (format !== 'claude' && format !== 'opencode') {
    throw new Error(`Invalid format: ${format}. Must be "claude" or "opencode".`);
  }

  return { format, output, worker, configPath };
}

function main(): void {
  const { format, output, worker, configPath } = parseArgs(process.argv.slice(2));
  const config = loadConfig(configPath);
  const baseDomain = resolveBaseDomain(config);

  const rendered =
    format === 'claude'
      ? renderClaude(config, baseDomain, worker)
      : renderOpencode(config, baseDomain, worker);

  const json = JSON.stringify(rendered, null, 2) + '\n';

  if (output) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, json);
    console.error(
      `[render-mcp-config] Wrote ${format} config → ${output}${worker ? ` (worker: ${worker}, ${filterEndpointKeys(config, worker).length} endpoints)` : ` (${filterEndpointKeys(config).length} endpoints)`}`,
    );
  } else {
    process.stdout.write(json);
  }
}

main();
```

**Dockerfile usage** (Claude Code variant):
```dockerfile
COPY scripts/render-mcp-config.ts /tmp/render-mcp-config.ts
COPY packages/ll5-run-shared/mcp-endpoints.json /tmp/mcp-endpoints.json
RUN npx tsx /tmp/render-mcp-config.ts --config /tmp/mcp-endpoints.json \
      --format claude \
      --output /workspace/.claude/settings.json
RUN npx tsx /tmp/render-mcp-config.ts --config /tmp/mcp-endpoints.json \
      --format claude --worker reconcile \
      --output /workspace/.mcp.reconcile.json
RUN npx tsx /tmp/render-mcp-config.ts --config /tmp/mcp-endpoints.json \
      --format claude --worker narrate \
      --output /workspace/.mcp.narrate.json
```

### 1.4 Change-Detection Integration

**Goal**: Changes to `packages/ll5-run-shared/` or `scripts/render-mcp-config.ts` trigger an agent variant rebuild.

Current `build-and-push.yml` change-detection (lines 37-54):
```bash
CHANGED=$(git diff --name-only HEAD~1 HEAD)
SHARED_CHANGED=$(echo "$CHANGED" | grep -c "packages/shared/" || true)
DOCKER_CHANGED=$(echo "$CHANGED" | grep -c "docker/" || true)

if [[ "$SHARED_CHANGED" -eq 0 && "$DOCKER_CHANGED" -eq 0 ]]; then
  # filter to changed packages only
fi
```

**Modification**: Add `LL5_RUN_SHARED_CHANGED` to the trigger-all condition. When shared agent content changes, ALL variant packages (`run-claude`, `run-opencode`) must rebuild — same logic as `packages/shared/` triggering all MCPs.

```bash
# In detect-changes step (modified):
CHANGED=$(git diff --name-only HEAD~1 HEAD)
SHARED_CHANGED=$(echo "$CHANGED" | grep -c "packages/shared/" || true)
LL5_RUN_SHARED_CHANGED=$(echo "$CHANGED" | grep -cE "packages/ll5-run-shared/|scripts/render-mcp-config\.ts" || true)
DOCKER_CHANGED=$(echo "$CHANGED" | grep -c "docker/" || true)

# If only ll5-run-shared changed (no shared, no docker), still trigger variant rebuilds
if [[ "$SHARED_CHANGED" -eq 0 && "$DOCKER_CHANGED" -eq 0 ]]; then
  FILTERED=()
  for pkg in "${PACKAGES[@]}"; do
    if echo "$CHANGED" | grep -q "packages/$pkg/"; then
      FILTERED+=("$pkg")
    fi
  done
  # ll5-run-shared changes → always include variant packages
  if [[ "$LL5_RUN_SHARED_CHANGED" -gt 0 ]]; then
    for v in run-claude run-opencode; do
      if [[ " ${PACKAGES[*]} " =~ " $v " ]] && [[ ! " ${FILTERED[*]} " =~ " $v " ]]; then
        FILTERED+=("$v")
      fi
    done
  fi
  if [[ ${#FILTERED[@]} -gt 0 ]]; then
    PACKAGES=("${FILTERED[@]}")
  fi
fi
```

Note: `run-claude` and `run-opencode` are added to the `PACKAGES` array in Phase 4 (CI/CD). This change-detection addition is applied at the same time. Before Phase 4, `ll5-run-shared` changes don't trigger anything (no variant packages exist yet) — which is fine, since the shared content isn't consumed until the variant Dockerfiles are built.

### 1.5 Fallback Strategy

**Goal**: Keep ll5-run-claude-code's in-repo copy as fallback until the shared path is verified, then delete.

1. **Before extraction**: ll5-run-claude-code has its own `CLAUDE.md`, `.claude/skills/`, `prompts/`, `.mcp.server.json` — the working originals.

2. **During extraction**: Copy (not move) the files into `packages/ll5-run-shared/` in ll5. The ll5-run-claude-code repo retains its copies.

3. **CI rendering**: The ll5-run-claude-code Dockerfile is updated to COPY from `packages/ll5-run-shared/` (via the ll5 build context) and render MCP config via `render-mcp-config.ts`. BUT — keep the old `.mcp.server.json` as a fallback file in the variant repo, not referenced by the entrypoint.

4. **Verification**: Deploy the Claude Code variant built from shared content. Run for 24-48h. Watch for silent degradation:
   - Agent persona adherence (14 Hard Rules)
   - Skill execution quality
   - MCP connectivity (all 6 remote MCPs reachable)
   - No missing-skill errors in logs

5. **Delete fallback**: After verification passes:
   - Remove `CLAUDE.md`, `.claude/skills/`, `prompts/`, `.mcp.server.json` from ll5-run-claude-code
   - The variant repo becomes truly thin (only hooks, channel, scripts, supervisor)
   - The shared content is now the single source of truth

6. **Rollback path**: If silent degradation is detected, revert the Dockerfile to COPY from the variant repo's local copies (still present until step 5). This is a single-file revert — no data migration needed.

### 1.6 Acceptance Criteria (Phase 1)

#### Verification steps:

```bash
# 1. Shared content exists in ll5
test -f packages/ll5-run-shared/CLAUDE.md && echo "OK: CLAUDE.md" || echo "FAIL"
test -f packages/ll5-run-shared/mcp-endpoints.json && echo "OK: mcp-endpoints.json" || echo "FAIL"
test -d packages/ll5-run-shared/skills && echo "OK: skills/" || echo "FAIL"
test -f packages/ll5-run-shared/prompts/narrative-loop.md && echo "OK: narrative-loop.md" || echo "FAIL"
test -f packages/ll5-run-shared/prompts/reconcile-loop.md && echo "OK: reconcile-loop.md" || echo "FAIL"

# 2. Skill count matches (17 skills)
ls -d packages/ll5-run-shared/skills/*/ | wc -l
# Expected: 17

# 3. render-mcp-config.ts runs and produces valid JSON
MCP_BASE_DOMAIN=noninoni.click npx tsx scripts/render-mcp-config.ts \
  --format claude --output /tmp/test-claude-settings.json
python3 -c "import json; json.load(open('/tmp/test-claude-settings.json'))" && echo "OK: valid JSON"

# 4. Claude format has headersHelper, no static auth
MCP_BASE_DOMAIN=noninoni.click npx tsx scripts/render-mcp-config.ts --format claude | \
  python3 -c "import json,sys; d=json.load(sys.stdin); assert 'headersHelper' in list(d['mcpServers'].values())[0]; assert 'Authorization' not in str(d); print('OK')"

# 5. opencode format has static headers, no headersHelper
MCP_BASE_DOMAIN=noninoni.click npx tsx scripts/render-mcp-config.ts --format opencode | \
  python3 -c "import json,sys; d=json.load(sys.stdin); assert 'headers' in list(d['mcp'].values())[0]; assert 'headersHelper' not in str(d); print('OK')"

# 6. Worker configs have restricted endpoint sets
MCP_BASE_DOMAIN=noninoni.click npx tsx scripts/render-mcp-config.ts --format claude --worker reconcile | \
  python3 -c "import json,sys; d=json.load(sys.stdin); keys=set(d['mcpServers'].keys()); assert 'awareness' not in keys; assert 'health' not in keys; print('OK: reconcile restricted')"

MCP_BASE_DOMAIN=noninoni.click npx tsx scripts/render-mcp-config.ts --format claude --worker narrate | \
  python3 -c "import json,sys; d=json.load(sys.stdin); keys=set(d['mcpServers'].keys()); assert 'messaging' not in keys; assert 'health' not in keys; print('OK: narrate restricted')"

# 7. Missing MCP_BASE_DOMAIN fails fast
npx tsx scripts/render-mcp-config.ts --format claude 2>&1 | grep "MCP_BASE_DOMAIN not set" && echo "OK: fails fast"

# 8. Path reference audit (no hits on .mcp.server.json)
rg -n '\.mcp\.server\.json' packages/ll5-run-shared/ && echo "FAIL: stale reference" || echo "OK: no stale references"

# 9. End-to-end: Claude Code variant builds with shared content
docker build -f docker/Dockerfile.ll5-run-claude -t ll5-run-claude:test .
docker run --rm ll5-run-claude:test cat /workspace/CLAUDE.md | head -1
# Expected: first line of CLAUDE.md
docker run --rm ll5-run-claude:test cat /workspace/.claude/settings.json | python3 -c "import json,sys; json.load(sys.stdin); print('OK')"
# Expected: OK
docker run --rm ll5-run-claude:test ls /workspace/.claude/skills/ | wc -l
# Expected: 17
```

#### Behavioral verification (post-deploy):

- Agent responds to a test prompt with correct persona (14 Hard Rules evident)
- At least one skill executes (`/daily` or `/review`)
- All 6 remote MCPs are reachable (no connection errors in logs)
- No `missing skill` or `file not found` errors in agent logs for 24h
- Reconcile worker starts and connects only to its allowlisted MCPs

---

## Phase 2: Gateway Agent-Trigger Abstraction

### 2.1 `agent-trigger.ts` — Full Implementation

New file: `packages/gateway/src/utils/agent-trigger.ts`

```typescript
import type { Pool } from 'pg';
import { logger } from './logger.js';
import type { SourceRoutingMeta, SchedulerEventMeta } from './system-message.js';

export interface TriggerPayload {
  content: string;
  metadata?: {
    source?: SourceRoutingMeta;
    scheduler?: SchedulerEventMeta;
  };
  noReply?: boolean;
}

/**
 * Read the user's main agent session ID from user_settings.agent_session_id.
 * Returns null if no session is registered (agent hasn't started / hasn't
 * called POST /internal/agent-session yet).
 */
export async function getAgentSessionId(pool: Pool, userId: string): Promise<string | null> {
  const result = await pool.query<{ agent_session_id: string | null }>(
    'SELECT agent_session_id FROM user_settings WHERE user_id = $1',
    [userId],
  );
  return result.rows[0]?.agent_session_id ?? null;
}

/**
 * Read a specific worker session ID from the agent_sessions JSONB map.
 * Used by schedulers that target background workers (narrative-loop,
 * reconcile-loop) rather than the main interactive session.
 */
export async function getAgentSessionForWorker(
  pool: Pool,
  userId: string,
  sessionType: string,
): Promise<string | null> {
  const result = await pool.query<{ agent_sessions: Record<string, string> | null }>(
    'SELECT agent_sessions FROM user_settings WHERE user_id = $1',
    [userId],
  );
  return result.rows[0]?.agent_sessions?.[sessionType] ?? null;
}

/**
 * Trigger the agent to process a message. This is the ONLY variant-specific
 * code path in the gateway, and it's env-driven:
 *
 * - When OPENCODE_SERVER_URL is set (opencode variant): HTTP POST to the
 *   opencode server's prompt_async endpoint with full metadata payload.
 * - When empty (Claude Code variant): no-op. The existing PG NOTIFY →
 *   channel bridge flow handles delivery.
 *
 * Metadata is injected as a prepended text part BEFORE the content so the
 * agent sees source routing the same way the channel bridge delivered it.
 * (opencode's prompt_async API has no `context` field — metadata must be
 * a `parts` entry, not a separate field.)
 *
 * Errors are NOT swallowed silently — the function logs at warn level and
 * re-throws so the caller can mark the PG row for retry by the
 * stuck-message-sweep (pass A retries triggerAgent alongside pg_notify).
 */
export async function triggerAgent(
  sessionId: string | null,
  payload: TriggerPayload,
): Promise<void> {
  const url = process.env.OPENCODE_SERVER_URL;
  if (!url || !sessionId) return; // Claude Code variant — no-op

  const body: Record<string, unknown> = {
    parts: [{ type: 'text', text: payload.content }],
  };

  if (payload.noReply) {
    body.noReply = true;
  }

  // Metadata is injected as a prepended text part BEFORE the content so
  // the agent sees source routing the same way the channel bridge delivered
  // it. The [meta] prefix lets the agent distinguish context from content.
  // (opencode's API has no `context` field — metadata must be a parts entry.)
  if (payload.metadata) {
    body.parts = [
      { type: 'text', text: `[meta] ${JSON.stringify(payload.metadata)}` },
      ...(body.parts as Array<{ type: string; text: string }>),
    ];
  }

  try {
    const response = await fetch(`${url}/session/${sessionId}/prompt_async`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}: ${errText.slice(0, 200)}`);
    }

    logger.debug('[agent-trigger] Triggered opencode session', {
      sessionId,
      hasMetadata: !!payload.metadata,
      noReply: !!payload.noReply,
      contentPrefix: payload.content.slice(0, 80),
    });
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    logger.warn('[agent-trigger] Failed to trigger opencode session', {
      sessionId,
      error: errMessage,
      contentPrefix: payload.content.slice(0, 80),
    });
    // Re-throw so the caller can mark the PG row for retry by the sweep.
    // The sweep's pass A re-notifies lost pending rows — it now also
    // calls triggerAgent, serving as the redelivery mechanism.
    throw err;
  }
}
```

### 2.2 Session Registration: `POST /internal/agent-session`

#### Request schema:

```typescript
// POST /internal/agent-session
// Authorization: Bearer ll5.<token>  (same chatAuthMiddleware as all /me/* routes)
{
  "sessionId": "sess-uuid-abc123",   // required, string
  "sessionType": "main"              // optional, defaults to "main"
                                    // valid: "main" | "narrative-loop" | "reconcile-loop"
}
```

#### Response schema:

```typescript
// 200 OK
{
  "ok": true,
  "sessionType": "main",
  "sessionId": "sess-uuid-abc123"
}

// 400 Bad Request
{ "error": "sessionId is required" }
{ "error": "sessionType must be one of: main, narrative-loop, reconcile-loop" }

// 500 Internal Server Error
{ "error": "<message>" }
```

#### Endpoint implementation (added to `server.ts`):

Insert after the `PUT /user-settings` handler (around line 640), before the telemetry endpoints:

```typescript
  // --- Agent session registration (dual-run-variant Phase 2) ---
  //
  // The agent container calls this on startup after creating its opencode
  // session. The gateway stores the session ID so triggerAgent() can route
  // prompts without a static env var (which the agent can't modify at
  // runtime). Workers (narrative-loop, reconcile-loop) register their own
  // sessions with sessionType.
  app.post('/internal/agent-session', authMw, async (req: Request, res: Response) => {
    const userId = (req as any).userId;
    const { sessionId, sessionType = 'main' } = req.body ?? {};

    if (!sessionId || typeof sessionId !== 'string') {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }

    const validTypes = ['main', 'narrative-loop', 'reconcile-loop'];
    if (!validTypes.includes(sessionType)) {
      res.status(400).json({
        error: `sessionType must be one of: ${validTypes.join(', ')}`,
      });
      return;
    }

    try {
      if (sessionType === 'main') {
        // Set both the fast-lookup column AND the JSONB map entry
        await pgPool.query(
          `INSERT INTO user_settings (user_id, agent_session_id, agent_sessions, settings, updated_at)
           VALUES ($1, $2, jsonb_build_object('main', $2), '{}'::jsonb, now())
           ON CONFLICT (user_id) DO UPDATE SET
             agent_session_id = EXCLUDED.agent_session_id,
             agent_sessions = user_settings.agent_sessions
               || jsonb_build_object('main', EXCLUDED.agent_session_id),
             updated_at = now()`,
          [userId, sessionId],
        );
      } else {
        // Only update the JSONB map for worker sessions
        await pgPool.query(
          `INSERT INTO user_settings (user_id, agent_sessions, settings, updated_at)
           VALUES ($1, jsonb_build_object($2::text, $3::text), '{}'::jsonb, now())
           ON CONFLICT (user_id) DO UPDATE SET
             agent_sessions = user_settings.agent_sessions
               || jsonb_build_object($2::text, $3::text),
             updated_at = now()`,
          [userId, sessionType, sessionId],
        );
      }

      logger.info('[server][agentSession] Registered agent session', {
        userId,
        sessionType,
        sessionId,
      });
      res.json({ ok: true, sessionType, sessionId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[server][agentSession] Failed to register session', {
        error: message,
        userId,
        sessionType,
      });
      res.status(500).json({ error: message });
    }
  });
```

#### Migration 039 SQL:

New file: `packages/gateway/src/migrations/039_agent_session_id.sql`

```sql
-- 2026-07-08 — Agent session registration (dual-run-variant Phase 2).
--
-- The agent container registers its opencode session on startup via
-- POST /internal/agent-session. The gateway stores the session ID here so
-- triggerAgent() can route prompts to the right session without a static
-- env var (which the agent can't modify at runtime).
--
-- agent_session_id: the MAIN interactive session (the one triggerAgent
--   targets for user-facing prompts). Fast single-column read — the common
--   case for insertSystemMessage → triggerAgent.
-- agent_sessions: per-worker session map { main, narrative-loop,
--   reconcile-loop } for schedulers that target specific background workers.
--   JSONB shallow-merge on UPSERT (|| operator) so worker registrations
--   don't clobber the main session or each other.

ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS agent_session_id TEXT;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS agent_sessions JSONB NOT NULL DEFAULT '{}';
```

#### `getAgentSessionId` reader:

Already implemented in `agent-trigger.ts` (see 2.1). The function:

```typescript
export async function getAgentSessionId(pool: Pool, userId: string): Promise<string | null> {
  const result = await pool.query<{ agent_session_id: string | null }>(
    'SELECT agent_session_id FROM user_settings WHERE user_id = $1',
    [userId],
  );
  return result.rows[0]?.agent_session_id ?? null;
}
```

Called by `insertSystemMessage` (see 2.4) and `stuck-message-sweep` (see 2.5). Returns `null` when no session is registered — `triggerAgent` treats `null` sessionId as a no-op (agent hasn't started yet or is Claude Code variant).

### 2.2.1 Additional `/internal/*` endpoints for opencode plugins

The opencode variant's plugins need several gateway endpoints that don't exist yet. These are thin proxy/helper endpoints — they either forward to existing MCP tools or aggregate data the plugins can't get via MCP directly. All are `chatAuthMiddleware`-gated (same as `/me/*` routes).

**These endpoints are ONLY needed for the opencode variant.** When `OPENCODE_SERVER_URL` is empty (Claude Code), they're never called. They can be deployed with the gateway in Phase 2 (harmless no-ops until the opencode variant connects).

| Endpoint | Method | Called by | Purpose | Implementation |
|---|---|---|---|---|
| `/internal/agent-session` | POST | docker-entrypoint.sh, workers | Session registration | Already specified above (§2.2) |
| `/internal/ingest-memory` | POST | `memory-intercept.ts` plugin | Forward intercepted write content to `ingest_memory` MCP tool | Calls awareness MCP `ingest_memory` tool server-side (the plugin can't call MCP tools directly — it can only call HTTP endpoints) |
| `/internal/regrounding` | GET | `session-start.ts`, `compaction.ts` plugins | Aggregate re-grounding context (narratives + sessions + knowledge + lessons + journal) | Calls awareness MCP `recent_sessions` + `list_narratives` + personal-knowledge `recall_lessons` + reads journal, returns a text block. Same logic as `session-start.sh`'s re-grounding branch. |
| `/internal/eval-moment` | POST | `eval-recorder.ts` plugin | Forward eval telemetry to ES `ll5_eval_moments` | **Already exists** as `POST /telemetry/eval-moment` in `server.ts` (line 670). The plugin should call `/telemetry/eval-moment` instead. Fix: change plugin to use existing endpoint. |
| `/internal/activity` | POST | `activity-marker.ts` plugin | Log activity marker for live compact display | Writes a lightweight activity row to PG `chat_messages` (channel='system', metadata.kind='activity'). Same as the Claude Code `activity-marker.sh` hook does via the channel bridge. |
| `/internal/continuity-probe` | POST | `continuity-probe.ts` script | Report continuity grade to ES | Writes to `ll5_app_log` with kind='continuity_probe'. Simple appLog call. |
| `/internal/memory-intercept-log` | POST | `memory-intercept.ts` (Phase 2.5 only) | Log intercept attempt for debugging | Writes to `ll5_app_log` with kind='memory_intercept'. Simple appLog call. Phase 2.5 only — productionized `memory-intercept.ts` uses `/internal/ingest-memory`. |
| `/internal/recall-lessons` | POST | `memory-recall.ts` plugin | Forward recall_lessons query to awareness MCP | Calls awareness MCP `recall_lessons` tool server-side, returns lessons JSON. The plugin can't call MCP directly — it calls this endpoint. |
| `/auth/verify` | GET | `session-start.ts` plugin | Token validity check | **Already exists** implicitly — any authed endpoint returns 401 on invalid token. The plugin can call any `/me/*` endpoint with a HEAD request. Fix: change plugin to use `GET /me/onboarding` (returns 200 on valid token, 401 on invalid). |

**Summary of fixes needed in opencode variant plugins**:
- `eval-recorder.ts`: change `/internal/eval-moment` → `/telemetry/eval-moment` (existing endpoint)
- `session-start.ts`: change `/auth/verify` → `GET /me/onboarding` (existing endpoint)
- `memory-intercept.ts` (Phase 2.5): keep `/internal/memory-intercept-log` (new, simple appLog)
- `memory-intercept.ts` (Phase 3): use `/internal/ingest-memory` (new, forwards to MCP)
- `session-start.ts` + `compaction.ts`: use `/internal/regrounding` (new, aggregates)
- `activity-marker.ts`: use `/internal/activity` (new, writes PG row)
- `continuity-probe.ts`: use `/internal/continuity-probe` (new, writes appLog)

**Implementation effort**: 4 new thin endpoints (~15 lines each = ~60 lines total) + 2 plugin URL fixes. Add to build-order Phase 2.

### 2.3 Worker Session Mapping

The `agent_sessions` JSONB column stores a map of session-type → session-id:

```json
{
  "main": "opc-sess-aaa-111",
  "narrative-loop": "opc-sess-bbb-222",
  "reconcile-loop": "opc-sess-ccc-333"
}
```

**Registration flow**:
1. Agent container starts → `docker-entrypoint.sh` creates the main opencode session → `POST /internal/agent-session { sessionId: "opc-sess-aaa-111", sessionType: "main" }`
2. `narrative-loop.ts` worker starts → creates its own session → `POST /internal/agent-session { sessionId: "opc-sess-bbb-222", sessionType: "narrative-loop" }`
3. `reconcile-loop.ts` worker starts → creates its own session → `POST /internal/agent-session { sessionId: "opc-sess-ccc-333", sessionType: "reconcile-loop" }`

**Routing**:
- `insertSystemMessage` (user-facing prompts, schedulers) → `getAgentSessionId(pool, userId)` → reads `agent_session_id` column (the main session)
- `narrative-consolidation` scheduler → `getAgentSessionForWorker(pool, userId, 'narrative-loop')` → reads `agent_sessions->narrative-loop`
- `reconcile` scheduler → `getAgentSessionForWorker(pool, userId, 'reconcile-loop')` → reads `agent_sessions->reconcile-loop`

**Session recreation**: When the agent container restarts, it creates new sessions and re-registers. The UPSERT overwrites the old session IDs. Stale sessions age out naturally (opencode garbage-collects abandoned sessions). The `main` registration always updates both `agent_session_id` and `agent_sessions->main` atomically.

**Multi-tenant**: The `user_id` comes from the auth token claim (not a body param), so each user's agent registers independently. The schema supports multiple users each with their own session map.

### 2.4 `system-message.ts` Modification

#### Full modified function (showing the added triggerAgent block):

The `insertSystemMessage` function signature is unchanged. The triggerAgent call is added after the FCM notification block, before the return. The PG insert, NOTIFY (via trigger), FCM, and failure tracking all stay.

**Diff** (unified format, against current `system-message.ts`):

```diff
--- a/packages/gateway/src/utils/system-message.ts
+++ b/packages/gateway/src/utils/system-message.ts
@@ -1,5 +1,7 @@
 import crypto from 'node:crypto';
 import type { Pool } from 'pg';
+import { triggerAgent, getAgentSessionId } from './agent-trigger.js';
 import { sendFCMNotification } from './fcm-sender.js';
 import { logger } from './logger.js';
 import { recordTickOk, recordTickError } from './scheduler-health.js';
```

At the end of the function, after the FCM block (line 157) and before `return messageId;` (line 159):

```diff
+  // Agent trigger (dual-run-variant Phase 2): when OPENCODE_SERVER_URL is set
+  // (opencode variant), deliver the prompt to the agent's opencode session via
+  // HTTP. When empty (Claude Code variant), this is a no-op — the existing PG
+  // NOTIFY → channel bridge flow handles delivery. The trigger is fire-and-
+  // forget: if it fails, the stuck-message-sweep pass A retries it on the next
+  // tick (alongside re-emitting pg_notify for the Claude Code variant).
+  if (messageId && process.env.OPENCODE_SERVER_URL) {
+    void (async () => {
+      try {
+        const sessionId = await getAgentSessionId(pool, userId);
+        if (!sessionId) {
+          logger.warn('[SystemMessage][trigger] No agent session registered — sweep will retry', {
+            userId,
+            messageId,
+          });
+          return;
+        }
+        await triggerAgent(sessionId, {
+          content: fullContent,
+          metadata: {
+            ...(sourceRouting ? { source: sourceRouting } : {}),
+            ...(schedulerEvent ? { scheduler: schedulerEvent } : {}),
+          },
+        });
+      } catch (err) {
+        // Do NOT swallow — log loudly. The row stays pending; the
+        // stuck-message-sweep will re-notify it (triggerAgent + pg_notify)
+        // on the next tick, up to maxRenotifies attempts.
+        logger.warn('[SystemMessage][trigger] Agent trigger failed — sweep will retry', {
+          messageId,
+          userId,
+          error: err instanceof Error ? err.message : String(err),
+        });
+      }
+    })();
+  }

   return messageId;
 }
```

#### Full modified `insertSystemMessage` function (for clarity):

```typescript
export async function insertSystemMessage(
  pool: Pool,
  userId: string,
  content: string,
  notify?: NotifyOptions,
  schedulerEvent?: SchedulerEventMeta,
  sourceRouting?: SourceRoutingMeta,
): Promise<string | null> {
  let messageId: string | null = null;

  // Build metadata
  const metadata: Record<string, unknown> = {};
  if (schedulerEvent) {
    metadata.scheduler = schedulerEvent.scheduler;
    metadata.event_id = schedulerEvent.event_id;
    metadata.fired_at = schedulerEvent.fired_at;
  }
  if (sourceRouting) {
    metadata.source = sourceRouting;
  }

  // Append event_id to content so the agent can reference it
  const fullContent = schedulerEvent
    ? `${content}\n[event_id: ${schedulerEvent.event_id}]`
    : content;

  try {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO chat_messages (user_id, conversation_id, channel, direction, role, content, status, metadata)
       VALUES ($1, gen_random_uuid(), 'system', 'inbound', 'system', $2, 'pending', $3)
       RETURNING id`,
      [userId, fullContent, JSON.stringify(metadata)],
    );
    messageId = result.rows[0]?.id ?? null;
    if (schedulerEvent?.scheduler) {
      recordTickOk(schedulerEvent.scheduler);
    }
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    const errCode = (err as { code?: string } | null)?.code ?? null;
    failureStats.total_failures += 1;
    failureStats.last_failure_at = new Date().toISOString();
    failureStats.last_error = errMessage;
    failureStats.last_error_code = errCode;
    const schedulerName = schedulerEvent?.scheduler ?? 'ad_hoc';
    failureStats.recent_by_scheduler[schedulerName] =
      (failureStats.recent_by_scheduler[schedulerName] ?? 0) + 1;
    if (schedulerEvent?.scheduler) {
      recordTickError(schedulerEvent.scheduler, err);
    }
    logger.error('[SystemMessage][insert] Failed to insert system message', {
      error: errMessage,
      error_code: errCode,
      user_id: userId,
      scheduler: schedulerEvent?.scheduler ?? null,
      event_id: schedulerEvent?.event_id ?? null,
      content_prefix: fullContent.slice(0, 120),
      total_failures: failureStats.total_failures,
    });
  }

  // Send FCM notification if requested. Fire this even when the DB write
  // failed — the user still needs to know about whatever this message was
  // conveying, and the push is independent of the chat row.
  if (notify) {
    const truncBody = content.length > 200 ? content.slice(0, 200) + '...' : content;
    await sendFCMNotification(pool, userId, {
      title: notify.title,
      body: truncBody,
      type: notify.type,
      priority: notify.priority,
    });
  }

  // Agent trigger (dual-run-variant Phase 2): when OPENCODE_SERVER_URL is set
  // (opencode variant), deliver the prompt to the agent's opencode session via
  // HTTP. When empty (Claude Code variant), this is a no-op — the existing PG
  // NOTIFY → channel bridge flow handles delivery. The trigger is fire-and-
  // forget: if it fails, the stuck-message-sweep pass A retries it on the next
  // tick (alongside re-emitting pg_notify for the Claude Code variant).
  if (messageId && process.env.OPENCODE_SERVER_URL) {
    void (async () => {
      try {
        const sessionId = await getAgentSessionId(pool, userId);
        if (!sessionId) {
          logger.warn('[SystemMessage][trigger] No agent session registered — sweep will retry', {
            userId,
            messageId,
          });
          return;
        }
        await triggerAgent(sessionId, {
          content: fullContent,
          metadata: {
            ...(sourceRouting ? { source: sourceRouting } : {}),
            ...(schedulerEvent ? { scheduler: schedulerEvent } : {}),
          },
        });
      } catch (err) {
        logger.warn('[SystemMessage][trigger] Agent trigger failed — sweep will retry', {
          messageId,
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }

  return messageId;
}
```

### 2.5 `stuck-message-sweep.ts` Modification

The sweep's pass A (`renotifyLostPending`) currently re-emits `pg_notify` for lost pending rows. We add a `triggerAgent` call alongside `pg_notify` so the opencode variant also gets re-notified. This serves as the redelivery mechanism — if the initial `triggerAgent` call in `insertSystemMessage` failed, the sweep retries it.

**Diff** (unified format):

```diff
--- a/packages/gateway/src/scheduler/stuck-message-sweep.ts
+++ b/packages/gateway/src/scheduler/stuck-message-sweep.ts
@@ -1,5 +1,8 @@
 import type { Pool } from 'pg';
+import { triggerAgent, getAgentSessionId } from '../utils/agent-trigger.js';
 import { logger } from '../utils/logger.js';
+
+import type { SourceRoutingMeta, SchedulerEventMeta } from '../utils/system-message.js';
```

In `renotifyLostPending`, after the existing `pg_notify` query and the log statement (after line 135), add the triggerAgent redelivery loop:

```diff
     const result = await this.pool.query(sql, params);
     if (result.rowCount && result.rowCount > 0) {
       logger.warn('[StuckMessageSweep][renotify] Re-notified lost pending rows', {
         count: result.rowCount,
         ids: result.rows.map((r) => r.id),
         attempts: result.rows.map((r) => r.attempt),
         renotifyAfterMinutes,
       });
+      // Agent trigger redelivery (dual-run-variant Phase 2): alongside
+      // pg_notify (which re-notifies the Claude Code channel bridge), also
+      // call triggerAgent for the opencode variant. This is the redelivery
+      // mechanism — if the initial triggerAgent in insertSystemMessage
+      // failed, the sweep retries it here. Fire-and-forget per row; a
+      // failure here just means the next sweep tick tries again (up to
+      // maxRenotifies, after which pass B flips the row to delivered).
+      if (process.env.OPENCODE_SERVER_URL) {
+        for (const row of result.rows) {
+          void (async () => {
+            try {
+              const sessionId = await getAgentSessionId(this.pool, row.user_id);
+              if (!sessionId) return;
+              const meta = row.metadata as Record<string, unknown> | null;
+              const source = meta?.source as SourceRoutingMeta | undefined;
+              const scheduler = meta
+                ? ({
+                    scheduler: meta.scheduler,
+                    event_id: meta.event_id,
+                    fired_at: meta.fired_at,
+                  } as SchedulerEventMeta | undefined)
+                : undefined;
+              await triggerAgent(sessionId, {
+                content: row.content,
+                metadata: {
+                  ...(source ? { source } : {}),
+                  ...(scheduler ? { scheduler } : {}),
+                },
+              });
+            } catch (err) {
+              logger.warn('[StuckMessageSweep][renotify] triggerAgent redelivery failed', {
+                id: row.id,
+                user_id: row.user_id,
+                error: err instanceof Error ? err.message : String(err),
+              });
+            }
+          })();
+        }
+      }
     }
   }
```

The RETURNING clause already returns `id, user_id, content, metadata` — all fields needed to reconstruct the trigger payload. No SQL change required.

**Note on row typing**: The query returns `row.metadata` as a JSON-parsed object (pg driver auto-parses JSONB). The `source` and `scheduler`/`event_id`/`fired_at` fields are extracted from it. If `metadata` is null (old rows), the trigger fires with no metadata — the agent still gets the content.

### 2.6 Test Updates

#### 2.6.1 `stuck-message-sweep.test.ts` — Add triggerAgent mock

The test uses the real `StuckMessageSweep` class with a mocked pool. After the modification, the sweep imports `triggerAgent` and `getAgentSessionId` from `agent-trigger.js`. The test must mock that module to avoid network calls.

**Modified test file** (showing additions to the existing file):

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';

// Mock agent-trigger BEFORE importing the sweep (vi.mock is hoisted).
// These mocks prevent network calls when OPENCODE_SERVER_URL leaks from env.
const triggerAgentMock = vi.fn().mockResolvedValue(undefined);
const getAgentSessionIdMock = vi.fn().mockResolvedValue('sess-test-123');
vi.mock('../utils/agent-trigger.js', () => ({
  triggerAgent: (...a: unknown[]) => triggerAgentMock(...a),
  getAgentSessionId: (...a: unknown[]) => getAgentSessionIdMock(...a),
}));

import { StuckMessageSweep } from '../scheduler/stuck-message-sweep.js';

interface QueryCall { sql: string; params: unknown[] }

function poolCapture(results: Array<{ rowCount: number; rows: Array<Record<string, unknown>> }>): {
  pool: Pool;
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  let i = 0;
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    return results[Math.min(i++, results.length - 1)] ?? { rowCount: 0, rows: [] };
  });
  return { pool: { query } as unknown as Pool, calls };
}

const mk = (pool: Pool) =>
  new StuckMessageSweep(pool, {
    intervalMinutes: 10,
    stuckAfterMinutes: 30,
    renotifyAfterMinutes: 3,
    maxRenotifies: 3,
    channels: ['system'],
    userId: 'f08f46b3-0a9c-41ae-9e6a-294c697424e4',
  });

const tick = (s: StuckMessageSweep) => (s as unknown as { tick: () => Promise<void> }).tick();

describe('StuckMessageSweep (lost-NOTIFY recovery, 2026-07-03)', () => {
  beforeEach(() => {
    triggerAgentMock.mockClear();
    getAgentSessionIdMock.mockClear();
  });

  afterEach(() => {
    delete process.env.OPENCODE_SERVER_URL;
  });

  it('pass A re-notifies pending rows via pg_notify with the insert-trigger payload shape', async () => {
    const { pool, calls } = poolCapture([
      { rowCount: 2, rows: [{ id: 'a', attempt: 1 }, { id: 'b', attempt: 2 }] },
      { rowCount: 0, rows: [] },
    ]);
    await tick(mk(pool));

    expect(calls).toHaveLength(2);
    const renotify = calls[0];
    expect(renotify.sql).toContain("status = 'pending'");
    expect(renotify.sql).toContain('re_notify_count');
    expect(renotify.sql).toContain('pg_notify');
    expect(renotify.sql).toContain("'new_message'");
    expect(renotify.params).toEqual([
      ['system'], 3, 3, 'f08f46b3-0a9c-41ae-9e6a-294c697424e4',
    ]);
    expect(renotify.sql).not.toContain("SET status = 'delivered'");
  });

  it('pass A never re-notifies processing rows (the channel already received them)', async () => {
    const { pool, calls } = poolCapture([{ rowCount: 0, rows: [] }]);
    await tick(mk(pool));
    expect(calls[0].sql).toContain("status = 'pending'");
    expect(calls[0].sql).not.toContain('processing');
  });

  it('pass B flips processing rows unconditionally but pending rows only after re-notifies are exhausted', async () => {
    const { pool, calls } = poolCapture([
      { rowCount: 0, rows: [] },
      { rowCount: 1, rows: [{ id: 'c', re_notify_count: null }] },
    ]);
    await tick(mk(pool));
    const flip = calls[1];
    expect(flip.sql).toContain("SET status = 'delivered'");
    expect(flip.sql).toContain("status = 'processing'");
    expect(flip.sql).toMatch(/status = 'pending' AND COALESCE\(\(metadata->>'re_notify_count'\)::int, 0\) >= \$3/);
    expect(flip.params).toEqual([
      ['system'], 30, 3, 'f08f46b3-0a9c-41ae-9e6a-294c697424e4',
    ]);
  });

  it('a pass-A failure does not prevent pass B from running', async () => {
    const calls: QueryCall[] = [];
    let first = true;
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      if (first) {
        first = false;
        throw new Error('renotify boom');
      }
      return { rowCount: 0, rows: [] };
    });
    await tick(mk({ query } as unknown as Pool));
    expect(calls).toHaveLength(2);
    expect(calls[1].sql).toContain("SET status = 'delivered'");
  });

  it('scopes both passes to the configured user', async () => {
    const { pool, calls } = poolCapture([{ rowCount: 0, rows: [] }]);
    await tick(mk(pool));
    for (const c of calls) {
      expect(c.sql).toContain('AND user_id = $4::uuid');
    }
  });

  // --- New tests: triggerAgent redelivery (dual-run-variant Phase 2) ---

  it('pass A does NOT call triggerAgent when OPENCODE_SERVER_URL is unset (Claude Code variant)', async () => {
    delete process.env.OPENCODE_SERVER_URL;
    const { pool } = poolCapture([
      { rowCount: 2, rows: [
        { id: 'a', attempt: 1, user_id: 'u1', content: 'hello', metadata: {} },
        { id: 'b', attempt: 2, user_id: 'u1', content: 'world', metadata: {} },
      ] },
      { rowCount: 0, rows: [] },
    ]);
    await tick(mk(pool));
    expect(triggerAgentMock).not.toHaveBeenCalled();
  });

  it('pass A calls triggerAgent for each re-notified row when OPENCODE_SERVER_URL is set (opencode variant)', async () => {
    process.env.OPENCODE_SERVER_URL = 'http://agent:4096';
    const { pool } = poolCapture([
      { rowCount: 2, rows: [
        { id: 'a', attempt: 1, user_id: 'u1', content: 'hello', metadata: { source: { platform: 'whatsapp' } } },
        { id: 'b', attempt: 2, user_id: 'u1', content: 'world', metadata: { scheduler: 'evening-close', event_id: 'evt_1', fired_at: '2026-07-08T20:30:00Z' } },
      ] },
      { rowCount: 0, rows: [] },
    ]);
    await tick(mk(pool));

    // Fire-and-forget — wait for microtasks to flush
    await new Promise((r) => setTimeout(r, 0));

    expect(triggerAgentMock).toHaveBeenCalledTimes(2);
    // First row: source routing metadata
    expect(triggerAgentMock.mock.calls[0][1]).toMatchObject({
      content: 'hello',
      metadata: { source: { platform: 'whatsapp' } },
    });
    // Second row: scheduler event metadata
    expect(triggerAgentMock.mock.calls[1][1]).toMatchObject({
      content: 'world',
      metadata: { scheduler: { scheduler: 'evening-close', event_id: 'evt_1', fired_at: '2026-07-08T20:30:00Z' } },
    });
  });

  it('pass A triggerAgent failure does not crash the sweep (fire-and-forget)', async () => {
    process.env.OPENCODE_SERVER_URL = 'http://agent:4096';
    triggerAgentMock.mockRejectedValueOnce(new Error('connection refused'));
    const { pool } = poolCapture([
      { rowCount: 1, rows: [
        { id: 'a', attempt: 1, user_id: 'u1', content: 'hello', metadata: {} },
      ] },
      { rowCount: 0, rows: [] },
    ]);
    // Should not throw — the error is caught in the fire-and-forget IIFE
    await expect(tick(mk(pool))).resolves.not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});
```

#### 2.6.2 New file: `system-message.test.ts`

There is currently no dedicated test file for `system-message.ts`. All consumer tests mock the module via `vi.mock('../utils/system-message.js', ...)`, which replaces `insertSystemMessage` with a stub — so the internal `triggerAgent` call is already isolated in those tests. However, we should create a dedicated test for the new triggerAgent integration in `insertSystemMessage`.

New file: `packages/gateway/src/__tests__/system-message.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';

// Mock agent-trigger BEFORE importing system-message (vi.mock is hoisted).
const triggerAgentMock = vi.fn().mockResolvedValue(undefined);
const getAgentSessionIdMock = vi.fn().mockResolvedValue('sess-abc-123');
vi.mock('../utils/agent-trigger.js', () => ({
  triggerAgent: (...a: unknown[]) => triggerAgentMock(...a),
  getAgentSessionId: (...a: unknown[]) => getAgentSessionIdMock(...a),
}));

// Mock FCM + scheduler-health so the real insertSystemMessage can run without
// network calls or cross-module state.
vi.mock('../utils/fcm-sender.js', () => ({
  sendFCMNotification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../utils/scheduler-health.js', () => ({
  recordTickOk: vi.fn(),
  recordTickError: vi.fn(),
}));

import { insertSystemMessage, createSchedulerEvent } from '../utils/system-message.js';

const USER_ID = 'f08f46b3-0a9c-41ae-9e6a-294c697424e4';

function poolWith(insertId: string | null): Pool {
  const query = vi.fn(async () => ({
    rows: insertId ? [{ id: insertId }] : [],
    rowCount: insertId ? 1 : 0,
  }));
  return { query } as unknown as Pool;
}

describe('insertSystemMessage — agent trigger integration (Phase 2)', () => {
  beforeEach(() => {
    triggerAgentMock.mockClear();
    getAgentSessionIdMock.mockClear();
    getAgentSessionIdMock.mockResolvedValue('sess-abc-123');
  });

  afterEach(() => {
    delete process.env.OPENCODE_SERVER_URL;
  });

  it('does NOT call triggerAgent when OPENCODE_SERVER_URL is unset (Claude Code variant)', async () => {
    delete process.env.OPENCODE_SERVER_URL;
    await insertSystemMessage(poolWith('msg-1'), USER_ID, 'test content');
    expect(triggerAgentMock).not.toHaveBeenCalled();
  });

  it('calls triggerAgent with full content and metadata when OPENCODE_SERVER_URL is set', async () => {
    process.env.OPENCODE_SERVER_URL = 'http://agent:4096';
    const evt = createSchedulerEvent('evening-close');
    const source = { platform: 'whatsapp', remote_jid: '123@s.whatsapp.net', from_me: false };

    await insertSystemMessage(poolWith('msg-2'), USER_ID, '[Evening Close] Run skill', undefined, evt, source);

    // Fire-and-forget — flush microtasks
    await new Promise((r) => setTimeout(r, 0));

    expect(getAgentSessionIdMock).toHaveBeenCalledWith(expect.anything(), USER_ID);
    expect(triggerAgentMock).toHaveBeenCalledTimes(1);
    const [sessionId, payload] = triggerAgentMock.mock.calls[0];
    expect(sessionId).toBe('sess-abc-123');
    expect(payload.content).toContain('[Evening Close] Run skill');
    expect(payload.content).toContain(`[event_id: ${evt.event_id}]`);
    expect(payload.metadata).toEqual({ source, scheduler: evt });
  });

  it('does NOT call triggerAgent when the PG insert fails (no messageId)', async () => {
    process.env.OPENCODE_SERVER_URL = 'http://agent:4096';
    const pool = {
      query: vi.fn(async () => { throw new Error('DB connection lost'); }),
    } as unknown as Pool;

    await insertSystemMessage(pool, USER_ID, 'test content');
    await new Promise((r) => setTimeout(r, 0));

    expect(triggerAgentMock).not.toHaveBeenCalled();
  });

  it('does NOT call triggerAgent when no agent session is registered', async () => {
    process.env.OPENCODE_SERVER_URL = 'http://agent:4096';
    getAgentSessionIdMock.mockResolvedValue(null);

    await insertSystemMessage(poolWith('msg-3'), USER_ID, 'test content');
    await new Promise((r) => setTimeout(r, 0));

    expect(triggerAgentMock).not.toHaveBeenCalled();
  });

  it('triggerAgent failure does NOT crash insertSystemMessage (fire-and-forget)', async () => {
    process.env.OPENCODE_SERVER_URL = 'http://agent:4096';
    triggerAgentMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    // Should resolve normally — the trigger is fire-and-forget
    const result = await insertSystemMessage(poolWith('msg-4'), USER_ID, 'test content');
    expect(result).toBe('msg-4');
    await new Promise((r) => setTimeout(r, 0));
    expect(triggerAgentMock).toHaveBeenCalledTimes(1);
  });

  it('passes noReply flag through to triggerAgent when set', async () => {
    process.env.OPENCODE_SERVER_URL = 'http://agent:4096';
    await insertSystemMessage(poolWith('msg-5'), USER_ID, 'silent ping');
    await new Promise((r) => setTimeout(r, 0));
    // noReply is not currently set by insertSystemMessage (it's for future
    // use by schedulers that want a silent ack). Verify the default (unset).
    expect(triggerAgentMock.mock.calls[0][1].noReply).toBeUndefined();
  });
});
```

#### 2.6.3 Consumer tests — NO CHANGES needed

All existing tests that mock `insertSystemMessage` via `vi.mock('../utils/system-message.js', ...)` are unaffected. The mock replaces the entire module, so the internal `triggerAgent` call never executes. Verified categories:

- `alerting.test.ts` — mocks `insertSystemMessage` ✓
- `evening-close.test.ts` — mocks `insertSystemMessage` ✓
- `wake-scheduler.test.ts` — mocks `insertSystemMessage` ✓
- `habit-scheduler.test.ts` — mocks `insertSystemMessage` ✓
- `composite-triggers.test.ts` — mocks `insertSystemMessage` ✓
- `journal-consolidation.test.ts` — mocks `insertSystemMessage` ✓
- `message-processor.test.ts` — mocks `insertSystemMessage` ✓
- `me-vault.test.ts` — mocks `insertSystemMessage` ✓
- `location-transition.test.ts` — mocks `insertSystemMessage` ✓
- `whatsapp-webhook-scoping.test.ts` — mocks `insertSystemMessage` ✓
- `message-batch-review.test.ts` — spies on `insertSystemMessage` ✓

**Defensive measure**: Add `delete process.env.OPENCODE_SERVER_URL` to a global test setup file to prevent env leakage from causing unexpected `fetch` calls in any test that uses the real `system-message.ts`:

```typescript
// packages/gateway/src/__tests__/setup.ts (or vitest.config.ts globalSetup)
beforeEach(() => {
  delete process.env.OPENCODE_SERVER_URL;
});
```

If the project uses a `vitest.config.ts`, add this to the `setupFiles` array. If not, add it to the top of the two test files that touch the real modules (`stuck-message-sweep.test.ts` and the new `system-message.test.ts`).

### 2.7 Acceptance Criteria (Phase 2)

#### Verification steps:

```bash
# 1. Migration 039 exists and is idempotent
test -f packages/gateway/src/migrations/039_agent_session_id.sql && echo "OK" || echo "FAIL"
# Run it against a test DB:
psql -d ll5_test -f packages/gateway/src/migrations/039_agent_session_id.sql
# Run again — should not error (IF NOT EXISTS):
psql -d ll5_test -f packages/gateway/src/migrations/039_agent_session_id.sql && echo "OK: idempotent"

# 2. Verify columns exist
psql -d ll5_test -c "\d user_settings" | grep agent_session_id && echo "OK: agent_session_id" || echo "FAIL"
psql -d ll5_test -c "\d user_settings" | grep agent_sessions && echo "OK: agent_sessions" || echo "FAIL"

# 3. agent-trigger.ts compiles
npx tsc --noEmit --project packages/gateway/tsconfig.json && echo "OK: typecheck" || echo "FAIL"

# 4. Tests pass
npm run test --workspace=packages/gateway -- --reporter=verbose 2>&1 | tail -20
# Expected: all tests pass including new system-message.test.ts and modified stuck-message-sweep.test.ts

# 5. Trigger is a no-op when OPENCODE_SERVER_URL is unset
OPENCODE_SERVER_URL="" node -e "
  const { triggerAgent } = require('./packages/gateway/dist/utils/agent-trigger.js');
  triggerAgent('sess-123', { content: 'test' }).then(() => console.log('OK: no-op'));
"

# 6. Endpoint exists and requires auth
# (requires running gateway — test against local dev instance)
curl -s -X POST http://localhost:3000/internal/agent-session \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"test"}' | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'error' in d or 'ok' in d; print('OK')"
# Without auth token → 401

# 7. Session registration stores correctly
TOKEN="<valid-ll5-token>"
curl -s -X POST http://localhost:3000/internal/agent-session \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"opc-test-123","sessionType":"main"}' | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('ok') is True; print('OK')"
psql -d ll5 -c "SELECT agent_session_id, agent_sessions FROM user_settings WHERE user_id = (SELECT uid FROM ...)" # verify row

# 8. Worker session registration
curl -s -X POST http://localhost:3000/internal/agent-session \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"opc-worker-456","sessionType":"narrative-loop"}' | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('ok') is True; print('OK')"
psql -d ll5 -c "SELECT agent_sessions->'narrative-loop' FROM user_settings WHERE ..."

# 9. Invalid sessionType rejected
curl -s -X POST http://localhost:3000/internal/agent-session \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"x","sessionType":"bad"}' | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'error' in d; print('OK: rejected')"

# 10. Missing sessionId rejected
curl -s -X POST http://localhost:3000/internal/agent-session \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"sessionType":"main"}' | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'error' in d; print('OK: rejected')"
```

#### Behavioral verification (post-deploy with Claude Code variant — OPENCODE_SERVER_URL empty):

- Gateway starts without error
- Migration 039 applies cleanly
- All existing tests pass
- All schedulers fire normally (insertSystemMessage works as before)
- No `fetch` calls to `http://agent:4096` in logs (trigger is no-op)
- No `[agent-trigger]` log lines (env var is empty)
- Agent receives prompts via the existing PG NOTIFY → channel bridge flow (unchanged)
- `/internal/agent-session` endpoint returns 401 without auth, 400 with bad input, 200 with valid input

#### Behavioral verification (post-deploy with opencode variant — OPENCODE_SERVER_URL set):

- Agent container starts, calls `POST /internal/agent-session` with `sessionType: "main"`
- `user_settings.agent_session_id` is populated
- Gateway `insertSystemMessage` calls `triggerAgent` → `POST http://agent:4096/session/<id>/prompt_async`
- Agent receives the prompt with `[meta] {...}` context part containing source routing + scheduler event
- If `triggerAgent` fails (agent down), the row stays pending → stuck-message-sweep pass A retries `triggerAgent` alongside `pg_notify`
- After `maxRenotifies` (3), pass B flips the row to `delivered` and logs `[StuckMessageSweep][lost]` at error level (loud failure, not silent)

---

## File Change Summary

### New files:

| Path | Phase |
|---|---|
| `packages/ll5-run-shared/CLAUDE.md` | 1 |
| `packages/ll5-run-shared/skills/*/SKILL.md` (17 files) | 1 |
| `packages/ll5-run-shared/prompts/narrative-loop.md` | 1 |
| `packages/ll5-run-shared/prompts/reconcile-loop.md` | 1 |
| `packages/ll5-run-shared/mcp-endpoints.json` | 1 |
| `packages/ll5-run-shared/README.md` | 1 |
| `scripts/render-mcp-config.ts` | 1 |
| `packages/gateway/src/utils/agent-trigger.ts` | 2 |
| `packages/gateway/src/migrations/039_agent_session_id.sql` | 2 |
| `packages/gateway/src/__tests__/system-message.test.ts` | 2 |

### Modified files:

| Path | Phase | Change |
|---|---|---|
| `.github/workflows/build-and-push.yml` | 1 | Add `ll5-run-shared` change detection (lines 40-53) |
| `packages/gateway/src/utils/system-message.ts` | 2 | Import `triggerAgent`/`getAgentSessionId`, add trigger block at end of `insertSystemMessage` |
| `packages/gateway/src/scheduler/stuck-message-sweep.ts` | 2 | Import `triggerAgent`/`getAgentSessionId`, add redelivery loop in `renotifyLostPending` |
| `packages/gateway/src/server.ts` | 2 | Add `POST /internal/agent-session` endpoint (after line 640) |
| `packages/gateway/src/__tests__/stuck-message-sweep.test.ts` | 2 | Mock `agent-trigger.js`, add 3 new tests for triggerAgent redelivery |

### Unchanged files:

All other gateway code — schedulers, monitors, alerting, webhook processors, REST endpoints, admin, approvals, vault, chat, all MCP servers, all other tests. The trigger is additive and env-gated; when `OPENCODE_SERVER_URL` is empty, behavior is identical to the current system.
