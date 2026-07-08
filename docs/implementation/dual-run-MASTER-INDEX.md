# Dual Run-Variant Implementation — Master Index

## Status: READY

Single-user demo system. No gradual rollouts, no parity testing weeks. Build, switch, fix what breaks. Rollback is one env var change.

**Timeline: ~2 weeks** (down from 5-6 weeks — no parity testing phase, 1-hour fail-fast gate instead of 3 days, no 24-hour cutover monitoring).

---

## Document Inventory

| # | Document | Author | Lines | Purpose |
|---|---|---|---|---|
| 1 | `dual-run-variant-plan.md` | (you + 3 review agents) | 673 | Master design document (v2, post-review) |
| 2 | `dual-run-build-order.md` | Senior PM | 755 | Dependency graph, build order, 137 tasks, effort estimates, risk per phase |
| 3 | `impl-gateway-shared.md` | Backend Architect | 1554 | Phase 1 (shared content) + Phase 2 (gateway trigger) — full code, migration SQL, test code |
| 4 | `impl-docker-cicd.md` | DevOps Automator | 1341 | Phase 4 (Dockerfiles + CI) + Phase 4.5 (standalone→compose) + Phase 5 (compose deploy) — full YAML, Dockerfiles, shell scripts |
| 5 | `impl-security.md` | Security Engineer | 1914 | External-authority-gate plugin, reconcile worker security model, correlation-id proxy sidecar — full code, threat model, 28-check security test |
| 6 | `impl-opencode-variant.md` | Senior Developer | 2147 | Phase 2.5 (fail-fast slice) + Phase 3 (full opencode repo) — 16 plugins, 5 workers, opencode.json, agent definitions, entrypoint |
| 7 | `impl-testing.md` | Reality Checker | 1417 | Per-phase testing, Phase 2.5 validation, Phase 6 parity protocol, Phase 7 cutover monitoring, silent-failure checklist |
| 8 | `verification-architecture.md` | Architecture Verifier | ~600 | Cross-document consistency, completeness, dependency integrity, security coverage |
| 9 | `verification-feasibility.md` | Feasibility Verifier | ~500 | Code correctness, opencode API accuracy, implementation clarity, operational readiness |

**Total**: ~10,400 lines of implementation documentation across 9 documents.

---

## Build Order

```
Phase 0: Rename ll5-run → ll5-run-claude-code (1 hour)
    │
    ▼
Phase 1: Extract shared content to ll5 (1-2 days) ──────┐
    │                                                    │
    ▼                                                    ▼
Phase 2: Gateway agent-trigger (1 day) ──→ Phase 2.5: FAIL-FAST GATE (1 hour)
    │                                                    │
    │                                                    ▼
    │                                          Phase 3: opencode variant (1 week)
    │                                                    │
    ▼                                                    ▼
Phase 4: Dockerfiles + CI (1-2 days) ◄───────────────────┘
    │
    ▼
Phase 4.5: Standalone→compose transition (1 hour)
    │
    ▼
Phase 5: Compose + deploy (1 day)
    │
    ▼
Phase 6: Switch and use it (immediate — fix what breaks)
```

**Critical path**: Phase 2 → 2.5 → 3 → 4 → 4.5 → 5 → 6 = ~2 weeks
**Fail-fast gate**: Phase 2.5 (1 hour) blocks the 1-week Phase 3 investment
**Rollback**: `AGENT_VARIANT=claude` + deploy — one env var

---

## Blocking Issues Found by Verification (must fix before implementation)

### 1. `triggerAgent` sends `context` field — opencode API has no such field
- **Where**: `impl-gateway-shared.md` (agent-trigger.ts)
- **Issue**: The `triggerAgent` function sends `context: [{ type: "text", text: ... }]` in the POST body. The opencode API has no `context` field — metadata would be silently dropped.
- **Fix**: Prepend metadata as a `parts` entry: `parts: [{ type: "text", text: `[meta] ${JSON.stringify(metadata)}` }, { type: "text", text: content }]`
- **Effort**: 30 min

