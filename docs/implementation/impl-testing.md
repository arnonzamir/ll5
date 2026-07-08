# Implementation Testing Plan — Dual Run-Variant Migration

Reality-checker document. Companion to `dual-run-variant-plan.md` (v2) and
`dual-run-build-order.md` (137 tasks). Scope: every phase (0, 1, 2, 2.5, 3, 4,
4.5, 5, 6, 7) gets loud-failure tests, silent-failure tests, regression tests,
and rollback verification. Plus the Phase 2.5 fail-fast gate, the Phase 6
behavioral-parity framework, the Phase 7 cutover monitoring plan, a reusable
silent-failure checklist, and a test-automation map.

**System context**: live, daily-used personal AI assistant. 532 commits, 161
test files, 700+ gateway tests, Coolify deploy. Silent failures are the
dominant risk class — history: 37h silent scheduler breakage (migration 023),
8-day silent ES write death (ES auth change), channel bridge double-post,
recurring GHCR credential clobber. Every gate below assumes the loud path is
already covered; the silent path is where this plan earns its keep.

**Key paths/identifiers used throughout**:

| Thing | Value |
|---|---|
| Coolify service UUID (compose) | `xkkcc0g4o48kkcows8488so4` |
| Old standalone agent Coolify UUID | `js8owk0g0cgog800ckc8ww0s` |
| Gateway (internal) | `http://gateway:3000` |
| Gateway (public) | `https://gateway.noninoni.click` |
| Dashboard | `https://ll5.noninoni.click` |
| Admin health | `GET /admin/health` (admin token) — `services`, `schedulers`, `agent_output`, `system_messages`, `fcm`, `webhook`, `databases`, `summary` |
| Public health | `GET /health` — ES ping only |
| ES indices (infra) | `ll5_session_history`, `ll5_app_log`, `ll5_audit_log`, `ll5_eval_moments`, `ll5_reconcile_metrics` |
| ES indices (awareness) | `ll5_awareness_messages`, `ll5_awareness_calendar_events`, `ll5_awareness_locations`, `ll5_agent_journal`, `ll5_knowledge_places` |
| Postgres tables | `chat_messages`, `chat_conversations`, `system_alerts`, `user_settings`, `fcm_tokens`, `agent_runtimes`, `agent_credentials` |
| Test runner | `vitest run` (per package); `npm test --workspaces` |
| Typecheck | `npm run typecheck` (root) |
| Compose drift CI | `.github/workflows/compose-drift-check.yml` |

---

## 1. Per-Phase Testing Plans

Conventions:

- **Loud failure** = errors, crashes, non-zero exit, 5xx, test red.
- **Silent failure** = container up, no error, wrong/missing output. Detect
  only by active probe.
- **Detection window** = how long the silent case can run before the check
  catches it. Keep this short; the 37h/8d incidents came from windows measured
  in days.
- Every phase ends with the **Silent Failure Detection Checklist** (§5) run
  end-to-end. No phase proceeds until every checkbox passes.

### 1.1 Phase 0 — Rename `ll5-run` → `ll5-run-claude-code`

**Loud failure tests**

| What | How | Expected | Failure |
|---|---|---|---|
| Image builds under new tag | In ll5-run-claude-code CI: trigger build after pushing renamed image tag `ghcr.io/arnonzamir/ll5-run-claude:latest` | GHCR push succeeds; `docker pull` returns the new image | CI red, push denied, 404 on pull |
| Local remotes resolve | `git remote -v` in every working copy (ll5, ll5-run-claude-code, any clones) | URL shows `arnonzamir/ll5-run-claude-code`; old `ll5-run` URL 301-redirects (GitHub keeps redirect) | `git fetch` 404, remote still points at old name |
| PAT scope | `gh api repos/arnonzamir/ll5-run-claude-code` with `VARIANT_REPO_READ_PAT` | 200 OK | 404/403 — PAT not scoped to new name |
| Doc grep | `rg -n '\bll5-run\b' docs/ packages/ .github/` in ll5 (excluding historical context) | Zero hits in live config; historical mentions allowed | Stale references remain |

**Silent failure tests**

| What to monitor | Detection | Correct | Silently wrong | Window |
|---|---|---|---|---|
| Agent runs stale image under old name | On host: `docker inspect agent-xkkcc0g4o48kkcows8488so4 \| jq '.[0].Config.Image'` (and the old standalone UUID container) | Image string `ghcr.io/arnonzamir/ll5-run-claude:latest` | Still `ghcr.io/arnonzamir/ll5-agent:latest` — container runs but never pulled new code | 1 deploy |
| Old image keeps getting pulled | `docker images \| grep ll5-agent` on host after deploy | No new `ll5-agent` rows; only the new `ll5-run-claude` | Old tag timestamps newer than the rename — someone still pulls it | 1 deploy |
| CI silently uses old image tag in a non-renamed workflow | `rg -n 'll5-agent:latest\|ll5-run:latest' .github/ packages/ docker/` | Zero hits | Hidden reference in a workflow that fires rarely | 1 grep |

**Regression tests**

- `npm run typecheck` (root) — passes.
- `npm test --workspaces` — all 161 test files green.
- Manual: send a chat message via dashboard → agent responds within 60s.
- Manual: trigger any scheduler that fires on demand (e.g. heartbeat) →
  `chat_messages` row with `metadata.scheduler='heartbeat'` appears.

**Rollback verification**

| Step | Command | "Complete" | "Failed silently" |
|---|---|---|---|
| Revert CI image tag | In ll5-run-claude-code, revert the image-tag commit; push | New CI run pushes `ghcr.io/arnonzamir/ll5-agent:latest` again | CI green but `docker images` on host shows new tag still cached/used |
| Re-deploy old image | `docker pull ghcr.io/arnonzamir/ll5-agent:latest && docker compose up -d` (or Coolify redeploy) | Agent container running old image; `docker inspect` shows old tag | Container shows "Up" but `Created` timestamp unchanged — old container not recreated |
| End-to-end | Send test chat message | Agent responds, audit log has `trace_id` populated | Agent responds but `ll5_audit_log` has zero new `tool_call` rows — audit path broken |

---

### 1.2 Phase 1 — Extract shared content to `ll5`

**Loud failure tests**

