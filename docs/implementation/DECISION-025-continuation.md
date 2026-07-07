# DECISION-025 — continuation & orchestration brief (for a fresh Claude Code session)

You are picking up a large, in-flight implementation. The **design is finished and accepted**; a substantial chunk is **built + tested**; your job is to **finish the rest** by fanning out scoped agents, testing locally, and deploying **only with the user's explicit go**. Read this brief, then work the backlog below.

## 0. Context & token discipline (read first — this is how you avoid limits)

- **Do NOT read the whole design/BRD/transcript into your own context.** Read §1's artifacts **once, briefly**, to orient — then treat them as the source of truth and *reference* them.
- **Delegate detail to subagents.** For each backlog item, spawn ONE agent with: the exact files to read, the precise task, and the tests to write. The agent reads deeply; you keep only its result. Fan out independent items in parallel (background). Synthesize; don't re-do their reading.
- **Work in small, committed increments.** Build one component → test it locally → commit it → move on. Never accumulate a huge uncommitted diff or a huge context. After each commit, your working set shrinks.
- **Never inline** whole files, full test output, or transcripts into a message. Summarize.
- If your context gets heavy, checkpoint (commit + update PROGRESS/HANDOFF) and continue fresh.

## 1. Source of truth (read once, then reference)

- `docs/decisions/DECISION-025-active-context-integration.md` — the design (v6, **accepted**). D1–D7, the honest-scope notes, the security controls, the review→fix tables.
- `docs/requirements/BRD-active-context-integration.md` — FR-1…FR-9 + **§7 acceptance/verification** (your test spec).
- `docs/PROGRESS.md` (search "DECISION-025") + `docs/HANDOFF.md` — current build state, deploy paths, ops traps.
- Committed code you build ON: gateway `open-loops.ts`, `reconcile.ts`, `reconcile-gate.ts` (+ `__tests__/`); gtd `migrations/003_reconciliation_columns.sql`; ll5-run `scripts/reconcile-loop.sh`, `prompts/reconcile-loop.md`, `.mcp.reconcile.json`, `scripts/test_reconcile_security.py`.

## 2. Done — do NOT rebuild

- **D1 reactive grounding is LIVE** (ll5-run Rule 15 = understand→fulfill→verify + external-web class; `WebFetch`/`WebSearch` in `GROUNDING_TOOLS`). Deployed + verified.
- **Deterministic spine, built + tested** (gateway, 674 tests, committed, NOT deployed): `getOpenLoops` (D2), migration 003 columns (D4), `listReconcileWork` selector (D4), `reconcile-gate` (D5/D6 — stakes routing, atomic close, circuit-breaker).
- **Worker scaffold, built + security-tested** (ll5-run, committed, NOT deployed, NOT yet runnable): locked-down `reconcile-loop.sh` (allowlist + `--disallowedTools`, `pgrep`-yield, 300s), `prompts/reconcile-loop.md` (DATA-not-COMMANDS fence), `.mcp.reconcile.json`, `test_reconcile_security.py` (28 checks green).

## 3. Backlog (each item = a fanout target with its own agent prompt)

**Phase A — make the worker runnable (critical path):**
- **A1. GTD MCP tools** `list_reconcile_work` + `reconcile_loop`. The worker calls these (`mcp__gtd__…`). Mirror the *tested* gateway logic (`reconcile.ts`, `reconcile-gate.ts`) into GTD MCP tools; give the GTD MCP a **read-only awareness-ES client** for the "inbound newer than reviewed_at" check. Tenant-scope by the token, not a caller arg. Tests: selector + gate parity with the gateway versions; injected-`userId`-ignored.
- **A2. Stamp `conversation_id`/`stakes` at loop creation** — GTD `add_action`/create paths + the triage path + a persona line so the agent links the thread + classifies stakes when creating a waiting-for from a conversation. Test: every creation path stamps both; `stakes` defaults `consequential` (fail-safe).
- **A3. Human-confirm UX** — surface a `needs_confirm` (reuse the tray, `tray.ts`) + a confirm endpoint that calls `confirmReconcileClose`. Test: confirm closes; no second writer.

**Phase B — the governor / make it observable:**
- **B1. Governor scheduler** — a gateway tick (or extend an existing one) runs `listReconcileWork` → writes `missed_close_count` (+ `wrong_close_count`, `reconciliation_coverage`) to an ES doc for anomaly-monitor.
- **B2. `wrong_close` (zero-grounding-close) + `reconciliation_coverage`** (grounding-call numerator, not the stamp).
- **B3. anomaly-monitor checks** for B1's metrics + **reconcile-loop liveness** (list_reconcile_work freshness) + **narrative non-degradation regression** (narrative tick cadence/cost before-vs-after; trips on *slow*, not just dead).
- **B4. eval telemetry** — new fields on gateway `/telemetry/eval-moment` whitelist + `ll5_eval_moments` mapping; extend the ungrounded-action check in `eval_record.py` to **closes** (IDs/counts only — no message bodies; test it).
- **B5. `message-batch-review`** embeds `getOpenLoops` **read-only** (awareness only) — best-effort, capped.

