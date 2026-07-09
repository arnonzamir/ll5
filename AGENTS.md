# LL5 — agent instructions

## Caveman mode

Tone rules in `.opencode/AGENTS.md`. Code/commits/PRs written normal.

## Repo overview

npm workspaces monorepo at `packages/*` (15 packages). TypeScript, Node16 modules, ES2022.

**Architecture:** MCP servers (data layer) + Express gateway + Next.js dashboard. Agent runtime is a separate repo (`ll5-run-claude-code` or `ll5-run-opencode`). Shared agent content (persona, skills, prompts) in `packages/ll5-run-shared/`.

| Layer | Packages |
|-------|----------|
| MCPs | `personal-knowledge` (ES), `gtd` (PG), `awareness` (ES), `google` (PG), `messaging` (PG), `health` (ES+PG), `vault` (ES+bw), `system` (local stdio) |
| HTTP | `gateway` (Express), `dashboard` (Next.js 15), `agent-orchestrator` |
| Shared | `shared` (utils, auth, location), `ll5-auth`, `ll5-run-shared`, `findhub-poller` |

## Commands

```sh
npm run build          # build all packages
npm run typecheck      # tsc --noEmit per package (loops manually — must use this)
npm test               # all packages
npm test -w packages/gtd   # single package
npx vitest run         # inside a package, single run
npx vitest             # inside a package, watch mode
```

Typecheck before test. Both must pass before commit.

## Local dev

`docker/docker-compose.yml` — ES + PG for local dev.

### ll5 dev commands

Script: `scripts/ll5.sh` (symlinked to `/usr/local/bin/ll5` on dev machines).

| Command | Action |
|---------|--------|
| `ll5` | attach to tmux session `opencode` on agent container |
| `ll5 new` | kill + restart opencode TUI in tmux |
| `ll5 logs` | tail `/tmp/opencode.log` |
| `ll5 restart` | restart `opencode serve` on port 4096 |
| `ll5 stop` | kill opencode inside container |
| `ll5 exec …` | `docker exec agent …` with TTY |
| `ll5 shell` | raw ssh on agent container |

Defaults overridable: `LL5_CONTAINER`, `LL5_TMUX_SESSION`, `LL5_HOST`, `LL5_SSH_PORT`, `LL5_PASS`.

### Variant switch

`AGENT_VARIANT` env var on host:
- `claude` → legacy gateway client container
- `opencode` → `agent` container, opencode on :4096

Rollback: change `AGENT_VARIANT`, redeploy.

## Session start

Read these before acting:
- `docs/PROGRESS.md` — current status, recent changes, known issues
- `docs/HANDOFF.md` — server details, auth, DBs, deploy procedures, incident history
- `docs/opencode-variant-deployment.md` — opencode variant architecture, deployment, known issues

## Pre-commit rules

Every commit MUST update:
- `docs/PROGRESS.md` — status, changes, issues, tech debt
- `docs/HANDOFF.md` — everything to continue working
- `docs/FILE_TREE.md` — annotated source tree

Architectural decisions go in `docs/decisions/DECISION-NNN.md` (context, decision, alternatives, consequences).

## Testing rules

Read `docs/testing.md` for full standard. Key points:
- Test must import and invoke the code it claims to test (no theater)
- Mock at external boundary (pg.Pool, ES client), never the code under test
- Every repository test MUST assert `user_id` scoping — most important property
- Reference implementations: `packages/gateway/src/__tests__/notification-rules.test.ts` (repository), `packages/gateway/src/__tests__/chat-conversations.test.ts` (route handler)
- Do NOT use `person-repository.test.ts` as template (known-bad pattern)

## Deploy rules

- **Deploy via `git push` to main** (CI builds + deploys). NEVER use Coolify MCP `deploy` for data-plane — it rewrites compose from stale copy. Coolify MCP deploy is only for `ll5-run` agent app.
- `docker/docker-compose.prod.yml` is source of truth. Never edit on host. CI runs drift check on every push + daily.
- `GHCR_READ_PAT` on host (not `GITHUB_TOKEN`) — ephemeral token clobbers shared creds.

## Git conventions

- Only commit/amend/push/PR when explicitly asked
- `.mcp.json`, `.claude/`, `.env` are gitignored (may hold secrets)