### 2. 6 undocumented gateway endpoints
- **Where**: `impl-opencode-variant.md` (plugins call `/internal/ingest-memory`, `/internal/regrounding`, `/internal/eval-moment`, `/internal/activity`, `/internal/continuity-probe`, `/internal/memory-intercept-log`)
- **Issue**: These endpoints don't exist in the gateway plan or build-order. Plugins would 404 silently.
- **Fix**: Either (a) add these endpoints to the gateway plan + build-order, or (b) change plugins to call existing gateway endpoints (`/chat/messages`, `/telemetry/eval-moment`, etc.) or MCP tools directly
- **Effort**: 2 hours

### 3. `render-mcp-config.ts` flag mismatch
- **Where**: `impl-docker-cicd.md` (Dockerfiles use `--input`) vs `impl-gateway-shared.md` (script supports `--config`)
- **Issue**: Docker build would fail — the flag name doesn't match.
- **Fix**: Standardize on one flag name across both documents
- **Effort**: 15 min

### 4. Render script overwrites complete `opencode.json`
- **Where**: `impl-gateway-shared.md` (render-mcp-config.ts) vs `impl-opencode-variant.md` (opencode.json)
- **Issue**: The render script writes a complete `opencode.json` with only MCP config, destroying the model/agent/plugin/permission config from the variant repo.
- **Fix**: Render script should output an MCP-only fragment that gets merged into the variant repo's `opencode.json`, OR the Dockerfile should COPY the variant repo's opencode.json and the render script should patch only the `mcp` section
- **Effort**: 1 hour

### 5. MCP server naming inconsistency
- **Where**: `impl-gateway-shared.md` (`ll5-knowledge`) vs `impl-opencode-variant.md` (`personal-knowledge`) vs `impl-security.md` (`pk__`)
- **Issue**: The external-authority-gate's safe-tool allowlist uses wrong MCP server names → security gate breaks.
- **Fix**: Standardize on one naming convention across all documents. The actual MCP server names (from docker-compose.prod.yml) are `personal-knowledge`, `gtd`, `awareness`, `google`, `messaging`, `health`, `vault`.
- **Effort**: 1 hour

### 6. `sessionType` naming mismatch
- **Where**: `impl-opencode-variant.md` (`narrative-loop`) vs `impl-gateway-shared.md` (`narrative_loop`)
- **Issue**: Worker session registration would fail with 400 (hyphen vs underscore).
- **Fix**: Standardize on one convention (recommend hyphenated: `narrative-loop`, `reconcile-loop`)
- **Effort**: 15 min

