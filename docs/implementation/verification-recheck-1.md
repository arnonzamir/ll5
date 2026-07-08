# Verification Re-check Report (Round 1)

**Date**: 2026-07-08
**Purpose**: Verify that 8 blocking + 3 significant issues from the prior review were correctly fixed in the implementation documents.
**Files checked**:
- `docs/implementation/impl-gateway-shared.md`
- `docs/implementation/impl-opencode-variant.md`
- `docs/implementation/impl-docker-cicd.md`
- `docs/implementation/impl-security.md`

---

## Summary

| # | Issue | Status | Residuals |
|---|---|---|---|
| 1 | triggerAgent `context` field | **FIXED** | Stale `context: [{` in impl-security.md descriptive block |
| 2 | 6 undocumented gateway endpoints | **FIXED** | NEW: `/internal/recall-lessons` undocumented (introduced by issue 9 fix) |
| 3 | render-mcp-config.ts flag mismatch | **FIXED** | None |
| 4 | Render script overwrites opencode.json | **FIXED** | Stale usage comment in impl-gateway-shared.md line 241 |
| 5 | MCP server naming inconsistency | **FIXED** | None in checked docs |
| 6 | sessionType naming mismatch | **FIXED** | Residual underscores in impl-testing.md + impl-docker-cicd.md acceptance criteria |
| 7 | Bun runtime missing | **PARTIALLY FIXED** | impl-opencode-variant.md §2.5.5 + §3.3 still use `Bun.serve()` |
| 8 | TypeScript compilation missing | **PARTIALLY FIXED** | Proxy entrypoint line still uses `node ... .js` in both docs |
| 9 | memory-recall hook has no plugin | **FIXED** | NEW: calls undocumented `/internal/recall-lessons` endpoint |
| 10 | reconcile worker permission approach | **FIXED** | None |
| 11 | opencode plugin API corrections in security plan | **PARTIALLY FIXED** | turn-context.ts full code still uses direct hook names |

**Result**: 7 FIXED, 3 PARTIALLY FIXED, 1 FIXED-with-new-inconsistency. 0 NOT FIXED.

---

## Detailed Findings

### Issue 1: triggerAgent `context` field — FIXED

**Check**: `impl-gateway-shared.md`
- `body.context`: NOT found. ✓
- `[meta]` in parts array: Found at line 651:
  ```typescript
  { type: 'text', text: `[meta] ${JSON.stringify(payload.metadata)}` },
  ```
  Prepended to `body.parts` before content. ✓

**Residual** (not in checked file, but related):
- `impl-security.md` line 127: Descriptive code block in §1b still shows the old `context: [{ ... }]` pattern as if it's current. This section describes "How the current hook works" and references `triggerAgent` passing metadata via `context` part. Now stale — should describe the `parts` prepend approach.
- `dual-run-variant-plan.md` line 199: Also has stale `context: [{` (master plan, not in scope).

---

### Issue 2: 6 undocumented gateway endpoints — FIXED

**Check**: `impl-gateway-shared.md`
- Section "2.2.1 Additional `/internal/*` endpoints for opencode plugins" exists at line 834. ✓
- Table documents all 6 endpoints + 2 existing-endpoint redirects:
  - `/internal/ingest-memory` — forwards to awareness MCP `ingest_memory` ✓
  - `/internal/regrounding` — aggregates regrounding context ✓
  - `/internal/eval-moment` → use existing `/telemetry/eval-moment` ✓
  - `/internal/activity` — writes PG activity row ✓
  - `/internal/continuity-probe` — writes appLog ✓
  - `/internal/memory-intercept-log` — writes appLog ✓
  - `/auth/verify` → use existing `GET /me/onboarding` ✓

**Check**: `impl-opencode-variant.md`
- `eval-recorder.ts` (line 1341): calls `gw("/telemetry/eval-moment", ...)` ✓
- `session-start.ts` (line 1175): calls `fetch(${GATEWAY_URL}/me/onboarding, ...)` ✓

**NEW INCONSISTENCY introduced by issue 9 fix**:
- `memory-recall.ts` (line 1455) calls `gw("/internal/recall-lessons", { query: text })` — this endpoint is NOT documented in §2.2.1. The §2.2.1 summary (line 851-858) lists all plugin→endpoint mappings but does not include `/internal/recall-lessons`. This is a new undocumented endpoint.

---

### Issue 3: render-mcp-config.ts flag mismatch — FIXED

