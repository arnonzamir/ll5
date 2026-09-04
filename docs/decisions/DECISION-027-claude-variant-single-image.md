# DECISION-027 — One production image for the Claude variant, built by ll5

**Date:** 2026-09-04
**Status:** accepted
**Related:** ISS-007, ISS-013, ISS-023 (`docs/ISSUES.md`); DECISION-015 (narrative loop), the 2026-07-10 variant→ll5 auto-deploy entry in PROGRESS.

## Context

The Claude Code agent variant had two images and two pipelines, and the one that
shipped was not the one that ran:

| | `ghcr.io/arnonzamir/ll5-agent` | `ghcr.io/arnonzamir/ll5-run-claude` |
|---|---|---|
| Built by | `ll5-run-claude-code` repo CI, its own `Dockerfile` (CLI pinned 2.1.204) | **ll5** CI, `docker/Dockerfile.ll5-run-claude` (`npm install -g @anthropic-ai/claude-code`, **unpinned**) |
| Content | agent repo only | `packages/ll5-run-shared/` (CLAUDE.md, skills, prompts) from ll5 + a checkout of the agent repo |
| Deployed to | Coolify app `js8owk0g…` — a zombie (`exited:unhealthy`, `restart_count 20026`) | the orchestrator's per-user containers `ll5-agent-<uid>` — **the live agent** |
| Rebuilt on | every agent-repo push | `workflow_dispatch` (last 2026-07-19) or the weekly schedule |

Consequences observed in the 2026-09-04 review:

- The live container ran CLI **2.1.197** (whatever npm served on 2026-07-15) while every document said 2.1.204 (ISS-007).
- The weekly schedule failed **7 of 7** runs from 2026-07-20: `build (run-opencode)` 403s pushing a package the opencode repo owns, and matrix fail-fast **cancelled `build (run-claude)`** — so the live image silently never refreshed.
- Pushes to the agent repo (last 2026-07-14) built an image nobody ran and called Coolify on a dead app. The `TS_AUTHKEY` rotation that looked like the blocker only served that dead path.
- `docker compose up` never touches per-user containers; even a good build did not reach a running agent without an explicit re-provision.
- The shared prompt content (`packages/ll5-run-shared/CLAUDE.md`) was a month newer locally than what was deployed.

purpose.md's "Build Once, Deploy Anywhere" was violated in practice: a fix could not be shipped even if written.

## Decision

1. **`ll5-run-claude`, built by ll5 from `docker/Dockerfile.ll5-run-claude`, is the only production image for the Claude variant.** ll5 owns the GHCR package, so its token can push it. The Dockerfile now pins the CLI (`ARG CLAUDE_CODE_VERSION`, default 2.1.204, overridable by the repo var `CLAUDE_CODE_VERSION`), exports it as `ENV`, and fails the build if `claude --version` disagrees. Locale (`en_US.UTF-8`) and `openpyxl` were ported from the retired Dockerfile.
2. **The agent repo is a trigger, not a builder.** Its `build-and-push.yml` (build `ll5-agent` + Coolify deploy) and its `Dockerfile` are removed. A `trigger-ll5-rebuild.yml` fires `repository_dispatch(rebuild-agent, package=run-claude)` at ll5 on every push to main (secret `LL5_DISPATCH_PAT`, same as the opencode repo).
3. **ll5 builds `run-claude` on that dispatch** (previously every dispatch was deploy-only), **and only `run-claude` on the weekly schedule** (the opencode 403 no longer cancels it).
4. **Deploy rolls the running agents.** After `docker compose up`, when the run just rebuilt `run-claude`, the deploy job calls the orchestrator's new `POST /runtimes/reprovision-running` (bearer `ORCHESTRATOR_SECRET`), which re-provisions every `running` row — `provision()` force-pulls and force-removes by name, so the new image lands. MCP-only deploys leave agents alone.
5. **The entrypoint asserts the CLI version at boot** against the baked `CLAUDE_CODE_VERSION`; a mismatch raises a `critical` alert through the gateway alert spine (`POST /alerts`) and marks `~/.ll5/version-mismatch` — loud, not a crash loop.
6. **The zombie is retired:** Coolify app `js8owk0g…` deleted (volumes kept until confirmed unused); the `ll5-agent` GHCR package is to be deleted by an owner token.
7. **Bundled:** ISS-023 — a push touching no package now builds nothing and skips deploy.

## Alternatives considered

- **Make the agent repo the builder of `ll5-run-claude`.** Rejected: it would need the shared content from ll5 at build time (a cross-repo checkout in the other direction) and a GHCR package handover; the ll5 side already has both the content and the package.
- **Keep both images and just fix the pin in both Dockerfiles.** Rejected: two Dockerfiles for one runtime is the drift that produced ISS-007; the second image had no consumer.
- **Crash the container on a version mismatch.** Rejected: a restart loop is loud but self-harming; the alert spine already exists for exactly this.
- **Roll agents from the orchestrator's stale-heartbeat reconcile.** Rejected: it only fires when a heartbeat is missed and has a restart cooldown; an image roll must be explicit and immediate.

## Consequences

- One green dispatch now reaches the live agent: push to the agent repo → ll5 builds `run-claude` (pinned, verified) → deploy → re-provision → entrypoint asserts. Phase 1's agent-side queue (ISS-014 hook, ISS-001, ISS-006) is unblocked.
- A re-provision restarts the agent's session (`--continue` on relaunch keeps the transcript). That is the same cost as any deploy today, and the planned daily restart (ISS-016) makes it routine.
- The agent repo can no longer be built standalone; local runs use the ll5 Dockerfile with a checkout in `variant-content/`.
- The CLI bump for the runtime upgrade (plan Phase 5) is now one repo var or one Dockerfile default — visible, reviewable, verified inside the image.
- `TS_AUTHKEY` and `COOLIFY_API_TOKEN` on the agent repo are unused after this and can be deleted.
- Follow-up, not in this change: the ll5 image runs as root; the retired Dockerfile ran as `node`. Revisit when the runtime upgrade lands.