### 7. Bun runtime missing from Dockerfile
- **Where**: `impl-security.md` (correlation-id proxy uses `Bun.serve()`) vs `impl-docker-cicd.md` (Dockerfile doesn't install Bun)
- **Issue**: The proxy sidecar won't run — `Bun.serve()` requires the Bun runtime, not Node.
- **Fix**: Either (a) add `RUN npm install -g bun` to the opencode Dockerfile, or (b) rewrite the proxy using Node's `http` module instead of `Bun.serve()`
- **Effort**: 30 min (option a) or 1 hour (option b)

### 8. TypeScript compilation missing
- **Where**: `impl-opencode-variant.md` (entrypoint calls `node scripts/*.js`) vs scripts written as `.ts`
- **Issue**: The entrypoint tries to run `.js` files but the worker scripts are `.ts` — they need compilation or a TypeScript runner.
- **Fix**: Either (a) add `RUN npx tsc` to the Dockerfile, or (b) use `npx tsx scripts/*.ts` in the entrypoint, or (c) use `bun scripts/*.ts`
- **Effort**: 30 min

---

## Significant (non-blocking) Issues

1. **Hook #6 (memory-recall) has no plugin** — the UserPromptSubmit hook that injects `recall_lessons` before the model sees the prompt. The opencode plan mentions SDK injection but doesn't provide the implementation. Needs a plugin or SDK-level injection mechanism.

2. **Reconcile worker permission approach differs** — security plan uses `"*": "deny"` + specific allows (from opencode docs), opencode plan uses `tools` boolean map (from TypeScript types). Phase 2.5 must validate which actually works. Fallback: `tool.execute.before` plugin that mechanically denies non-allowlisted tools.

3. **opencode plugin API corrections** (found by Senior Developer):
   - `session.created`/`session.idle`/`message.updated` are NOT direct hooks — they're `Event` types dispatched through the single generic `event` hook
   - `tool.execute.before` puts args in `output` param, not `input`
   - These corrections are documented in the opencode plan §0 but may not be reflected in the security plan's code examples

4. **Phase 6 parallel operation** — the testing plan correctly identifies that running both agents simultaneously risks both responding to the same trigger. The recommended approach (alternating days) is safer but means the live system is on opencode during testing days.

---

## What's Ready to Implement Now

These phases have no blocking issues and can begin immediately:

| Phase | Status | Blocker |
|---|---|---|
| Phase 0: Rename | READY | None |
| Phase 1: Extract shared content | READY (after fix #3, #4, #5) | 3 naming/render fixes (~2h) |
| Phase 2: Gateway agent-trigger | READY (after fix #1, #2, #6) | 3 code fixes (~3h) |

Phase 2.5 (fail-fast gate) is ready after Phase 2 fixes.

Phase 3+ depends on Phase 2.5 passing.

---

## Verification Verdicts

### Architecture verification: NOT READY — one revision pass needed (~7.5h)
- 8 blocking inconsistencies (listed above)
- Design is sound, fail-fast gate criteria are specific and evidence-based
- Timeline (6 weeks) realistic if fixes applied

### Feasibility verification: NOT READY — 5 blocking, 7 significant
- 5 blocking issues would cause runtime failures (Bun proxy on Node, context field, Dockerfile flag, render overwrites opencode.json, .ts run as .js)
- 7 significant issues need addressing but won't block Phase 0-2
- Architecture is sound, most code is real (not pseudocode)
- Fix effort: ~4-6h blocking, ~3-4h significant

---

## Recommended Next Steps

1. **Fix the 8 blocking issues** (~7.5 hours of document revision)
2. **Begin Phase 0** (rename) — no blockers, lowest risk, establishes naming convention
3. **Fix Phase 1-2 issues in parallel with Phase 0** (naming, render script, triggerAgent)
4. **Begin Phase 1-2** once fixes applied
5. **Begin Phase 2.5** after Phase 2 — this is the fail-fast gate that validates the core assumption
6. **If Phase 2.5 passes**: proceed to Phase 3+ per the build order
7. **If Phase 2.5 fails**: Phases 0-2 are still net-positive (shared content, gateway trigger), stop opencode effort

---

## Agent Roster Used

| Wave | Agent | Role | Output |
|---|---|---|---|
| 1 | Senior Project Manager | Dependency graph, build order, 137 tasks | `dual-run-build-order.md` |
| 1 | Backend Architect | Gateway + shared content impl (Phases 1, 2) | `impl-gateway-shared.md` |
| 1 | DevOps Automator | Docker + CI/CD impl (Phases 4, 4.5, 5) | `impl-docker-cicd.md` |
| 1 | Security Engineer | Security impl (gate, reconcile, correlation-ids) | `impl-security.md` |
| 2 | Senior Developer | opencode variant impl (Phase 2.5, 3) | `impl-opencode-variant.md` |
| 2 | Reality Checker | Testing plans for all phases | `impl-testing.md` |
| 3 | Architecture Verifier | Cross-document consistency check | `verification-architecture.md` |
| 3 | Feasibility Verifier | Code correctness + implementation clarity | `verification-feasibility.md` |

All agents used the Agency agent definitions from `~/.claude/agents/` (engineering, testing, project-management, specialized divisions).