| What | How | Expected | Failure |
|---|---|---|---|
| `render-mcp-config.ts` Claude format | `npx tsx scripts/render-mcp-config.ts --format claude --output /tmp/settings.json && jq . /tmp/settings.json` | Valid JSON; 6 MCP entries with `headersHelper` pointing at `get-mcp-auth.sh` | Throws, missing MCP, invalid JSON |
| `render-mcp-config.ts` opencode format | `npx tsx scripts/render-mcp-config.ts --format opencode --output /tmp/opencode.json && jq . /tmp/opencode.json` | Valid JSON; 6 MCP entries with `headers` block | Same |
| Unit tests for renderer | `npm test --workspace=packages/shared` (or wherever the script's tests live); add a `render-mcp-config.test.ts` | All cases green: missing endpoints, empty auth, both formats | Red |
| Docker build with shared content | `docker build -f docker/Dockerfile.ll5-run-claude -t ll5-run-claude:test .` locally | Build succeeds; `docker run --rm ll5-run-claude:test ls /workspace/.claude/skills` lists 17 skills | COPY fails, missing files |
| Change-detection triggers rebuild | Push a commit touching `packages/ll5-run-shared/CLAUDE.md`; watch `detect-changes` job in `build-and-push.yml` | Matrix includes `run-claude` | Matrix empty — change-detection misses shared path |

**Silent failure tests** — *the dominant risk class for this phase*.

| What to monitor | Detection | Correct | Silently wrong | Window |
|---|---|---|---|---|
| Persona loaded into agent | After deploy, send agent a probe: "State Hard Rule 1 verbatim." | Agent returns the rule's text matching `CLAUDE.md` | Agent runs but persona empty/garbage — path reference resolved to a stale/empty file inside the container | 1 turn (immediate) |
| All 17 skills available | `docker exec agent-xkkcc0g4o48kkcows8488so4 ls /workspace/.claude/skills` after deploy | 17 dirs, each with `SKILL.md` | 16 or fewer — silent skill drop. Cross-check with `rg -c 'name:' /workspace/.claude/skills/*/SKILL.md` | 1 exec |
| `/daily` actually executes | Send `/daily` to agent | Skill runs, produces the daily-review output shape | Agent says "I don't have that skill" or runs a degraded version — skill file present but path reference inside it broken | 1 turn |
| Path references resolve in Docker context | `docker exec agent-xkkcc0g4o48kkcows8488so4 sh -c 'test -f /workspace/.claude/skills/daily/SKILL.md && echo ok'` | `ok` | Empty output — file missing in container (present in repo, COPY missed it) | 1 exec |
| Shared content drift between repos | `diff <(curl -s https://raw.githubusercontent.com/arnonzamir/ll5/main/packages/ll5-run-shared/CLAUDE.md) <(curl -s https://raw.githubusercontent.com/arnonzamir/ll5-run-claude-code/main/CLAUDE.md)` (after fallback deleted) | Empty diff | Drift — someone edited the variant copy after extraction | Weekly cron |
| Rendered MCP config matches endpoints | `jq '.mcpServers \| keys' /tmp/settings.json` equals `jq '.mcpServers \| keys' /tmp/opencode.json` equals `jq '.endpoints \| map(.name)' packages/ll5-run-shared/mcp-endpoints.json` | Three identical lists | Render mismatch — one format drops an MCP | 1 render |

**Regression tests**

- `npm test --workspaces` — all green.
- `npm run typecheck` — green.
- `compose-drift-check.yml` — passes (compose unchanged this phase).
- End-to-end: each of the 6 remote MCPs responds to a tool call from the agent
  (personal-knowledge `search`, gtd `list_inbox`, awareness `query_observations`,
  google `list_events`, messaging `check_messages`, health `query_health`).
- Audit ledger: after the 6 tool calls, `ll5_audit_log` has 6 new `kind:'tool_call'`
  rows with `session_id` + `trace_id` populated.

**Rollback verification**

| Step | Command | "Complete" | "Failed silently" |
|---|---|---|---|
| Restore fallback copy | In ll5-run-claude-code, `git revert` the deletion commit (P1-T14) — fallback copy returns | `ls .claude/skills` in repo shows 17 skills | Revert succeeds but CI still pulls from shared path — restore has no effect |
| Revert CI to in-repo content | Revert the CI commit that switched to copying from ll5 shared | New build's `/workspace/.claude/skills` matches the in-repo copy | Image still contains shared content — cache hit on the shared layer |
| Verify persona | Send the Hard-Rule-1 probe again | Agent returns the rule text | Agent still degraded — fallback copy was also broken, or the revert was incomplete |
| Verify audit ledger | Run the 6-MCP tool-call test | 6 new `tool_call` rows with correlation-ids | Audit ledger empty — MCP auth/render broken |

---

### 1.3 Phase 2 — Gateway agent-trigger abstraction

**Loud failure tests**

| What | How | Expected | Failure |
|---|---|---|---|
| Migration 039 applies | `psql $DATABASE_URL -f packages/gateway/src/migrations/039_agent_session.sql` (against a staging DB first, then prod) | `ALTER TABLE` succeeds; `user_settings.agent_session_id` is nullable text; `agent_sessions` JSONB exists | Migration throws (column already exists, type conflict, FK violation) |
| `agent-trigger.ts` unit tests | `npm test --workspace=packages/gateway -- agent-trigger` (add `agent-trigger.test.ts`) | Cases green: env empty → no fetch; env set → fetch with full payload; fetch fail → throws; null sessionId → no-op; cross-tenant → uses caller's userId | Red |
| `system-message.test.ts` updated | `npm test --workspace=packages/gateway -- system-message` | Cases green: env empty (no-op), env set (calls fetch once with metadata), fetch failure (row marked for sweep retry via metadata flag), cross-tenant negative (triggerAgent not called for other userId) | Red — fetch stub missing, real network call attempted |
| `stuck-message-sweep.test.ts` updated | `npm test --workspace=packages/gateway -- stuck-message-sweep` | Cases green: pass A re-notifies AND calls triggerAgent; env empty (no trigger); pass A failure doesn't block pass B | Red |
| `/internal/agent-session` endpoint | `curl -X POST http://localhost:3000/internal/agent-session -H "Authorization: Bearer $TOKEN" -d '{"sessionId":"uuid","sessionType":"main"}'` | 200 `{"ok":true}`; `user_settings.agent_sessions` JSON has `main:"uuid"` | 401, 500, row not updated |
| Full gateway suite | `npm test --workspace=packages/gateway` | All 700+ tests green | Any red — investigate before deploy |

**Silent failure tests**

| What to monitor | Detection | Correct | Silently wrong | Window |
|---|---|---|---|---|
| `triggerAgent` actually fires (env set) | In a staging deploy with `OPENCODE_SERVER_URL=http://localhost:9999` (a capture server): trigger a system message; capture server logs the POST | POST received with `parts[0].text` + `context[0].text` containing `[meta] {...}` | Env var leaks into Claude Code deploy → failed fetch swallowed by `.catch()` → row marked for sweep but sweep also fails → message lost | 1 turn |
| `triggerAgent` no-ops when env empty | In prod deploy with `OPENCODE_SERVER_URL=""`: send system message; check gateway logs for `[agent-trigger]` lines | Zero `[agent-trigger]` log lines | Env var accidentally set → failed HTTP calls every system message → `.catch()` noise but no agent delivery; Claude Code NOTIFY flow still works so it's invisible | 1 deploy + log scan |
| Sweep retry actually re-triggers | Insert a system message with `metadata.trigger_failed=true`; wait for next sweep tick (≤10min) | Sweep calls triggerAgent again; log line `[StuckMessageSweep][renotify]` count increments; trigger_failed flag cleared on success | Sweep flips row to delivered without retrying trigger (the pre-2026-07-03 silent-mask pattern re-emerging) | 1 sweep interval (10min) |
| PG NOTIFY still fires for Claude Code | After deploy with env empty, send system message; `docker exec gateway-xkkcc0g4o48kkcows8488so4 node -e "..."` to LISTEN on `chat_messages` channel | NOTIFY received with `event:'new_message'` | NOTIFY broken — Claude Code channel bridge never wakes; agent silent | 1 turn (agent response timeout) |
| `agent_session_id` migration didn't lock user_settings | `SELECT * FROM user_settings WHERE user_id='$USER_ID'` after migration | All existing JSONB intact; new column null | Migration clobbered existing JSONB (the 8-day ES death was a similar auth-data loss) | 1 query |
| Cross-tenant isolation | User A registers a session; trigger system message for user B; capture server logs | No POST for user A's session; user B's session (null) → no-op | triggerAgent uses wrong userId → user A's agent gets user B's message (security + silent) | 1 turn |

**Regression tests**

- Full `npm test --workspaces` — all green.
- `npm run typecheck` — green.
- All 25+ schedulers still tick: `GET /admin/health` → `schedulers` array, every entry has `last_ok_at` within its interval × 2.
- Stuck-message-sweep pass B doesn't flip prematurely: insert a `pending` system row, wait 35min (one sweep past `stuckAfterMinutes`), confirm it's only flipped after `maxRenotifies` (3) attempts — pass B's `pending AND re_notify_count >= 3` guard.
- FCM still delivers: trigger an alert via `raiseAlert` in a test → `fcm_tokens` row + push receipt.
- Audit ledger still populates: run any MCP tool call → `ll5_audit_log` row with `trace_id`.

**Rollback verification**

| Step | Command | "Complete" | "Failed silently" |
|---|---|---|---|
| Revert gateway deploy | Re-deploy previous gateway image | `triggerAgent` code path gone; `OPENCODE_SERVER_URL` env ignored | New image still running — `docker inspect gateway-xkkcc0g4o48kkcows8488so4 \| jq '.[0].Config.Image'` shows new SHA |
| Env var cleared | `grep OPENCODE_SERVER_URL .env` on host | Empty or absent | Var still set from a prior deploy injection (the idempotent upsert leaves it) |
| Migration left in place | `SELECT column_name FROM information_schema.columns WHERE table_name='user_settings' AND column_name IN ('agent_session_id','agent_sessions')` | Both columns present, nullable | — (additive, safe to leave) |
| Claude Code unaffected | Send test chat message | Agent responds via NOTIFY→channel bridge flow | Agent silent — NOTIFY path broken by the partial revert |

---

### 1.4 Phase 2.5 — Thin vertical slice (FAIL FAST GATE)

See §2 for the per-assumption protocol. This section covers the phase-level
wrapper.

**Loud failure tests**

| What | How | Expected | Failure |
|---|---|---|---|
| opencode pinned version installs | `npm install -g opencode-ai@<PINNED>` (exact version from P2.5-T1) | Installs; `opencode --version` prints pinned version | Version not found, install fails |
| Minimal scaffold runs | `opencode serve --hostname 0.0.0.0 --port 4096` in scaffold dir | Server up; `curl http://localhost:4096/health` returns 200 | Crash, port conflict, missing config |
| Each plugin loads | Start opencode with one plugin at a time; check startup logs | `plugin loaded: <name>` for each | Plugin throws on import, event name wrong |
| Probe script runs | `npx tsx scripts/probe-events.ts` | Logs every event for one turn; output saved to `docs/implementation/phase-2.5-probe-output.log` | Script crashes, no events logged |

**Silent failure tests**

| What to monitor | Detection | Correct | Silently wrong | Window |
|---|---|---|---|---|
| Plugin fires on right event | Probe script logs the event name + plugin entry | Each plugin's handler appears under the documented event | Plugin loads but handler never fires — event name typo, wrong granularity | 1 turn |
| Deny actually blocks tool | Trigger a `write_*` tool call; check probe log for `denied` + agent receives deny message | Tool call blocked; agent gets deny text | Plugin intercepts but doesn't deny — tool runs anyway (security hole) | 1 tool call |
| Correlation-id lands in audit | After an MCP tool call in the slice, `curl http://gateway/sessions/audit/tool-calls?session_id=<slice-session>` | Row with `session_id` + `trace_id` matching the slice | Headers sent but MCP strips them; audit row has null correlation-ids | 1 tool call |
| `message.updated` is full turn | Probe log: one `message.updated` per turn with complete content | Single event, full payload | Multiple `message.updated` per turn (fragmented) — session-history double-writes or misses | 1 turn |
| `prompt_async` queues | Send a second prompt while first is mid-turn; check probe log | Second prompt runs after first completes | Second prompt rejected (409) or interleaved (corrupted turn) | 2 prompts |

**Regression tests**

- Phase 2.5 is a local scaffold — no production regression risk.
- Gateway tests still green from Phase 2.
- The capture server used for trigger validation returns 200 for every POST
  (no real agent delivery expected).

**Rollback verification**

- N/A — no production changes. If the gate fails, archive the scaffold; the
  `docs/implementation/phase-2.5-gate-result.md` decision document is the only
  artifact. Phases 0-2 retained.

---

### 1.5 Phase 3 — Create `ll5-run-opencode` repo

**Loud failure tests**

| What | How | Expected | Failure |
|---|---|---|---|
| TypeScript compiles | `npm run typecheck` in ll5-run-opencode | Zero errors | Plugin type errors, SDK type mismatch |
| Plugin unit tests | `npm test` in ll5-run-opencode (vitest) | All plugin tests green | Red — plugin logic wrong |
| Reconcile security tests | `npm test -- reconcile-security` (P3-T20) | All 28+ checks green | Any red = allowlist bypassable (security hole) |
| Local opencode starts with all plugins | `opencode serve` in repo root with full `opencode.json` | Server up, all 12 plugins load | Plugin load error, opencode.json invalid |
| Each skill executes locally | `opencode run /daily` etc. for each of 17 skills | Each produces coherent output | Skill fails, tool call errors |

**Silent failure tests** — *plugins appear to work but produce wrong behavior*.

| What to monitor | Detection | Correct | Silently wrong | Window |
|---|---|---|---|---|
| `stop-mirror` dedup | Send same agent reply twice (replay); check `chat_messages` for duplicates | One `outbound` row per reply | Two rows — posted-ledger dedup logic wrong | 1 turn |
| `session-history` turn-boundary dedup | Multi-turn session; check `ll5_session_history` doc count | One doc per turn (or one doc per session, depending on design — confirm in P2.5-T6) | Multiple docs per turn (used `message.part.updated` by mistake) or missing turns | 1 session |
| `external-authority-gate` allowlist completeness | Adversarial test: externally-triggered turn + every state-changing tool in the MCP set | All denied | One tool slips through (allowlist incomplete) — security hole, silent | Per-tool test |
| Reconcile worker allowlist not bypassable via subagent | Adversarial test: reconcile-worker agent calls a subagent that attempts a denied tool | Denied at subagent level too | Subagent bypasses — worker can do anything via subagent | 1 test cycle |
| Correlation-ids on all 6 MCPs | Trigger one tool call per MCP; query audit ledger per MCP | All 6 have `session_id`+`trace_id` | Some MCPs strip headers (e.g. ones without header passthrough) | 6 tool calls |
| `memory-intercept` fires on every write path | Trigger `write_*`, `edit_*`, `create_*` tool variants; check `ingest_memory` calls | Every write intercepted | Some write paths bypass the intercept (tool name pattern miss) | Per-tool test |
| `eval-recorder` uses `session.idle` not `message.part.updated` | Multi-turn session; count eval-moment POSTs | One per turn | Multiple per turn (wrong event) or zero (event name typo) | 1 session |
| Workers create own sessions | Start narrative-loop + reconcile-loop; check `/internal/agent-session` POSTs + `user_settings.agent_sessions` | `narrative_loop` + `reconcile_loop` keys populated | Workers share main session (routing collision) | 1 worker cycle |

**Regression tests**

- Phase 3 is local-build only — no prod regression risk until Phase 5.
- The 28+ reconcile security checks (`test_reconcile_security.py` ported to TS)
  must pass adversarial review by the security engineer.
- Cross-check: every hook in the §"Full hook inventory" of the master plan has
  a corresponding plugin or an explicit "Drop with justification" entry.

**Rollback verification**

- Git revert in ll5-run-opencode. No production impact. Tag the failed commit
  so the repo history shows where the rollback point was.

---

### 1.6 Phase 4 — Dockerfiles + CI

**Loud failure tests**

| What | How | Expected | Failure |
|---|---|---|---|
| Both images build | Trigger `build-and-push.yml` with `workflow_dispatch` packages=`run-claude,run-opencode` | Both build jobs green; images pushed to GHCR | Build fails, push denied |
| Variant repo checkout works | Check build log for `Checkout variant repo` step | `variant-content/` dir populated with repo files | PAT scope wrong, repo name wrong |
| Node skip conditions | Check build log for `run-claude` and `run-opencode` jobs | `Set up Node.js`, `npm ci`, `build shared`, `typecheck`, `build target` all skipped | Steps run and crash (no `package.json` at root) |
| Dockerfile selection | Check build log `Determine Dockerfile` step | `run-claude` → `docker/Dockerfile.ll5-run-claude`; `run-opencode` → `docker/Dockerfile.ll5-run-opencode` | Wrong Dockerfile used |
| Image pull | `docker pull ghcr.io/arnonzamir/ll5-run-claude:latest && docker pull ghcr.io/arnonzamir/ll5-run-opencode:latest` | Both succeed | 404 — push didn't land |
| `repository_dispatch` handler | Push a commit to ll5-run-opencode; watch ll5 `build-and-push.yml` | Dispatch received; `run-opencode` rebuilds | Dispatch not registered, PAT lacks scope |
| Weekly fallback | Manually trigger the weekly `workflow_dispatch` | Both variants rebuild | Cron misconfigured |

**Silent failure tests** — *image builds but contains stale content*.

| What to monitor | Detection | Correct | Silently wrong | Window |
|---|---|---|---|---|
| Image content freshness | After build, `docker run --rm ghcr.io/arnonzamir/ll5-run-claude:latest sh -c 'cat /workspace/CLAUDE.md \| sha256sum'` vs `sha256sum packages/ll5-run-shared/CLAUDE.md` | Hashes match | Hashes differ — Docker layer cache returned old shared content; image tagged `latest` but content is stale | 1 build |
| Variant content freshness | Same for variant content: `docker run --rm ghcr.io/arnonzamir/ll5-run-opencode:latest sh -c 'ls /workspace/.opencode/plugins/'` | All 12 plugins listed | Missing plugins — variant repo checkout pulled stale/empty | 1 build |
| `--no-cache` bust when stale suspected | Rebuild with `--no-cache` flag in a manual dispatch; compare hashes again | Hashes now match | Still differ — COPY source path wrong | 1 rebuild |
| GHCR credential not clobbered | After deploy, `docker pull alpine` (or any non-ll5 image) on host | Pull succeeds | Pull fails with `denied` — `GITHUB_TOKEN` clobbered `/root/.docker/config.json` again (the recurring outage). Check deploy script uses `GHCR_READ_PAT`, not `secrets.GITHUB_TOKEN` | 1 deploy |
| MCP config rendered in image | `docker run --rm ghcr.io/arnonzamir/ll5-run-opencode:latest cat /workspace/opencode.json \| jq '.mcpServers \| keys'` | 6 MCP names | Render step skipped in Dockerfile, config missing | 1 build |
| `$HOME` persistence layer | `docker run --rm ghcr.io/arnonzamir/ll5-run-opencode:latest sh -c 'echo $HOME && ls -la /data/home'` | `/data/home` exists, env `HOME=/data/home` | HOME defaults to `/` — onboarding bypass breaks | 1 exec |

**Regression tests**

- `compose-drift-check.yml` — still passes (compose unchanged this phase).
- Existing 9 infra packages still build: trigger `build-and-push.yml` with no
  package filter → all 9 build green.
- `npm test --workspaces` — green.
- `npm run typecheck` — green.

**Rollback verification**

| Step | Command | "Complete" | "Failed silently" |
|---|---|---|---|
| Revert CI changes | `git revert` the Phase 4 commits in ll5; push | CI matrix back to 9 packages; variant packages not built | Matrix still includes `run-*` — revert incomplete |
| Rebuild old images | Trigger `build-and-push.yml` (no filter) | 9 infra images rebuild; no `run-*` images | `run-*` images still built — matrix revert missed |
| Force cache bust | `docker buildx prune --force` if stale content suspected | Next build fresh | Cache still serving stale layers |

---

### 1.7 Phase 4.5 — Standalone → compose transition

**This is the highest-risk operational step.** The dominant silent failure is
**two agent containers running simultaneously** — both respond to PG NOTIFY,
duplicate messages, corrupt conversation state.

**Loud failure tests**

| What | How | Expected | Failure |
|---|---|---|---|
| Old container stopped | `docker ps -a \| grep js8owk0g0cgog800ckc8ww0s` (or the old container name) | No agent container under old UUID | Container still listed |
| Old container removed | `docker ps -a \| grep ll5-agent` (old image name) | No row | Row still present |
| Coolify app deleted | Coolify UI: app `js8owk0g0cgog800ckc8ww0s` shows deleted/disabled | App gone or status "disabled" | App still active — will auto-restart the container |
| Volume copy succeeds | `docker run --rm -v <old-vol>:/from -v xkkcc0g4o48kkcows8488so4_agent-workspace-claude:/to alpine sh -c 'cp -a /from/. /to/ && find /to -type f \| wc -l'` | File count matches source | Copy partial — file count mismatch |
| Compose agent starts | `AGENT_VARIANT=claude docker compose up -d agent` | `docker compose ps agent` shows `Up` | Container exit, healthcheck fail |

**Silent failure tests** — *the critical 30-minute Coolify-restart watch*.

| What to monitor | Detection | Correct | Silently wrong | Window |
|---|---|---|---|---|
| **Only one agent container** | `docker ps \| grep -c agent` | Exactly 1 | 2 — Coolify restarted the old one; both respond to NOTIFY → duplicate messages | **30 min continuous watch** (per build-order P4.5 critical check) |
| Duplicate agent responses | Send one test system message; count agent replies in `chat_messages` (`direction='outbound'`) within 60s | Exactly 1 reply | 2 replies — two agents both processed the NOTIFY | 1 turn |
| Workspace data intact | `docker exec agent-xkkcc0g4o48kkcows8488so4 ls /workspace/.claude/skills \| wc -l` | 17 | 0 or fewer — volume copy missed `.claude/` | 1 exec |
| `$HOME` token present | `docker exec agent-xkkcc0g4o48kkcows8488so4 sh -c 'test -f /data/home/.ll5/token && echo ok'` | `ok` | Empty — token lost, MCP auth breaks silently (every tool call 401s but agent may not surface) | 1 exec |
| PG NOTIFY reaches new container | Send system message; tail new agent logs for `channel` / `new_message` | NOTIFY received | New container not on the same Docker network — NOTIFY lost; agent silent | 1 turn |
| Coolify doesn't recreate old | After 30min, `docker ps -a \| grep js8owk0g0cgog800ckc8ww0s` | Still empty | Old container reappeared — Coolify app not disabled | **30 min** |
| Healthcheck passes | `docker inspect agent-xkkcc0g4o48kkcows8488so4 \| jq '.[0].State.Health.Status'` | `healthy` | `unhealthy` but container "Up" — process-based check passes but agent not processing | 1 inspect |

**Regression tests**

- All 25+ schedulers tick: `GET /admin/health` → `schedulers` array, every
  `last_ok_at` within `interval × 2`.
- All 6 MCPs respond to a tool call.
- Audit ledger populates with correlation-ids.
- Stuck-message-sweep: insert a pending system row, watch it re-notify then flip
  after 3 attempts (the post-2026-07-03 behavior).
- FCM delivers a test push.
- Dashboard loads recent messages (SSE working).
- Agent responds to a `[ALERT]` system message (alert spine end-to-end).

**Rollback verification**

| Step | Command | "Complete" | "Failed silently" |
|---|---|---|---|
| Stop compose agent | `docker compose stop agent` | `docker ps \| grep agent` empty | Container still "Up" — stop didn't propagate |
| Re-enable old Coolify app | Coolify UI: re-enable `js8owk0g0cgog800ckc8ww0s` | Old container starts; `docker ps \| grep ll5-agent` shows 1 | Coolify app couldn't restart — manual `docker run` needed |
| Verify single container | `docker ps \| grep -c agent` | 1 | 0 (agent down) or 2 (both running) |
| End-to-end | Send test chat | Agent responds | Silent — old container's NOTIFY listener died on restart |

---

### 1.8 Phase 5 — Compose + deploy opencode variant

**Loud failure tests**

| What | How | Expected | Failure |
|---|---|---|---|
| Compose `agent` service valid | `docker compose -f docker/docker-compose.prod.yml config` (with `AGENT_VARIANT=opencode`) | Valid; `agent` service present; no ports published; `traefik.enable=false` | YAML error, missing service |
| Deploy job injects env | Check deploy script log for `Injected AGENT_VARIANT + OPENCODE_SERVER_URL` | Both lines present | Injection skipped — guard on empty secret failed |
| Agent healthcheck | `docker exec agent-xkkcc0g4o48kkcows8488so4 wget -qO- http://localhost:4096/health` | 200 OK | Exit non-zero — opencode server down |
| Deploy health check | CI `Health check` step | `Agent container running` (the new `docker compose ps agent \| grep -q "Up"` check) | `::error::Agent container not running` |
| Session registration | `psql -c "SELECT agent_sessions->'main' FROM user_settings WHERE user_id='$USER_ID'"` | Non-null UUID | Null — `/internal/agent-session` POST failed |
| Gateway triggers reach agent | Send test system message; tail agent logs for `prompt_async` | Agent receives prompt | 404/500 on POST — `OPENCODE_SERVER_URL` wrong or session not registered |

**Silent failure tests** — *agent up (healthcheck passes) but not processing*.

| What to monitor | Detection | Correct | Silently wrong | Window |
|---|---|---|---|---|
| Agent actually processes | Send test system message; wait for agent reply in `chat_messages` (`direction='outbound'`) within 90s | 1 reply | Healthcheck green but agent never processes prompts — `triggerAgent` POST succeeds (200) but opencode queue stuck | 1 turn (90s) |
| All 6 MCPs work from opencode | Trigger one tool per MCP from the agent; check audit ledger | 6 `tool_call` rows with `success:true` | Some MCPs 401 — opencode header injection differs from Claude Code's `get-mcp-auth.sh` | 6 tool calls |
| Correlation-ids land | `curl http://gateway.noninoni.click/audit/tool-calls?session_id=<opencode-session>` | Rows have `session_id`+`trace_id` | Null correlation-ids — `correlation-id-injector.ts` plugin not firing | 1 query |
| Full metadata reaches agent | Send a message with `sourceRouting` (e.g. simulate a WhatsApp inbound); check agent's context for `[meta] {...}` | Agent sees platform/remote_jid/sender_name | Metadata dropped — agent can't reason about source | 1 turn |
| `push_to_user` reaches gateway | Agent calls `push_to_user` tool; check `chat_messages` for new outbound row | Row appears | Tool call 200s but no PG row — gateway REST path wrong | 1 tool call |
| `external-authority-gate` blocks | Send externally-triggered turn + state-changing tool call; check agent log for `denied` | Tool denied | Tool runs — allowlist incomplete (security hole) | 1 turn |
| Background workers cycle | `docker exec agent-xkkcc0g4o48kkcows8488so4 sh -c 'pgrep -f narrative-loop && pgrep -f reconcile-loop'` + check `user_settings.agent_sessions` for `narrative_loop`+`reconcile_loop` keys | Both processes up; both session keys populated | Processes up but sessions not registered — workers run but gateway can't route to them | 1 cycle (≤15min for reconcile) |
| `session-history` writes to ES | After a turn, `curl http://gateway.noninoni.click/sessions/<opencode-session-id>` | 200 with doc | 404 — `session-history.ts` plugin not firing, or POST to `/sessions` failing silently | 1 turn |
| `recall_everything` finds new sessions | From agent, call `recall_everything` with `sources:["session"]`; check results include the opencode session | Included | Not included — `transcript_text` not indexed, or `workspace` field wrong | 1 query |
| Stuck-message-sweep pass B flips loudly | Stop the agent (simulate dead); insert a pending system row; wait 30+min | Pass B flips row, logs `[StuckMessageSweep][lost]` at ERROR | Row silently flipped to `delivered` (the pre-2026-07-03 silent-mask) | 1 sweep past `stuckAfterMinutes` (≤45min) |

**Regression tests**

- All 25+ schedulers tick (`/admin/health.schedulers`).
- All MCP `health` endpoints return 200.
- Compose drift check passes.
- Dashboard loads messages (SSE).
- FCM delivers.
- Reconcile governor writes `ll5_reconcile_metrics` doc with
  `missed_close_count` + `wrong_close_count` populated.
- Anomaly monitor doesn't false-alert on the new variant (no
  `agent_output_stale` alert for the first 30min while the agent warms up).