**Phase C — tests + deploy:**
- **C1. §7 tests** still missing: behavioral injection-golden (a replay, not just the static posture test), worker crash/atomicity no-drop, `conversation_id`-on-every-creation-path, SC-2 golden targeting the **worker** prompt.
- **C2. Deploy data-plane** (ll5 CI: commit to main → CI builds changed packages → Coolify). Post-deploy monitor.
- **C3. Deploy the worker** — **GATED: get the user's explicit go.** Register `reconcile-loop.sh` in the ll5-run entrypoint/supervisor (alongside narrative-loop). ll5-run auto-deploy is flaky → CI, fallback `mcp__coolify__deploy` app `js8owk0g0cgog800ckc8ww0s`. Verify end-to-end with a real (or seeded) candidate; confirm the narrative loop cadence is unaffected.

**Deferred (do NOT build unless the user asks):** FR-8 self-tooling + the D7 sandbox-egress amendment — gated on DECISION-023 (sandbox stubbed). Keep it out of the persona so the agent can't hallucinate a sandbox it lacks.

## 4. Orchestration method

For each phase: turn each item into a scoped agent prompt (files + task + tests + "build & test LOCALLY, do not deploy"), fan out the independent ones in parallel, then synthesize + commit each tested piece. **Adversarially review the security-touching items** (A1 reads attacker text; A3 is user-facing) with an independent agent before trusting them — this project's whole discipline is *verify, don't assert*.

## 5. Hard constraints (non-negotiable — the lessons that cost us)

1. **Verify, don't guess.** Never write "done/tested/safe/idempotent" without having RUN the test. (A false "idempotent" claim shipped once — caught by review.)
2. **The reconcile worker is security-critical.** The **tool-surface lockdown is the boundary, not the prompt.** Keep `test_reconcile_security.py` green; never add Bash/Write/WebFetch/send/delete to its allowlist.
3. **Consequential closes are human-confirmed, never autonomous** (forgery defense — same-corpus verification can't tell truth from a plausible lie).
4. **Must NOT degrade the narrative loop:** no shared lock, `pgrep`-yield only, cheap/rare/short. The narrative script stays **untouched**. Ship the liveness + non-degradation regression checks in the SAME commit as the loop.
5. **"Deterministic" = coverage, not correctness.** Keep the honest scope; don't let `missed_close_count == 0` imply "no orphaned meaning."
6. **Local-first.** Build + test locally; **push/deploy only with the user's explicit go.** The worker's live deploy is the deliberate gated finale.
7. **No `claude-box`** (the separate second Claude Code — a different project). Use in-session subagents only.
8. **Tenant-scope everything** (`user_id`); this codebase has a recurring omission class — add a cross-tenant negative test for every new query/scheduler.
9. **Every `ll5` commit** must update `docs/PROGRESS.md` + `docs/HANDOFF.md` + `docs/FILE_TREE.md` (pre-commit hook enforces it).
10. **Commit messages** end with the Co-Authored-By + Claude-Session trailers (see recent commits).

## 6. Definition of done

All §7 tests green; data-plane deployed + verified; the worker deployed (with the user's go) and the **narrative loop's cadence provably unaffected**; the health-probe shows `missed_close_count` settling to 0 and no new "you guessed / I'll do it myself" corrections; and the **1-week checkpoint (2026-07-14)** re-evaluates the provisional FR-9 scope (option a) per DECISION-025's Review checkpoint section.

## 7. Ops quick-reference

- Box (read-mostly): `ssh root@95.216.23.208`. Agent container prefix `js8owk0g0cgog800ckc8ww0s`; narrative loop `docker exec <cid> tail ~/.ll5/narrative-loop.log`.
- ll5 data-plane deploy = push `main` → CI (`build-and-push.yml`) → Coolify. ll5-run deploy = push + `mcp__coolify__deploy js8owk0g0cgog800ckc8ww0s` (auto-deploy flaky).
- Local tests: gateway `cd packages/gateway && npx vitest run`; gtd similarly; ll5-run hooks `python3 .claude/hooks/tests/<t>.py`; worker security `python3 scripts/test_reconcile_security.py`.
