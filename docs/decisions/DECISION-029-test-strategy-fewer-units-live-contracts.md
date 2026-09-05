# DECISION-029 — Test strategy: fewer unit tests, live contract tests, gated CI

**Date:** 2026-09-05 · **Status:** accepted (Arnon, same day) · **Trigger:** ISS-027 + ISS-028

## Context

On 2026-09-05 three defects reached production on the same day and none of the 1,730 unit tests could have caught any of them:

1. **ISS-028a** — messaging `read_messages` returned `[]` for every WhatsApp conversation: `EvolutionClient.fetchMessages` treated Evolution v2's `{ messages: { total, pages, records } }` envelope as an array. The 89 messaging unit tests passed — they mock Evolution's reply *in the shape the code assumed*, so they encode the bug.
2. **ISS-027** — a Claude Code upgrade (2.1.204 → 2.1.260) moved a startup picker's default; the launcher's blind `Down Enter` chose "Exit" on every relaunch and the container looped for 3h40m. A TUI default of an upgraded binary is untestable in a unit test.
3. **ISS-028b** — the messaging service had no `ELASTICSEARCH_URL` in compose; `initAudit('')` silently disabled audit rows for months. Deployment configuration is outside every unit test's reach.

Meanwhile **no test ran in CI at all** — `build-and-push.yml` had no test step — so the unit tests cost maintenance and gave confidence without gating anything. Inventory by file showed ~40% of them assert calls on mocks (`awareness/tools-extra` 56 tests / 79 mocks, `messaging/tools` 30/73, `google/tools` 31/75, `gateway/admin` 37/30, `send-gate` 9/51 …), ~35% test pure logic or query builders with 0–4 mocks, the rest are "review-batch" bundles and incident regressions.

## Decision

1. **Purge mock-assertion tests.** Delete any test file that is a `review-batch-*` bundle, or has mocks ≥ 0.6 × tests, or ≥ 8 mocks — unless it exists as a named guard (references `ISS-`/`DECISION-`/incident/regression and is small or a cap/scoping/tenancy/liveness/visibility test). Four kept on judgment: `anomaly-monitor` (policy math), `whatsapp-webhook` (DECISION-024 ingest), `narrative-repository` (freshness policy), `agent.test` (runtime API). Result: **1,730 → 1,057 tests, 55 files removed** (the stale `contact-settings-tools` mock-queue file included). All remaining suites pass.
2. **Add a live, read-only contract layer** — `packages/e2e/src/mcp-contracts.test.ts`: for each MCP in `mcp-endpoints.json`, `tools/list` plus one real read asserting the response shape the agent relies on (`read_journal`, `list_narratives`, `list_actions`, `list_events`, `list_conversations` → `read_messages` on a real conversation — the ISS-028 guard). Runs after every deploy with `LL5_E2E_TOKEN` (an agent token); skips with a warning when the secret is absent.
3. **Compose lint** — `packages/e2e/src/compose-lint.mjs`: every `ll5-<pkg>` service must set each of `ELASTICSEARCH_URL`, `DATABASE_URL`, `AUTH_SECRET`, `ENCRYPTION_KEY` that `packages/<pkg>/src` reads (directly or via `initAudit`/`initAppLog`). Runs before any build.
4. **Agent smoke in the deploy job** — after a run-claude roll: the fresh boot must reach the chat input within 5 min, then a forced fresh relaunch (`touch ~/.ll5/fresh-session; pkill claude`) must come back — the exact ISS-027 path. Failure fails the deploy job (a red run; the liveness alert fires independently).
5. **CI gating** — new `unit-tests` job (all packages, sequential, + compose lint) that `build` and `deploy` require; `e2e` job after `deploy`.

## Alternatives considered

- **Keep all unit tests, add e2e on top.** Rejected: the mock-assertion tests are negative value — they pass while the real dependency's shape is wrong, and they must be edited on every refactor.
- **Ephemeral compose stack in CI for e2e.** Rejected for now: Evolution/WhatsApp cannot be real there, so it would not have caught ISS-028; large CI cost. May return for write-path tests.
- **Non-blocking CI.** Rejected: a test that cannot block is a dashboard nobody reads.

## Consequences

- A red `unit-tests` or compose-lint blocks the build; a red agent smoke fails the deploy run; a red `e2e` is the post-deploy alarm.
- One extra cold start of the agent per run-claude deploy (the forced relaunch), ~$1.
- `LL5_E2E_TOKEN` must exist as a repo secret (an agent token; rotate with the agent's).
- Tests deleted here are recoverable from git (`git log --diff-filter=D --name-only`).
- Not covered yet: ES index-mapping drift (the ISS-012 class) and nightly KPI thresholds — the 03:12 checkpoint runbook covers them by hand; candidates for a cron job later.