**Rollback verification** — *the single-var rollback*.

| Step | Command | "Complete" | "Failed silently" |
|---|---|---|---|
| Flip env | On host: `sed -i 's/^AGENT_VARIANT=.*/AGENT_VARIANT=claude/' .env` (or the deploy-script upsert does it) | `.env` shows `AGENT_VARIANT=claude`; `OPENCODE_SERVER_URL` derived to empty | Var unchanged — upsert guard failed |
| Redeploy | Trigger `build-and-push.yml` deploy job | Claude Code agent container running; opencode container stopped | Both running — compose didn't recreate, or `agent-workspace-opencode` volume held a stale container |
| Verify single container | `docker ps \| grep -c agent` | 1 | 2 (silent duplicate) |
| Verify variant | `docker inspect agent-xkkcc0g4o48kkcows8488so4 \| jq '.[0].Config.Image'` | `ghcr.io/arnonzamir/ll5-run-claude:latest` | Still opencode image — pull/recreate failed |
| Verify trigger no-op | Send system message; gateway logs | Zero `[agent-trigger]` lines (env empty) | `OPENCODE_SERVER_URL` still set — failed HTTP calls every message |
| End-to-end | Send test chat | Claude Code agent responds | Silent — NOTIFY path broken during the flip |
| Time-to-rollback | Measure wall-clock from "flip env" to "agent responds" | < 10 min | > 10 min — investigate deploy bottleneck |

