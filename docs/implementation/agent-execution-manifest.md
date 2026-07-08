# Agent Execution Manifest

## Execution Scope

What can be done from this workspace:
- Phase 0: Rename repo on GitHub (gh CLI) — yes
- Phase 1: Clone ll5-run, extract shared content, write render script — yes
- Phase 2: Write gateway code in this repo — yes
- Phase 2.5: Run opencode locally with minimal plugins against live MCPs — yes (opencode v1.17.15 installed)
- Phase 3: Create ll5-run-opencode repo, write all plugins — yes
- Phase 4: Write Dockerfiles, extend CI, update compose — yes
- Phase 4.5: Stop old container, migrate volumes — NO (requires SSH to host)
- Phase 5: Deploy to host — NO (requires SSH to host)
- Phase 6: Switch and use — NO (requires host access)

**Verdict**: Phases 0-4 + 2.5 can be executed. Phases 4.5-6 require host access and will be documented as runbook steps.

## Agent Order

### Wave 1 (parallel — no file conflicts)

| Agent | Phase | Touches | Writes |
|---|---|---|---|
| A | 0 | GitHub (rename repo) | No files |
| B | 1 | `packages/ll5-run-shared/` (new), `scripts/render-mcp-config.ts` (new) | New files only |
| C | 2 | `packages/gateway/src/utils/agent-trigger.ts` (new), `packages/gateway/src/utils/system-message.ts` (modify), `packages/gateway/src/scheduler/stuck-message-sweep.ts` (modify), `packages/gateway/src/migrations/039_agent_session_id.sql` (new), `packages/gateway/src/server.ts` (modify — add endpoints), tests | Gateway package |
| D | 4 | `docker/Dockerfile.ll5-run-claude` (new), `docker/Dockerfile.ll5-run-opencode` (new), `.github/workflows/build-and-push.yml` (modify), `docker/docker-compose.prod.yml` (modify) | Docker + CI |
| E | 3 | New repo `ll5-run-opencode` on GitHub + all plugin/worker/config files | New repo |

### Wave 2 (after Wave 1)

| Agent | Task | Purpose |
|---|---|---|
| F | Verify | Run `npm run typecheck` + `npm run test` on gateway package. Fix any compilation errors. |
| G | Phase 2.5 | Run opencode locally with minimal plugins against live remote MCPs. Validate 8 assumptions in 1 hour. |

### Watchdog (runs throughout)

| Agent | Task |
|---|---|
| W | Monitor Wave 1 agents. If any agent stalls (no response for 5 min) or errors out, report it. Do NOT restart — just report status. |

### Post-execution (runbook — not automated)

| Phase | How |
|---|---|
| 4.5 | SSH to host, stop old container, migrate volume, decommission old Coolify app |
| 5 | SSH to host, set AGENT_VARIANT=opencode in .env, docker compose up -d |
| 6 | Use it. If broken: AGENT_VARIANT=claude + deploy |