**Check**: `impl-docker-cicd.md`
- Line 80: `--config /workspace/mcp-endpoints.json \` ✓
- Line 179: `--config /workspace/mcp-endpoints.json \` ✓
- No `--input` flag found anywhere in `impl-docker-cicd.md`. ✓

**Also verified**: `impl-gateway-shared.md` Dockerfile usage (lines 418, 421, 424) all use `--config`. ✓

---

### Issue 4: Render script overwrites opencode.json — FIXED

**Check**: `impl-docker-cicd.md`
- Line 180: `--output /workspace/opencode-mcp-fragment.json` ✓
- Lines 173-176: Comment explains "emits an MCP-only fragment (NOT the full opencode.json — the variant repo's opencode.json has model/agent/plugin config that must NOT be overwritten)". ✓

**Check**: `impl-gateway-shared.md`
- Line 188: "Output 2: opencode `opencode-mcp-fragment.json` (MCP section only — merged with variant repo's opencode.json at startup)" ✓
- Line 190: Merge note: "The render script outputs ONLY the `mcp` section — NOT a complete `opencode.json`... The `docker-entrypoint.sh` merges this fragment into the variant repo's `opencode.json` at startup" ✓

**Residual**: `impl-gateway-shared.md` line 241 — the render script's usage comment still shows:
```
 *     --output /workspace/opencode.json \
 *     --section mcp