---

### 1.9 Phase 6 — Behavioral parity + persona tuning

See §3 for the parity framework. Phase-level wrapper:

**Loud failure tests**

| What | How | Expected | Failure |
|---|---|---|---|
| Alternating-day deploy succeeds | Daily: flip `AGENT_VARIANT`, deploy | Each day's variant starts, healthcheck green | Deploy fails, container down |
| Persona tuning commits typecheck | After each P6.5-T2/T3 commit: `npm run typecheck` | Green | Red — CLAUDE.md syntax, skill path ref broken |

**Silent failure tests** — *behavioral degradation is inherently silent*.

| What to monitor | Detection | Correct | Silently wrong | Window |
|---|---|---|---|---|
| Persona drift | Daily 14-Hard-Rules score (see §3) | opencode within 10% of Claude Code baseline | opencode compliance drops >10% — agent produces plausible-but-noncompliant output | 1 day per variant |
| Memory intercept firing | After any `write_*` tool call, check `ll5_app_log` for `ingest_memory` action | Row present | No row — `memory-intercept.ts` not firing on opencode | 1 tool call |
| Memory recall injection | Send a prompt that should trigger recall; check agent's context for `recall_lessons` output | Present | Absent — `memory-recall` path broken; agent reasons without past context | 1 turn |
| Scheduler latency | Compare scheduler fire → agent response time across variants | opencode within 2× Claude Code | opencode 5× slower — `prompt_async` queueing adds latency | Per scheduler |
| Worker output quality | Compare narrative-loop + reconcile-loop output across variants (see §3) | Equivalent quality (subjective score) | opencode workers produce lower-quality narratives/reconciles | 1 worker cycle |
| Alert spine | Trigger a test alert; check agent responds to `[ALERT]` message | Agent acknowledges within 60s | Agent ignores alert — `[ALERT]` prefix not recognized in opencode persona | 1 alert |
| Reconcile governor | Check `ll5_reconcile_metrics.wrong_close_count` over a cycle | Non-zero when expected (zero-grounding closes detected) | Always 0 — governor can't see opencode's close events (correlation-id break) | 1 cycle (15min) |

**Regression tests**

- `npm test --workspaces` green after every persona-tuning commit.
- `npm run typecheck` green.
- The 14 Hard Rules baseline (Claude Code day) doesn't regress across tuning
  iterations — re-score Claude Code on day 4 and day 6, confirm baseline stable.

**Rollback verification**

| Step | Command | "Complete" | "Failed silently" |
|---|---|---|---|
| Revert persona tuning | `git revert` the P6.5 commits in ll5 shared content; redeploy | Persona back to pre-tuning state | CLAUDE.md still shows tuned content — image cache hit |
| Flip variant | `AGENT_VARIANT=claude`, deploy | Claude Code running | Both running |
| Re-score | Run 14-Hard-Rules probe | Back to baseline | Score still degraded — revert incomplete |

---

### 1.10 Phase 7 — Cutover

See §4 for the 24-hour monitoring plan. Phase-level wrapper:

**Loud failure tests**

| What | How | Expected | Failure |
|---|---|---|---|
| Env flip | `grep AGENT_VARIANT .env` on host | `AGENT_VARIANT=opencode` | Var unchanged |
| Deploy | Trigger deploy job | Green; agent container running opencode | Deploy fails |
| Healthcheck | `docker exec agent-xkkcc0g4o48kkcows8488so4 wget -qO- http://localhost:4096/health` | 200 | Non-200 |

**Silent failure tests** — *the system's two most expensive historical failures
were silent (37h scheduler, 8d ES). Monitoring must check actual behavior, not
container health.*

| What to monitor | Detection | Correct | Silently wrong | Window |
|---|---|---|---|---|
| Schedulers tick | `GET /admin/health` → `schedulers` array; every `last_ok_at` within `interval × 2` | All green | A scheduler's `last_ok_at` stale — silent tick death (the 37h pattern) | Hourly × 24h |
| ES writes land | `curl http://gateway.noninoni.click/sessions?limit=1` + ES query for recent `ll5_app_log` + `ll5_audit_log` docs | New docs within last 15min | No new docs — silent ES write death (the 8d pattern). Check `warnEsWriteFailure` in gateway logs | Hourly × 24h |
| Agent actually processes | Send a test chat message hourly; verify reply within 90s | Reply each time | Healthcheck green but no reply — `triggerAgent` path dead | Hourly × 24h |
| Correlation-ids present | `curl /audit/tool-calls?from=<1h ago>` | Rows with `session_id`+`trace_id` | Null correlation-ids — `correlation-id-injector.ts` plugin died | Hourly × 24h |
| Workers cycle | `ll5_reconcile_metrics` doc within last 30min; narrative-loop log activity | Both alive | Processes up but not cycling — silent worker death | Hourly × 24h |
| No duplicate agent | `docker ps \| grep -c agent` | 1 | 2 (the Phase 4.5 silent duplicate recurring) | Hourly × 24h |

**Regression tests**

- The full §5 silent-failure checklist every hour for 24h.
- Dashboard, Android app, chat SSE all functional end-to-end.

**Rollback verification** — practiced in §4.3 before cutover.

---

## 2. Phase 2.5 Specific Testing — Fail-Fast Gate

For each of the 8 assumptions (a-h from the master plan), the protocol below
specifies the exact procedure, pass/fail criteria, and evidence to collect.
**Validations (a), (c), (d) are non-negotiable — fail = STOP.** (b), (e), (f),
(g), (h) fail → assess individually.

The probe script (`scripts/probe-events.ts`, P2.5-T7) logs every event for one
turn: event name, timestamp, payload shape, granularity. Save its output to
`docs/implementation/phase-2.5-probe-output.log` — this is the primary evidence.

### 2.1 Validation (a) — `tool.execute.before` deny semantics

**Assumption**: opencode's `tool.execute.before` deny matches bash PreToolUse
deny — the tool call is actually blocked, not just intercepted.

**Procedure**:
1. Scaffold has `memory-intercept.ts` registered on `tool.execute.before` for
   `write_*`/`edit_*` tools.
2. From the opencode TUI, send a prompt that triggers a `write_*` tool call
   (e.g. "write a file to /tmp/test").
3. Run the probe script concurrently.
4. Check: (i) the tool call is blocked (no file created), (ii) the agent
   receives a deny message, (iii) the probe log shows the
   `tool.execute.before` event with a `deny` outcome.

**Pass criteria**:
- File `/tmp/test` does NOT exist after the turn.
- Agent's next message acknowledges the deny (e.g. "I can't write files" or
  similar).
- Probe log entry: `tool.execute.before` → `deny` for the `write_*` tool.

**Fail criteria**:
- File created — deny didn't block.
- Agent proceeds as if the tool succeeded.
- Probe log shows `tool.execute.before` but no `deny` outcome (intercepted but
  not blocked).

**If fails**: **STOP.** Security boundary depends on it. `memory-intercept`
and `external-authority-gate` are both useless if deny doesn't block.

**Evidence**: probe log excerpt + `ls /tmp/test` output + agent's reply text.

### 2.2 Validation (b) — `message.updated` gives complete turns

**Assumption**: `message.updated` fires at turn boundary with complete turn
content, not partial fragments.

**Procedure**:
1. `session-history.ts` plugin registered on `message.updated`.
2. Send a multi-step prompt (e.g. "list 3 things, then summarize") that
   involves multiple tool calls.
3. Probe script logs every `message.updated` event with payload size + content
   hash.
4. Count events per turn; compare payload completeness vs the final agent
   reply.

