# DECISION-007 — Multi-tenancy via a BYO-agent platform (users bring their own LLM account)

Date: 2026-05-30
Status: Accepted (design); implementation phased — see `docs/design/byo-agent-tenant-platform.md`
Scope: tenant model, agent runtime, identity/auth

## Context

The data layer and proactive backend are already multi-tenant (every row `user_id`-scoped — DECISION-001/006; schedulers fan out over `auth_users`). The remaining single-tenant blocker is the **conversational agent runtime**: one Claude Code process, one token (admin `uid`), one workspace. `docs/design/user-management.md` Phase 6 deferred per-user agents as "Large" and floated a future "agent pool" built on the Claude Agent SDK — which would put LLM cost and scaling on LL5.

We want additional people to actually use LL5, each with their own agent, without LL5 absorbing LLM cost.

## Decision

**LL5 is the platform; each tenant brings their own LLM account.** LL5 provides data (MCPs), proactive backend, dashboard, and the agent persona/skills/runtime *shell*. Each tenant supplies a Claude credential (Pro/Max via `claude setup-token`, or an Anthropic API key). LL5 runs a **per-user Claude Code container** with that credential, connected to the LL5 MCPs scoped to the tenant's `user_id`.

Locked sub-decisions:
1. **Runtime = LL5-hosted per-user container shell + user's own Claude credential.** Not a shared per-message agent (breaks persistent session/memory); not self-host-only (breaks always-on proactivity for normal users). Self-host remains an optional escape hatch.
2. **Signup = invite-only** for v1 (email invite → email+password). No public self-serve yet.
3. **Tenant boundary = isolated individuals.** `families`/`family_members` stay out of the data path (optional org grouping only).
4. **Identity = email+password for humans + a separate revocable agent credential** for container→MCP auth. Username+PIN retained for phone quick-unlock.

## Alternatives considered

- **Agent pool on the Claude Agent SDK (LL5-funded LLM):** rejected — puts unbounded LLM cost and scaling on LL5; the BYO model removes that entirely.
- **Shared agent, per-message `user_id` switching:** rejected — defeats the persistent-session and per-user memory model the agent depends on.
- **Self-host-only:** rejected as the default — laptop users can't run an always-on agent, so proactivity (LL5's core value) would silently not work; kept as an opt-in.
- **Public self-serve signup now:** deferred — invite-only avoids abuse surface and lets provisioning/cost mature first.
- **Households with shared data (promote `families`):** deferred — adds a second scoping dimension; isolated individuals matches the scoping we just hardened.

## Consequences

- LL5 never pays for LLM tokens; cost is per-user container RAM/CPU on dedicated agent hosts (bounded, capped, scalable by adding hosts).
- LL5 now **stores users' Claude credentials** (encrypted, per-user, rotatable/revocable) — a new trust + security burden requiring a review before GA, and an **Anthropic ToS check** on running a subscription token in a hosted container (API-key path is unambiguous; subscription path may be self-host-only).
- New build is concentrated in the **agent connection plane** + **runtime orchestrator** (Docker-API control plane over a parameterized base image); everything beneath is reused.
- New identity surface: email/password, invites, reset/verify, an email sender, and agent-credential management.
- Implementation is phased (P1 identity/invite → P2 onboarding → P3 connection plane → P4 orchestration → P5 lifecycle/ops); the existing admin agent keeps working and becomes "tenant 0" under the orchestrator once P4 lands.