```
This should be `--output /workspace/opencode-mcp-fragment.json` and the `--section mcp` flag doesn't exist in the script's arg parser. Stale usage example.

---

### Issue 5: MCP server naming inconsistency — FIXED

**Check**: `impl-gateway-shared.md`
- `mcp-endpoints.json` (lines 114-149) uses: `personal-knowledge`, `gtd`, `awareness`, `google`, `health`, `messaging`. ✓
- Line 64: Documentation table row showing the rename from `ll5-knowledge` → `personal-knowledge` (this is the rename documentation, acceptable per issue description). ✓

**Cross-check**: No `ll5-knowledge`, `ll5-gtd`, `ll5-calendar`, `ll5-health`, `ll5-messaging` found in actual code blocks of the 4 checked docs. The only matches are:
- Documentation table rows showing the rename (acceptable)
- Docker image names like `ghcr.io/arnonzamir/ll5-gtd:latest` in deployment docs (legitimate image names, not MCP server names)
- Verification/review docs describing the old issue (not implementation docs)

**Note**: The `pk__` prefix in the security plan's allowlist (e.g., `pk__get_person`) is a separate concern — whether opencode uses `pk__` or `personal-knowledge__` as the tool prefix. The security plan acknowledges this uncertainty (lines 241-247) and defers to Phase 2.5 validation. Not a regression.

---

### Issue 6: sessionType naming mismatch — FIXED (with residuals in other docs)

**Check**: `impl-gateway-shared.md`
- Line 699: `"sessionType": "main"` with valid types comment: `"main" | "narrative-loop" | "reconcile-loop"` ✓
- Line 715: Error message: `sessionType must be one of: main, narrative-loop, reconcile-loop` ✓
- Line 742: `validTypes = ['main', 'narrative-loop', 'reconcile-loop']` ✓
- All use hyphens. ✓

**Check**: `impl-opencode-variant.md`
- `narrative-loop.ts` (line 1502): `sessionType: "narrative-loop"` ✓
- `reconcile-loop.ts` (line 1561): `sessionType: "reconcile-loop"` ✓
- Worker registration uses hyphens. ✓

**Residual** (in other docs, not the 2 checked files):
- `impl-testing.md` line 238: `"narrative_loop + reconcile_loop keys populated"` — should be hyphens
- `impl-testing.md` line 372: `"narrative_loop+reconcile_loop keys"` — should be hyphens
- `impl-docker-cicd.md` line 1311: `"Check agent_sessions for narrative_loop + reconcile_loop"` — should be hyphens
- `dual-run-variant-plan.md` line 261: `narrative_loop: "uuid", reconcile_loop: "uuid"` — should be hyphens

These acceptance criteria / test expectations would fail because the gateway stores hyphenated keys but the tests check for underscored keys.

**Note**: `gtd__reconcile_loop` in impl-security.md and impl-opencode-variant.md is a TOOL name (MCP tool), not a sessionType. Tool names correctly use underscores. This is unrelated to the sessionType issue.

---

### Issue 7: Bun runtime missing — PARTIALLY FIXED

**Check**: `impl-security.md`
- Line 1623: `import { createServer, IncomingMessage, ServerResponse } from "node:http";` ✓
- Line 1662: `const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {` ✓
- No `Bun.serve` in impl-security.md proxy code. ✓

**NOT FIXED in impl-opencode-variant.md**:
- §2.5.5 (line 454): `const server = Bun.serve({` — still uses Bun.serve
- Line 418 comment says "Run with: npx tsx scripts/correlation-id-proxy.ts (Node.js, no Bun needed)" — comment was updated but code was NOT. Direct contradiction.
- §3.3 (line 997): `// Add at the end, after Bun.serve:` — references the unfixed §2.5.5 version

**Impact**: The security plan's proxy (§3c) is correct, but the opencode variant plan's proxy (§2.5.5, §3.3) would crash with `ReferenceError: Bun is not defined` when run in the Docker container (no Bun installed). The two documents are now inconsistent — the security plan was fixed but the opencode variant plan was not.

---

### Issue 8: TypeScript compilation missing — PARTIALLY FIXED

**Check**: `impl-opencode-variant.md`
- Worker scripts use `tsx`:
  - Line 2063: `tsx /workspace/scripts/register-session.ts` ✓
  - Line 2076: `tsx /workspace/scripts/narrative-loop.ts` ✓
  - Line 2077: `tsx /workspace/scripts/reconcile-loop.ts` ✓
  - Line 2078: `tsx /workspace/scripts/continuity-probe.ts` ✓
  - Line 2084: `tsx /workspace/scripts/session-backup.ts` ✓
  - Line 2089: `tsx /workspace/scripts/autoheal.ts` ✓

**NOT FIXED — proxy line**:
- Line 2027: `node /workspace/scripts/correlation-id-proxy.js &`
  - Wrong runner: `node` instead of `tsx`
  - Wrong extension: `.js` instead of `.ts`
  - The file is `correlation-id-proxy.ts`, not `.js`
  - No compilation step in the Dockerfile — `node` cannot run `.ts` files

**Same issue in impl-security.md**:
- Line 1835: `node /workspace/scripts/correlation-id-proxy.js &`
  - Same problem: `node` + `.js` for a `.ts` file

**Impact**: The proxy would fail to start with `Error: Cannot find module '/workspace/scripts/correlation-id-proxy.js'` (file doesn't exist) or a syntax error (if a stale `.js` somehow exists). All MCP tool calls would fail — no correlation-ids, no auth headers.

---

### Issue 9: memory-recall hook has no plugin — FIXED

**Check**: `impl-opencode-variant.md`
- §3.5.5 exists at line 1423: `memory-recall.ts` plugin with full code. ✓
- Race condition note (line 1429): "This is a race condition — the `message.updated` event fires AFTER the message is written to the session, and the model may start processing immediately." ✓
- Phase 2.5 validation requirement (line 1431): "Phase 2.5 must validate whether this race condition is acceptable." ✓
- Gateway-side alternative (line 1479): "The `triggerAgent` function in `agent-trigger.ts` calls `recall_lessons` via the awareness MCP before sending the prompt to opencode, and prepends the result as a `parts` entry" ✓
- Plugin included in `opencode.json` plugin array (line 1776). ✓

**NEW INCONSISTENCY**: The plugin calls `gw("/internal/recall-lessons", { query: text })` (line 1455) — this endpoint is NOT documented in `impl-gateway-shared.md` §2.2.1. The §2.2.1 table lists 8 endpoints but `/internal/recall-lessons` is not among them. This is a new undocumented gateway endpoint introduced by this fix.

---

### Issue 10: reconcile worker permission approach — FIXED

**Check**: `impl-opencode-variant.md`
- Lines 1829-1840: Note explains both approaches:
  - `tools` boolean map (`true` = enabled, `false` = disabled) — the typed mechanism
  - `"*": "deny"` wildcard — the documented pattern (validate at runtime)
  - Fallback: `reconcile-gate.ts` plugin using `tool.execute.before` that checks sessionID and denies non-allowlisted tools mechanically ✓
- The `opencode.json` agent config (lines 1814-1823) uses the `tools` boolean map.
- The security plan (§2c) uses `"*": "deny"` + specific allows.
- Both approaches are documented with the fallback clearly stated. ✓

---

### Issue 11: opencode plugin API corrections in security plan — PARTIALLY FIXED

**Check**: `impl-security.md`

**Fixed** — inline snippet at line 1789:
```typescript
// NOTE: opencode dispatches all events through a single `event` hook.
// `session.created` is an Event type, not a direct hook name.
event: async ({ event }) => {
  if (event.type !== "session.created") return
  ...
}
```
✓ Correct pattern.

**Fixed** — inline snippet at line 1805:
```typescript
// NOTE: `message.updated` is an Event type dispatched through `event` hook.
event: async ({ event }) => {
  if (event.type !== "message.updated") return
  ...
}
```
✓ Correct pattern.

**NOT FIXED — full turn-context.ts plugin code (lines 462-521)**:
```typescript
export const TurnContextPlugin: Plugin = async ({ client }) => {
  return {
    "message.updated": async (event) => {   // ← line 465: WRONG — direct hook name
      ...
    },
    "session.idle": async () => {            // ← line 512: WRONG — direct hook name
      ...
    },
  }
}
```

These use `"message.updated"` and `"session.idle"` as direct hook names. Per §0.1 of `impl-opencode-variant.md`, these are `Event.type` values that must be dispatched through the single `event` hook, not direct hooks. The full plugin code contradicts the inline snippets at lines 1789/1805 which use the correct `event` hook pattern.

**Should be**:
```typescript
event: async ({ event }) => {
  if (event.type === "message.updated") { ... }
  if (event.type === "session.idle") { ... }
}
```

**Also residual from Issue 1**: `impl-security.md` line 127 still has `context: [{` in a descriptive code block (§1b "How the current hook works"). This describes the old `triggerAgent` approach and is now stale.

---

## New Inconsistencies Introduced by Fixes

### N1: `/internal/recall-lessons` endpoint undocumented

**Where**: `impl-opencode-variant.md` line 1455 (memory-recall.ts plugin)
**Problem**: The new `memory-recall.ts` plugin (fix for issue 9) calls `gw("/internal/recall-lessons", { query: text })`, but this endpoint is not in the §2.2.1 table of `impl-gateway-shared.md` (fix for issue 2).
**Fix needed**: Add `/internal/recall-lessons` to the §2.2.1 table — it should forward to the awareness MCP's `recall_lessons` tool server-side (same pattern as `/internal/ingest-memory`).

### N2: `Bun.serve` still in impl-opencode-variant.md §2.5.5

**Where**: `impl-opencode-variant.md` lines 454, 997
**Problem**: The security plan's proxy (impl-security.md §3c) was rewritten to use `createServer` from `node:http`, but the opencode variant plan's proxy (§2.5.5 and §3.3) was NOT updated. The §2.5.5 comment says "Node.js, no Bun needed" but the code uses `Bun.serve()`.
**Fix needed**: Rewrite §2.5.5 proxy code to use `createServer` from `node:http` (same as impl-security.md §3c). Update §3.3 to reference the corrected version.

### N3: Proxy entrypoint uses `node ... .js` instead of `tsx ... .ts`

**Where**: `impl-opencode-variant.md` line 2027, `impl-security.md` line 1835
**Problem**: The entrypoint proxy startup line was not updated when the worker scripts were fixed to use `tsx`. The proxy file is `.ts` but the entrypoint calls `node correlation-id-proxy.js`.
**Fix needed**: Change to `tsx /workspace/scripts/correlation-id-proxy.ts &` in both docs.

### N4: Stale usage comment in render-mcp-config.ts

**Where**: `impl-gateway-shared.md` line 241
**Problem**: The usage comment in the render script still shows `--output /workspace/opencode.json` and a `--section mcp` flag that doesn't exist in the arg parser.
**Fix needed**: Update to `--output /workspace/opencode-mcp-fragment.json` and remove `--section mcp`.

### N5: Stale `context: [{` in impl-security.md §1b

**Where**: `impl-security.md` line 127
**Problem**: The descriptive section "How the current hook works" still shows `triggerAgent` passing metadata via `context: [{ type: "text", text: "[meta] ..." }]`. The actual `triggerAgent` (fixed in impl-gateway-shared.md) now prepends to `parts`, not `context`.
**Fix needed**: Update the descriptive code block to show the `parts` prepend approach.

### N6: Acceptance criteria use underscored sessionType keys

**Where**: `impl-testing.md` lines 238, 372; `impl-docker-cicd.md` line 1311
**Problem**: These acceptance criteria check for `narrative_loop` + `reconcile_loop` (underscores) in `agent_sessions`, but the gateway now stores `narrative-loop` + `reconcile-loop` (hyphens). Tests would fail.
**Fix needed**: Change to hyphenated keys in all acceptance criteria.

---

## Conclusion

The 8 blocking + 3 significant issues were substantially addressed. 7 of 11 are fully FIXED in the checked files. 3 are PARTIALLY FIXED (issues 7, 8, 11) — the primary fix was applied but residual instances remain in code blocks that were not updated. 1 is FIXED but introduced a new undocumented endpoint (issue 9 → N1).

The most critical residuals:
1. **N3** (proxy entrypoint `node .js`): Would crash at runtime — proxy won't start, all MCP calls fail.
2. **N2** (`Bun.serve` in opencode variant): Would crash at runtime — `ReferenceError: Bun is not defined`.
3. **Issue 11** (direct hook names in turn-context.ts): Plugin would not fire — `message.updated` and `session.idle` are not valid hook names.

These 3 should be fixed before implementation proceeds.