**Pass criteria**:
- One `message.updated` event per turn (or a documented, consistent cadence).
- Payload contains the complete turn (matches the agent's final reply).
- `session-history.ts` writes one `ll5_session_history` doc per turn (or per
  the design from P2.5-T6).

**Fail criteria**:
- Multiple `message.updated` per turn with partial payloads.
- Payload is a fragment (e.g. one tool call, not the full turn).
- `session-history.ts` writes multiple docs per turn or misses turns.

**If fails**: Assess. Workaround: use a different event (e.g. `session.idle`)
with turn-boundary dedup, OR accept multiple docs and dedup in ES. Document
the chosen workaround in `phase-2.5-gate-result.md`.

**Evidence**: probe log event count + payload hashes + `ll5_session_history`
doc count.

### 2.3 Validation (c) — Correlation-id header injection

**Assumption**: `X-LL5-Session-Id` + `X-LL5-Trace-Id` headers can be injected
into MCP tool calls. **Critical for DECISION-012 audit ledger + reconcile
governor.**

**Procedure**:
1. `correlation-id-injector.ts` plugin registered (mechanism TBD — plugin shim
   or opencode header config).
2. Trigger one MCP tool call from the opencode scaffold (e.g. messaging MCP
   `check_messages`).
3. On the gateway side, query `ll5_audit_log` for the recent `tool_call` row.
4. Check `session_id` + `trace_id` fields are populated with the opencode
   session's values.

**Pass criteria**:
- `ll5_audit_log` row has `session_id` = opencode session UUID.
- `trace_id` is a non-null UUID/string.
- Both fields propagate to the MCP server's audit row (cross-check with the
  MCP's own log if it emits one).

**Fail criteria**:
- `session_id` and/or `trace_id` null in the audit row.
- Headers sent by the plugin but stripped by opencode's MCP transport.
- Plugin shim doesn't fire (load succeeds but handler never called).

**If fails**: **STOP.** Audit ledger + reconcile governor go blind without
correlation-ids. No workaround acceptable — the entire observability +
security model depends on it.

**Evidence**: `curl /audit/tool-calls?session_id=<opencode-session>` JSON +
plugin log showing header injection + MCP server log showing received headers.

### 2.4 Validation (d) — `prompt_async` queueing on mid-turn session

**Assumption**: opencode queues a second prompt arriving mid-turn (doesn't
reject, doesn't interleave). **Gateway can't trigger the agent without it.**

**Procedure**:
1. Send a long prompt to the opencode session (one that takes 30+ seconds to
   process).
2. While the first is mid-turn, send a second prompt via
   `POST /session/:id/prompt_async`.
3. Probe script logs both prompts' lifecycle.
4. Check: (i) second prompt is queued (not 409'd), (ii) second prompt runs
   AFTER the first completes (not interleaved), (iii) both produce replies.

**Pass criteria**:
- Second POST returns 202 (or 200) — queued, not rejected.
- Second prompt's reply appears AFTER the first's reply completes.
- No interleaving — first turn's output is coherent, second turn's output is
  coherent.

**Fail criteria**:
- 409 Conflict — opencode rejects mid-turn prompts.
- Interleaved output — second prompt's content mixed into the first turn.
- Second prompt silently dropped (no reply, no error).

**If fails**: **STOP.** Gateway can't trigger the agent reliably. The
stuck-message-sweep retry path would also fail (it re-triggers mid-turn).

**Evidence**: probe log with both prompts' timestamps + HTTP status codes +
both replies' text.

### 2.5 Validation (e) — opencode MCP retry behavior

**Assumption**: Document whether opencode retries failed HTTP MCPs natively. If
not, `autoheal.ts` is needed.

**Procedure**:
1. Point one MCP at a deliberately broken URL (e.g. `http://localhost:9999`
   that returns 503).
2. Trigger a tool call to that MCP.
3. Observe: (i) does opencode retry? (ii) how many times? (iii) what's the
   backoff? (iv) does it surface the failure to the agent?
4. Restore the MCP URL; observe if opencode reconnects automatically.

**Pass criteria** (either path is acceptable):
- **Path A**: opencode retries natively with documented backoff (e.g. 3
  retries, exponential). `autoheal.ts` not needed.
- **Path B**: opencode does NOT retry. Document this; `autoheal.ts` is built
  in Phase 3 (P3-T21).

**Fail criteria**:
- opencode hangs indefinitely on a failed MCP (no timeout, no retry, no
  surfacing) — agent stuck.
- opencode crashes the session on MCP failure.

**If fails**: Assess. Workaround: build `autoheal.ts` with a hard timeout +
session restart. Document the failure mode in `phase-2.5-gate-result.md`.

**Evidence**: probe log with MCP failure timestamps + agent behavior + opencode
logs.

### 2.6 Validation (f) — `experimental.session.compacting` event

**Assumption**: The compaction event fires and is usable for pre-compact
backup + re-grounding injection.

**Procedure**:
1. Fill a session with enough content to trigger compaction (or manually
   trigger compaction if opencode supports it).
2. Probe script logs the `experimental.session.compacting` event.
3. Check: (i) event fires, (ii) payload includes session state, (iii) a
   `precompact-backup.ts` handler can read the payload and POST to `/sessions`
   before compaction completes.

**Pass criteria**:
- `experimental.session.compacting` event fires before compaction.
- Payload includes session ID + message count (enough for backup).
- `precompact-backup.ts` handler runs to completion before compaction
  finishes (opencode waits for async handlers, or the handler is sync).

**Fail criteria**:
- Event doesn't fire (opencode compacts silently).
- Event fires AFTER compaction (too late for backup).
- Handler can't complete in time (compaction proceeds, backup lost).

**If fails**: Assess. Workaround: schedule periodic `session-backup.ts` runs
instead of event-driven backup. Document.

**Evidence**: probe log + `ll5_session_history` doc from the backup + opencode
compaction log.

### 2.7 Validation (g) — `session.created` event

**Assumption**: Fires on new session, usable for re-grounding logic.

**Procedure**:
1. Start a new opencode session.
2. Probe script logs `session.created`.
3. Check: (i) event fires, (ii) payload includes session ID.

**Pass criteria**:
- `session.created` fires once per new session.
- Payload includes session ID.
- `session-start.ts` handler can read the payload and perform re-grounding
  (narratives + sessions + knowledge + lessons + journal).

**Fail criteria**:
- Event doesn't fire.
- Payload missing session ID.

**If fails**: Assess. Workaround: trigger re-grounding on first prompt instead
 of session creation. Document.

**Evidence**: probe log + `session-start.ts` handler log.

### 2.8 Validation (h) — `/daily` skill behavioral quality

**Assumption**: One skill executes with acceptable quality on opencode (not
perfect, but not broken).

**Procedure**:
1. Send `/daily` to the opencode scaffold.
2. Capture the full output.
3. Subjective score (1-5) on: (i) skill ran to completion, (ii) output is
   coherent, (iii) persona present (14 Hard Rules adherence sampled), (iv)
   tool calls succeeded.
4. Compare to a Claude Code `/daily` baseline from the same day.

**Pass criteria**:
- Score ≥ 3/5 on all four dimensions.
- Output not broken (no garbage, no refusal, no infinite loop).

**Fail criteria**:
- Score < 3/5 on any dimension.
- Skill fails to run, crashes, or produces incoherent output.

**If fails**: Assess. Persona tuning (Phase 6.5) may fix it. Document the
specific quality issues. Continue only if the issues are tuning-related, not
architectural.

**Evidence**: full `/daily` output from opencode + Claude Code baseline +
scored rubric.

### 2.9 Gate Decision

After all 8 validations, write `docs/implementation/phase-2.5-gate-result.md`:

| Validation | Pass/Fail | Evidence | Action |
|---|---|---|---|
| (a) deny semantics | | | |
| (b) message.updated granularity | | | |
| (c) correlation-ids | | | |
| (d) prompt_async queueing | | | |
| (e) MCP retry | | | |
| (f) session.compacting | | | |
| (g) session.created | | | |
| (h) /daily quality | | | |

**Decision**: If (a), (c), or (d) fail → STOP. Phases 0-2 retained. If all
non-negotiable pass → proceed to Phase 3.

---

## 3. Phase 6 Specific Testing — Behavioral Parity Framework

### 3.1 Daily Comparison Protocol

**Method**: Run opencode as sole agent (not parallel — both responding to the
same trigger risks duplicates + conversation corruption). Alternate days:

| Day | Variant | Deploy at |
|---|---|---|
| Mon | opencode | 06:00 |
| Tue | Claude Code | 06:00 |
| Wed | opencode | 06:00 |
| Thu | Claude Code | 06:00 |
| Fri | opencode | 06:00 |
| Sat | Claude Code | 06:00 |
| Sun | opencode | 06:00 |

Total: 4 opencode days, 3 Claude Code days.

**Each day collect**:
- All agent replies in `chat_messages` (`direction='outbound'`) timestamped
  that day.
- All `ll5_audit_log` `tool_call` rows that day.
- All `ll5_eval_moments` docs that day.
- All `ll5_reconcile_metrics` docs that day.
- `ll5_session_history` docs indexed that day.
- `/admin/health` snapshots every 2h.
- Manual observation log: persona adherence notes, skill quality notes, any
  weird behavior.

**Scoring**: For each parity check (§3.2), compute a daily score. Compare
opencode days' scores to Claude Code days' scores. **Parity threshold:
opencode within 10% of Claude Code's baseline score.** If outside 10%, flag
for Phase 6.5 tuning.

### 3.2 Specific Parity Checks

#### 3.2.1 Persona adherence — 14 Hard Rules

**Method**: 14-Hard-Rules checklist. For each rule, sample 5 agent replies
from the day and score compliance (pass/fail per reply).

| Hard Rule | How to check | Claude-Code-specific? |
|---|---|---|
| 1. Single source of truth | Reply references correct source path | No |
| 2. No state change on external triggers | Audit ledger: externally-triggered turns have no state-changing tool calls (or they were denied) | No (enforced by `external-authority-gate`) |
| 3. ... | ... | ... |
| 12. Durable forward-facing work verified | `grounding-reviewer` subagent invoked on durable work | No |
| 13. External authority gate | Audit ledger: externally-triggered turns' state-changing tools denied | No (enforced) |
| 14. CronCreate retired | No `CronCreate` tool calls in audit ledger | **Yes — Claude-Code-specific tool name** |

*(Fill the full 14 from `CLAUDE.md` before starting Phase 6.)*

**Score**: per-rule pass rate (e.g. Rule 2: 5/5 on Claude Code, 4/5 on opencode
= 80% parity). Overall: average across 14 rules.

**Claude-Code-specific rules** (CronCreate retirement, transcript-mirror,
governed-memory-deny): identify in P6.5-T1, rewrite as agent-agnostic intents
in P6.5-T2.

#### 3.2.2 Skill execution quality

**Skills to test** (all 17, but prioritize):
- `/daily` — daily review (highest-use)
- `/review` — weekly review
- `/evening-close` — evening close
- `/gtd-scan` — GTD inbox scan
- `/narrative` — narrative consolidation

**Per skill**:
1. Run on opencode day, capture output.
2. Run on Claude Code day, capture output.
3. Score (1-5): (i) ran to completion, (ii) correct output shape, (iii) tool
   calls succeeded, (iv) persona present, (v) useful content.

**"Equivalent"**: score within 1 point on all 5 dimensions, AND no dimension
< 3.

#### 3.2.3 Memory intercept

**Verify `ingest_memory` fires on writes**:
1. Trigger a `write_*` or `edit_*` tool call on each variant.
2. Check `ll5_app_log` for `action:'ingest_memory'` rows within the turn.
3. Check the deny path: original write denied after intercept.

**Parity**: both variants fire `ingest_memory` on the same tool-call patterns.
If opencode misses a pattern Claude Code catches, `memory-intercept.ts`'s tool
name regex is incomplete.

#### 3.2.4 Memory recall

**Verify context injection works before prompts**:
1. Send a prompt that should trigger recall (e.g. "what did we discuss about
   X?").
2. Check the agent's context (probe or log) for `recall_lessons` /
   `recall_everything` output BEFORE the model sees the prompt.
3. Compare: does the agent reference past context in its reply?

**Parity**: both variants inject recall output. If opencode doesn't inject,
the `memory-recall` plugin (or SDK injection path) is broken — agent reasons
without memory (silent).

#### 3.2.5 Proactive triggers (schedulers)

**Verify schedulers reach the agent**:
1. For each scheduler that fires during the test day (check `/admin/health.schedulers`), verify:
   - `chat_messages` row with `metadata.scheduler` appears (system message inserted).
   - Agent responds within 90s (outbound reply).
2. Compare latency: scheduler fire time → agent reply time.

**Parity**: all schedulers reach the agent on both variants. Latency within
2× (opencode may be slower due to `prompt_async` queueing). If a scheduler
fires but no agent reply, the trigger path is broken (silent).

#### 3.2.6 Background workers

**Compare narrative-loop + reconcile-loop output quality**:

For **narrative-loop**:
1. Check `ll5_agent_journal` for new narrative docs each day.
2. Score (1-5): coherence, grounding (references real observations),
   forward-facing action items.

For **reconcile-loop**:
1. Check `ll5_reconcile_metrics` for `missed_close_count` + `wrong_close_count`
   each cycle.
2. Check `reconcile` tool calls in audit ledger.
3. Score: did it correctly identify missed closes? Did it close the right
   loops?

**Parity**: both workers run on cycle, produce equivalent-quality output. If
opencode's worker produces garbage narratives or misses closes, the SDK worker
script has a bug.

#### 3.2.7 Alert spine

**Verify `[ALERT]` response**:
1. Manually trigger a test alert via `raiseAlert` (or wait for a real one).
2. Check `chat_messages` for the `[ALERT] ...` system message.
3. Check the agent responds within 60s (acknowledges the alert).
4. Check `system_alerts.last_agent_notified_at` updates.

**Parity**: both variants respond to `[ALERT]` messages. If opencode ignores
the prefix, the persona doesn't recognize the alert convention (tuning needed).

#### 3.2.8 Reconcile governor

**Verify `wrong_close_count` detection**:
1. Check `ll5_reconcile_metrics` docs over the test day.
2. `wrong_close_count` should be non-zero when the agent closed loops without
   grounding (query_im_messages evidence).
3. `missed_close_count` should reflect the deterministic selector's candidate
   count.

**Parity**: both variants' governors write metrics with the same fields
populated. If opencode's `wrong_close_count` is always 0, the governor can't
see opencode's close events — **correlation-id break** (ties back to
Validation (c)).

### 3.3 Silent Failure Detection During Parity Testing

**Daily monitoring checklist** (run at end of each test day):

| Check | How | Silent-failure signal |
|---|---|---|
| Agent processed every system message | `SELECT count(*) FROM chat_messages WHERE channel='system' AND direction='inbound' AND created_at::date = '<test-day>'` vs agent reply count | Inbound > 0 but outbound = 0 → agent silent |
| Every scheduler ticked | `GET /admin/health` → `schedulers` → every `last_ok_at` within `interval × 2` | Any `last_ok_at` stale → scheduler died |
| ES writes landed | ES query: `ll5_app_log` + `ll5_audit_log` + `ll5_session_history` doc count for the day | Zero docs → silent ES death |
| Correlation-ids present | `curl /audit/tool-calls?from=<test-day>` → check `session_id`+`trace_id` non-null | Null → correlation-id plugin died |
| Workers cycled | `ll5_reconcile_metrics` doc within last 30min; narrative-loop log activity | No docs/processes → workers dead |
| No duplicate agent | `docker ps \| grep -c agent` | 2 → duplicate container |
| No stale alerts | `SELECT count(*) FROM system_alerts WHERE status='firing'` | Unexpected firing alerts → anomaly monitor false-positive or real issue |
| Memory intercept firing | `ll5_app_log` `action:'ingest_memory'` rows for the day | Zero → memory intercept dead |
| Recall injecting | Agent replies reference past context (subjective) | Agent reasons without memory → recall dead |
| FCM delivering | `/admin/health.fcm.total_failures` not climbing | Climbing → FCM broke (the recurring class) |

**If any check fails**: do NOT proceed to the next test day. Investigate the
silent failure first. The system's history shows silent failures compound.

---

## 4. Phase 7 Specific Testing — Production Cutover

### 4.1 24-Hour Monitoring Plan

**Cadence**: hourly checks for the first 6h, then every 2h for the next 18h.
Set `AGENT_VARIANT=opencode` at T+0. Rollback window opens immediately.

#### 4.1.1 Hourly checks (first 6h, then every 2h)

| Check | Command / query | Healthy | Rollback trigger |
|---|---|---|---|
| Agent container up | `docker compose ps agent \| grep -q "Up"` | "Up" | "Exit" or absent |
| Agent healthcheck | `docker inspect agent-xkkcc0g4o48kkcows8488so4 \| jq '.[0].State.Health.Status'` | `healthy` | `unhealthy` for 3+ checks |
| Agent processes a test message | `curl -X POST https://gateway.noninoni.click/chat/messages -H "Authorization: Bearer $TOKEN" -d '{"content":"health probe","conversation_id":"<test-conv>"}'`; wait 90s for reply | Reply within 90s | No reply for 2 consecutive probes |
| Schedulers ticking | `curl -H "Authorization: Bearer $ADMIN_TOKEN" https://gateway.noninoni.click/admin/health \| jq '.schedulers \| map({name, last_ok_at, consecutive_failures})'` | All `consecutive_failures < 3`; `last_ok_at` within `interval × 2` | Any `consecutive_failures >= 3` |
| ES writes landing | ES query: `GET ll5_app_log/_count?q=timestamp:[now-15m TO now]` + `ll5_audit_log` + `ll5_session_history` | All > 0 | Any = 0 for 2 consecutive checks |
| Correlation-ids present | `curl https://gateway.noninoni.click/audit/tool-calls?from=<15m ago> \| jq '.calls \| map(.session_id, .trace_id) \| map(select(. == null)) \| length'` | 0 null correlation-ids | > 0 for 2 consecutive checks |
| Workers cycling | `GET ll5_reconcile_metrics/_count?q=timestamp:[now-30m TO now]` + `docker exec agent pgrep -f narrative-loop` | Reconcile count > 0; narrative process present | Reconcile count = 0 for 2 checks OR narrative process absent |
| No duplicate agent | `docker ps \| grep -c agent` | 1 | 2 (immediate rollback) |
| No stale alerts | `curl https://gateway.noninoni.click/alerts \| jq '.alerts \| length'` | 0 unexpected alerts | Any alert with `alert_key` matching `agent_output` or `scheduler.*` |
| FCM delivering | `curl https://gateway.noninoni.click/admin/health \| jq '.fcm.total_failures'` | Not climbing | Climbing over 3 consecutive checks |
| Chat SSE working | Open dashboard `https://ll5.noninoni.click`; verify recent messages load | Messages visible | Dashboard shows no recent messages |
| Reconcile governor | `GET ll5_reconcile_metrics/_search?size=1&sort=timestamp:desc` → check `missed_close_count` + `wrong_close_count` populated | Both non-null | Null for 2 consecutive checks |

#### 4.1.2 Silent failure probes

These won't alarm but indicate problems. Check every 2h:

| Probe | How | Silent-failure signal |
|---|---|---|
| MCP health all green | `curl https://gateway.noninoni.click/admin/health \| jq '.services \| map(select(.healthy == false))'` | Any unhealthy MCP |
| Tool error rate | `GET ll5_app_log/_count?q=success:false AND timestamp:[now-1h TO now]` divided by total | > 10% error rate |
| Stuck-message-sweep pass B flipping | `grep '[StuckMessageSweep][lost]' <gateway logs>` in last 30min | Any "lost" log → agent not processing system messages |
| `agent_output` alert firing | `curl https://gateway.noninoni.click/alerts \| jq '.alerts \| map(select(.alert_key == "agent_output"))'` | Firing → agent silent for 30+min (the 37h pattern starting) |
| `warnEsWriteFailure` in logs | `grep warnEsWriteFailure <gateway logs>` in last 1h | Any → ES writes failing silently (the 8d pattern starting) |
| Token refresh not failing | opencode logs: no `auth` / `token` errors | Token errors → MCP auth breaks silently |
| Compose drift | `.github/workflows/compose-drift-check.yml` passes on next push | Drift → on-host compose diverged |

#### 4.1.3 Dashboard checks (every 4h)

Open these dashboard pages, verify content:
- `https://ll5.noninoni.click` — main chat; recent messages from both
  directions visible.
- `https://ll5.noninoni.click/sessions` — session history; new opencode
  sessions appearing.
- `https://ll5.noninoni.click/admin` (if admin) — health summary; all
  `summary.*_unhealthy` = 0, `fcm_failures` stable, `schedulers_unhealthy` = 0.

#### 4.1.4 Chat verification (hourly)

Send a test message to a dedicated test conversation:
```bash
curl -X POST https://gateway.noninoni.click/chat/messages \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"cutover health probe — respond with OK","conversation_id":"<test-conv-id>"}'
```
Wait 90s. Verify:
- `chat_messages` has a new `direction='outbound'` row from the agent.
- Agent's reply is coherent (acknowledges the probe).
- `ll5_audit_log` has `tool_call` rows from the turn (if any tools were
  called) with `session_id`+`trace_id` populated.

If no reply within 90s: send once more. If still no reply: **rollback**.

#### 4.1.5 Scheduler verification (every 2h)

For each scheduler that should have fired in the last 2h (check
`/admin/health.schedulers` for the expected cadence):
- `chat_messages` has the corresponding `channel='system'` inbound row with
  `metadata.scheduler` populated.
- Agent replied (outbound row within 90s of the system row).

Schedulers to watch especially (the 37h breakage class):
- `evening-close` (fires ~21:00)
- `wake-scheduler` (fires on wake event)
- `daily-review` (fires in morning)
- `heartbeat` (high cadence — every few hours)
- `reconcile-governor` (every 15min — most frequent, earliest signal)

#### 4.1.6 Worker verification (every 2h)

```bash
# Reconcile worker
curl -s "http://gateway.noninoni.click/admin/health" | jq '.schedulers[] | select(.name == "reconcile_governor") | .last_ok_at'
# Should be within 30min.

# Narrative worker
docker exec agent-xkkcc0g4o48kkcows8488so4 pgrep -af narrative-loop
# Should list the process.

# Output quality
curl -s "https://gateway.noninoni.click/narratives?limit=3" | jq '.narratives[0].summary'
# Should be a recent, coherent narrative.
```

### 4.2 Alert Thresholds — Immediate Rollback

| Trigger | Threshold | Action |
|---|---|---|
| Agent container down | `docker compose ps agent` not "Up" | Immediate rollback |
| Duplicate agent container | `docker ps \| grep -c agent` = 2 | Immediate rollback |
| Agent silent | No reply to 2 consecutive health probes (3min apart) | Immediate rollback |
| Scheduler death | Any scheduler `consecutive_failures >= 3` | Immediate rollback |
| ES write death | Any of `ll5_app_log`/`ll5_audit_log`/`ll5_session_history` = 0 new docs for 2 consecutive 15min checks | Immediate rollback |
| Correlation-ids lost | > 0 null correlation-ids in audit for 2 consecutive checks | Immediate rollback |
| `agent_output` alert fires | `system_alerts` has firing `agent_output` | Immediate rollback (the 37h pattern) |
| `warnEsWriteFailure` in logs | Any occurrence | Investigate within 15min; rollback if persists |
| FCM failures climbing | `fcm.total_failures` increases over 3 consecutive checks | Investigate; rollback if user-facing pushes fail |
| MCP unhealthy | Any MCP `healthy:false` for 2 consecutive checks | Investigate; rollback if > 1 MCP unhealthy |

### 4.3 Rollback Drill (Before Cutover)

**Practice rollback BEFORE the real cutover**, during Phase 6 (on a Claude
Code day so production is unaffected by the drill itself).

#### 4.3.1 Drill procedure

1. **Simulate cutover**: On a Claude Code day, note current state.
2. **Simulate flip**: Run the rollback commands but with `AGENT_VARIANT=claude`
   (no-op since already Claude Code, but exercises the full deploy path).
3. **Measure time-to-rollback**: wall-clock from "decision to rollback" to
   "agent responds to a test message on the rolled-back variant".
4. **Verify every checklist item** from §5 after the drill rollback.

#### 4.3.2 Drill rollback commands

```bash
# On host, in /data/coolify/services/xkkcc0g4o48kkcows8488so4:
sed -i 's/^AGENT_VARIANT=.*/AGENT_VARIANT=claude/' .env
# Verify OPENCODE_SERVER_URL derived to empty by the deploy script
grep -E '^(AGENT_VARIANT|OPENCODE_SERVER_URL)=' .env

# Trigger redeploy (or wait for next CI deploy)
# For manual:
docker compose pull agent
docker compose up -d agent

# Verify
docker compose ps agent | grep -q "Up"
docker inspect agent-xkkcc0g4o48kkcows8488so4 | jq '.[0].Config.Image'
# Expect: ghcr.io/arnonzamir/ll5-run-claude:latest

# End-to-end
curl -X POST https://gateway.noninoni.click/chat/messages \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"post-rollback drill probe","conversation_id":"<test-conv>"}'
# Wait 90s, verify reply.
```

#### 4.3.3 Time-to-rollback measurement

| Step | Target | Actual (drill) |
|---|---|---|
| `sed` env flip | < 1 min | |
| `docker compose pull` | < 3 min | |
| `docker compose up -d agent` | < 2 min | |
| Agent healthcheck green | < 2 min (start_period 45s + 30s interval) | |
| First reply to test message | < 90s after healthcheck green | |
| **Total** | **< 10 min** | |

If drill time-to-rollback > 10 min: investigate the bottleneck before real
cutover.

#### 4.3.4 Rollback verification — "Complete" vs "Failed silently"

| Check | "Complete" | "Failed silently" |
|---|---|---|
| `docker ps \| grep -c agent` | 1 | 2 (both variants running) |
| `docker inspect agent...Image` | `ll5-run-claude:latest` | Still `ll5-run-opencode:latest` (pull/recreate failed) |
| `grep OPENCODE_SERVER_URL .env` | Empty | Still `http://agent:4096` (upsert failed) |
| Gateway logs for `[agent-trigger]` | Zero new lines | Still attempting HTTP calls (env not cleared) |
| Test message reply | Coherent reply within 90s | No reply (NOTIFY path broken) or duplicate replies (both agents) |
| Audit ledger correlation-ids | Populated on new tool calls | Null (wrong variant's plugin) |

---

## 5. Silent Failure Detection Checklist (Reusable)

**Every phase deploy must run this checklist end-to-end. No phase proceeds to
the next until every checkbox passes.** Based on the system's history: 37h
silent scheduler breakage, 8-day silent ES write death, channel bridge
double-post, GHCR credential clobber.

### 5.1 All schedulers firing

- [ ] **Check**: `curl -H "Authorization: Bearer $ADMIN_TOKEN" https://gateway.noninoni.click/admin/health | jq '.schedulers | map({name, last_ok_at, consecutive_failures})'`
- [ ] **Healthy**: every scheduler has `last_ok_at` within `interval × 2` and `consecutive_failures < 3`.
- [ ] **Silently broken**: a scheduler's `last_ok_at` is stale (older than `interval × 2`) but `consecutive_failures = 0` — the scheduler died without recording an error (the 37h pattern). Cross-check: `chat_messages` for `metadata.scheduler` rows in the last interval.
- [ ] **Wait before declaring healthy**: 2 × the scheduler's interval (e.g. 20min for a 10min scheduler).

### 5.2 ES writes succeeding

- [ ] **Check**: `curl -u elastic:$ELASTIC_PASSWORD http://elasticsearch:9200/_count?q=timestamp:[now-15m TO now]` for `ll5_audit_log`, `ll5_app_log`, `ll5_session_history`.
- [ ] **Healthy**: all three indices have new docs within the last 15min (during active hours).
- [ ] **Silently broken**: zero new docs but no error logs — ES appears healthy (ping works) but writes fail silently (the 8d pattern). Check gateway logs for `warnEsWriteFailure`.
- [ ] **Wait**: 15min during active hours.

### 5.3 Agent receiving triggers

- [ ] **Check**: `psql -c "SELECT count(*) FROM chat_messages WHERE channel='system' AND direction='inbound' AND created_at > now() - interval '15 min'"` vs `psql -c "SELECT count(*) FROM chat_messages WHERE direction='outbound' AND created_at > now() - interval '15 min'"`
- [ ] **Healthy**: if inbound > 0, outbound > 0 (agent responds to system triggers).
- [ ] **Silently broken**: inbound > 0 but outbound = 0 — agent not processing triggers. Container healthcheck may be green.
- [ ] **Wait**: 15min, or trigger a manual test message.

### 5.4 MCP tool calls landing in audit log

- [ ] **Check**: `curl -H "Authorization: Bearer $TOKEN" https://gateway.noninoni.click/audit/tool-calls?from=<15m ago> | jq '.calls | length'`
- [ ] **Healthy**: > 0 rows with `session_id` + `trace_id` populated during active agent use.
- [ ] **Silently broken**: rows present but `session_id`/`trace_id` null — correlation-id injection died (reconcile governor goes blind). Zero rows when agent is active — MCP tool calls not reaching the audit ledger.
- [ ] **Wait**: one agent turn with tool calls.

### 5.5 Background workers running

- [ ] **Check**: `docker exec agent-xkkcc0g4o48kkcows8488so4 pgrep -af narrative-loop && docker exec agent-xkkcc0g4o48kkcows8488so4 pgrep -af reconcile-loop` + `curl -u elastic:$ELASTIC_PASSWORD http://elasticsearch:9200/ll5_reconcile_metrics/_count?q=timestamp:[now-30m TO now]`
- [ ] **Healthy**: both processes present; reconcile metrics doc within 30min.
- [ ] **Silently broken**: processes present but no metrics docs — workers running but not cycling (stuck). Or processes absent but container healthcheck green.
- [ ] **Wait**: 30min (reconcile cycle is 15min).

### 5.6 No duplicate agent containers

- [ ] **Check**: `docker ps | grep -c agent`
- [ ] **Healthy**: exactly 1.
- [ ] **Silently broken**: 2 — both respond to PG NOTIFY, duplicate messages, conversation corruption (the Phase 4.5 critical risk). Immediate rollback.
- [ ] **Wait**: check after every deploy + 30min into the deploy (Coolify may restart an old container).

### 5.7 Chat SSE working (dashboard loads messages)

- [ ] **Check**: open `https://ll5.noninoni.click`; verify recent messages load.
- [ ] **Healthy**: messages from the last hour visible.
- [ ] **Silently broken**: dashboard loads but shows no recent messages — SSE connection broke, or gateway not emitting NOTIFY.
- [ ] **Wait**: immediate (visual check).

### 5.8 Alert spine active (no stale alerts)

- [ ] **Check**: `curl -H "Authorization: Bearer $TOKEN" https://gateway.noninoni.click/alerts | jq '.alerts | length'`
- [ ] **Healthy**: 0 firing alerts (or only known/expected ones).
- [ ] **Silently broken**: stale alerts firing that should have cleared — `clearAlert` not called. OR no alerts firing when a known condition is bad (alert spine dead).
- [ ] **Wait**: check after every deploy + hourly.

### 5.9 FCM delivering

- [ ] **Check**: `curl -H "Authorization: Bearer $ADMIN_TOKEN" https://gateway.noninoni.click/admin/health | jq '.fcm'`
- [ ] **Healthy**: `total_failures` stable (not climbing); `last_failure_at` not recent.
- [ ] **Silently broken**: `total_failures` climbing — pushes failing (auth token expired, FCM service account invalid). User doesn't get phone notifications.
- [ ] **Wait**: check after every deploy + when a push is expected (e.g. after an alert fires).

### 5.10 GHCR credential intact (post-deploy)

- [ ] **Check**: `docker pull alpine:latest` on host (any non-ll5 image).
- [ ] **Healthy**: pull succeeds.
- [ ] **Silently broken**: `denied` — `secrets.GITHUB_TOKEN` clobbered `/root/.docker/config.json` again (the recurring outage). Verify deploy script uses `GHCR_READ_PAT`, not `secrets.GITHUB_TOKEN`.
- [ ] **Wait**: after every deploy.

### 5.11 Reconcile governor metrics

- [ ] **Check**: `curl -u elastic:$ELASTIC_PASSWORD http://elasticsearch:9200/ll5_reconcile_metrics/_search?size=1&sort=timestamp:desc` → check `missed_close_count` + `wrong_close_count` populated.
- [ ] **Healthy**: both fields non-null; doc within 30min.
- [ ] **Silently broken**: `wrong_close_count` always 0 — governor can't see close events (correlation-id break). `missed_close_count` null — selector query failed.
- [ ] **Wait**: 30min (one governor cycle).

### 5.12 Rule

If any check fails after a phase deploy: **do NOT proceed to the next phase.**
Investigate the silent failure first. The system's history shows silent
failures compound — one undetected failure leads to data corruption that leads
to more failures.

---

## 6. Test Automation

### 6.1 Automatable Tests

| Script | Location | What it checks | How to run | CI integration |
|---|---|---|---|---|
| Gateway unit tests | `packages/gateway/src/__tests__/*.test.ts` (700+ tests) | All gateway logic: system-message, stuck-message-sweep, alerting, schedulers, reconcile, anomaly | `npm test --workspace=packages/gateway` | **Yes** — `build-and-push.yml` typecheck step; add `npm test` step before deploy |
| `agent-trigger.test.ts` (new) | `packages/gateway/src/__tests__/agent-trigger.test.ts` | triggerAgent no-op when env empty; fires when set; throws on failure; cross-tenant | `npm test --workspace=packages/gateway -- agent-trigger` | **Yes** — same as gateway tests |
| `system-message.test.ts` (updated) | `packages/gateway/src/__tests__/system-message.test.ts` | triggerAgent integration in insertSystemMessage; fetch stubs | `npm test --workspace=packages/gateway -- system-message` | **Yes** |
| `stuck-message-sweep.test.ts` (updated) | existing | triggerAgent in pass A; fetch stubs | `npm test --workspace=packages/gateway -- stuck-message-sweep` | **Yes** — already in CI via `npm test` |
| `render-mcp-config.test.ts` (new) | `scripts/__tests__/render-mcp-config.test.ts` (or `packages/shared`) | Renders both formats; 6 MCPs; handles missing endpoints | `npm test --workspace=packages/shared` (or root) | **Yes** — add to build-and-push typecheck/test |
| Reconcile security tests | `scripts/__tests__/reconcile-security.test.ts` (in ll5-run-opencode) | 28+ security checks: allowlist not bypassable via subagent | `npm test` in ll5-run-opencode | **Yes** — ll5-run-opencode CI |
| Plugin unit tests | `packages/*/src/__tests__/*.test.ts` in ll5-run-opencode | Each plugin's logic: deny, dedup, header injection | `npm test` in ll5-run-opencode | **Yes** — ll5-run-opencode CI |
| Compose drift check | `.github/workflows/compose-drift-check.yml` | On-host compose matches repo | Runs automatically on push | **Already in CI** |
| Typecheck | root `package.json` `typecheck` script | All packages compile | `npm run typecheck` | **Yes** — add to build-and-push before build |
| Silent-failure probe script (new) | `scripts/silent-failure-probe.sh` (see §6.3) | All §5 checklist items via curl/psql/ES queries | `bash scripts/silent-failure-probe.sh` (on host or from CI with SSH) | **Yes** — add as a post-deploy step in build-and-push.yml (SSH to host, run probe, fail deploy if any check fails) |

### 6.2 Manual Tests

| Test | Step-by-step | Evidence | Who |
|---|---|---|---|
| Persona probe (Hard Rule 1 verbatim) | 1. Send agent: "State Hard Rule 1 verbatim." 2. Compare reply to `CLAUDE.md` text. | Reply text + CLAUDE.md excerpt | Senior developer |
| 17 skills available | 1. `docker exec agent ls /workspace/.claude/skills \| wc -l`. 2. Send `/daily` and one other skill. | `ls` output + skill outputs | Senior developer |
| 14-Hard-Rules scoring (Phase 6) | 1. Sample 5 agent replies from the test day. 2. Score each rule pass/fail. 3. Compute parity vs baseline. | Scored rubric per day | Senior developer |
| Skill quality scoring (Phase 6) | 1. Run `/daily` on both variants. 2. Score 1-5 on 5 dimensions. 3. Compare. | Scored rubric per skill | Senior developer |
| Worker output quality (Phase 6) | 1. Read narrative-loop output from `ll5_agent_journal`. 2. Score 1-5 on coherence/grounding/action-items. 3. Compare across variants. | Scored rubric + narrative doc excerpts | Backend architect |
| Alert spine response | 1. Manually trigger `raiseAlert` (test key). 2. Watch for `[ALERT]` system message + agent reply within 60s. | `chat_messages` rows + timing | DevOps |
| Rollback drill (Phase 7) | §4.3 drill procedure | Time-to-rollback measurement + checklist | DevOps |
| 24h cutover monitoring (Phase 7) | §4.1 hourly + 2-hourly checks for 24h | Monitoring log with all check results | DevOps + on-call |
| Coolify app deletion (Phase 4.5) | 1. Coolify UI: delete `js8owk0g0cgog800ckc8ww0s`. 2. Watch 30min for auto-restart. | Coolify UI screenshot + `docker ps` logs over 30min | DevOps |
| GHCR credential check | 1. After deploy: `docker pull alpine`. 2. Verify `denied` doesn't occur. 3. Check deploy script uses `GHCR_READ_PAT`. | `docker pull` output + deploy script excerpt | DevOps |

### 6.3 Silent-Failure Probe Script (Automatable)

**Location**: `scripts/silent-failure-probe.sh` (new, in ll5).

**What it checks**: all 12 items from §5, via curl/psql/ES queries. Exits
non-zero if any check fails.

**How to run**:
```bash
# From host, or from CI via SSH:
ADMIN_TOKEN=<admin-token>
USER_TOKEN=<user-token>
ES_CREDS="elastic:$ELASTIC_PASSWORD"
bash scripts/silent-failure-probe.sh
```

**CI integration**: add to `build-and-push.yml` deploy job, after
```
docker compose up -d
```
and the existing health check:
```yaml
      - name: Silent failure probe
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ vars.SERVER_HOST }}
          username: root
          key: ${{ secrets.DEPLOY_SSH_KEY }}
          script: |
            cd /data/coolify/services/${{ secrets.COOLIFY_SERVICE_UUID }}
            bash scripts/silent-failure-probe.sh || exit 1
```
If any check fails, the deploy job fails loudly — preventing a silent bad
deploy from being marked successful.

**Sketch** (pseudo-code — implement in bash with curl/jq/psql):
```bash
#!/bin/bash
set -euo pipefail

FAIL=0
check() { # name, condition-cmd
  local name="$1"; shift
  if "$@"; then echo "PASS: $name"; else echo "FAIL: $name"; FAIL=1; fi
}

# 1. Schedulers firing (all last_ok_at within interval×2, consecutive_failures < 3)
check "schedulers_firing" bash -c '
  curl -s -H "Authorization: Bearer $ADMIN_TOKEN" https://gateway.noninoni.click/admin/health |
  jq -e ".schedulers | all(.consecutive_failures < 3)" >/dev/null
'

# 2. ES writes succeeding (3 indices have docs in last 15min)
check "es_writes_landing" bash -c '
  for idx in ll5_audit_log ll5_app_log ll5_session_history; do
    count=$(curl -s -u "$ES_CREDS" "http://elasticsearch:9200/$idx/_count?q=timestamp:[now-15m TO now]" | jq .count)
    [ "$count" -gt 0 ] || exit 1
  done
'

# 3. Agent receiving triggers (if system inbound in last 15min, outbound > 0)
check "agent_processing" bash -c '
  inb=$(psql -t -c "SELECT count(*) FROM chat_messages WHERE channel='\''system'\'' AND direction='\''inbound'\'' AND created_at > now() - interval '\''15 min'\''")
  out=$(psql -t -c "SELECT count(*) FROM chat_messages WHERE direction='\''outbound'\'' AND created_at > now() - interval '\''15 min'\''")
  [ "$inb" -eq 0 ] || [ "$out" -gt 0 ]
'

# 4. Correlation-ids present (no null session_id/trace_id in recent tool calls)
check "correlation_ids_present" bash -c '
  nulls=$(curl -s -H "Authorization: Bearer $USER_TOKEN" "https://gateway.noninoni.click/audit/tool-calls?from=$(date -u -d '\''15 min ago'\'' +%Y-%m-%dT%H:%M:%S)" |
    jq "[.calls[] | select(.session_id == null or .trace_id == null)] | length")
  [ "$nulls" -eq 0 ]
'

# 5. Background workers running
check "workers_cycling" bash -c '
  docker exec agent-xkkcc0g4o48kkcows8488so4 pgrep -f narrative-loop >/dev/null &&
  docker exec agent-xkkcc0g4o48kkcows8488so4 pgrep -f reconcile-loop >/dev/null &&
  count=$(curl -s -u "$ES_CREDS" "http://elasticsearch:9200/ll5_reconcile_metrics/_count?q=timestamp:[now-30m TO now]" | jq .count)
  [ "$count" -gt 0 ]
'

# 6. No duplicate agent containers
check "single_agent_container" bash -c '
  [ "$(docker ps --format '\''{{.Names}}'\'' | grep -c agent)" -eq 1 ]
'

# 7. Chat SSE working (dashboard reachable)
check "dashboard_reachable" bash -c '
  [ "$(curl -s -o /dev/null -w '\''%{http_code}'\'' https://ll5.noninoni.click)" -eq 200 ]
'

# 8. No stale alerts (no firing alerts with stale last_agent_notified_at)
check "no_stale_alerts" bash -c '
  firing=$(curl -s -H "Authorization: Bearer $USER_TOKEN" https://gateway.noninoni.click/alerts | jq ".alerts | length")
  # Allow known/expected alerts; flag unexpected ones
  [ "$firing" -le 1 ]  # tune threshold
'

# 9. FCM delivering (total_failures not climbing)
check "fcm_healthy" bash -c '
  fails=$(curl -s -H "Authorization: Bearer $ADMIN_TOKEN" https://gateway.noninoni.click/admin/health | jq .fcm.total_failures)
  [ "$fails" -lt 10 ]  # tune threshold
'

# 10. GHCR credential intact
check "ghcr_credential" bash -c '
  docker pull alpine:latest >/dev/null 2>&1
'

# 11. Reconcile governor metrics populated
check "reconcile_metrics_populated" bash -c '
  doc=$(curl -s -u "$ES_CREDS" "http://elasticsearch:9200/ll5_reconcile_metrics/_search?size=1&sort=timestamp:desc")
  echo "$doc" | jq -e ".hits.hits[0]._source.missed_close_count != null" >/dev/null &&
  echo "$doc" | jq -e ".hits.hits[0]._source.wrong_close_count != null" >/dev/null
'

# 12. warnEsWriteFailure not firing
check "no_es_write_failures" bash -c '
  logs=$(docker logs --since 15m gateway-xkkcc0g4o48kkcows8488so4 2>&1 || true)
  echo "$logs" | grep -q "warnEsWriteFailure" && exit 1 || exit 0
'

exit $FAIL
```

**Tuning**: thresholds (alert count, FCM failure count) need calibration
against baseline. Run the script on a known-healthy deploy first, record
baseline values, then set thresholds.

---

## Appendix: Evidence Artifacts per Phase

| Phase | Artifact | Location |
|---|---|---|
| 0 | Image-tag verification log | `docs/implementation/deployment-log.md` |
| 1 | `render-mcp-config.ts` test output + persona probe reply | `docs/implementation/phase-1-verify.md` (new) |
| 2.5 | Probe script output + gate decision | `docs/implementation/phase-2.5-probe-output.log` + `phase-2.5-gate-result.md` |
| 3 | Reconcile security test output + plugin test output | ll5-run-opencode CI |
| 4.5 | 30-min Coolify-restart watch log + `docker ps` snapshots | `docs/implementation/deployment-log.md` |
| 5 | All P5-T7 through P5-T17 verification results | `docs/implementation/phase-5-verify.md` (new) |
| 6 | Daily parity comparison logs + scored rubrics | `docs/implementation/parity-comparison-log.md` |
| 6.5 | Hard-rule-variants doc + model-behavioral-differences doc | `docs/implementation/hard-rule-variants.md` + `model-behavioral-differences.md` |
| 7 | 24h monitoring log + rollback drill timing | `docs/implementation/deployment-log.md` |

---

## Appendix: Quick-Reference — Rollback Commands

**Single-var rollback** (the design's key property — `OPENCODE_SERVER_URL` is
derived from `AGENT_VARIANT` in the deploy script):

```bash
# On host, in /data/coolify/services/xkkcc0g4o48kkcows8488so4:
sed -i 's/^AGENT_VARIANT=.*/AGENT_VARIANT=claude/' .env
grep -E '^(AGENT_VARIANT|OPENCODE_SERVER_URL)=' .env
# Expect:
#   AGENT_VARIANT=claude
#   OPENCODE_SERVER_URL=   (empty — derived by deploy script)

# Trigger redeploy via CI, or manual:
docker compose pull agent
docker compose up -d agent

# Verify
docker compose ps agent | grep -q "Up"
docker inspect agent-xkkcc0g4o48kkcows8488so4 | jq '.[0].Config.Image'
# Expect: ghcr.io/arnonzamir/ll5-run-claude:latest

docker ps | grep -c agent
# Expect: 1

# End-to-end
curl -X POST https://gateway.noninoni.click/chat/messages \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"post-rollback probe","conversation_id":"<test-conv>"}'
# Wait 90s, verify reply.

# Silent-failure checklist (§5)
bash scripts/silent-failure-probe.sh
```

**Target time-to-rollback**: < 10 minutes from decision to verified agent
reply.
