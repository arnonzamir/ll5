# LL5 BYO-Agent Tenant Platform — Design

Status: **Draft for review** (2026-05-30)
Supersedes: `docs/design/user-management.md` Phase 6 ("Channel MCP Per-User Agent", deferred).
Related decisions: [DECISION-001](../decisions/DECISION-001-tenant-scoped-by-id-access.md) (scoping), [DECISION-006](../decisions/DECISION-006-deterministic-doc-ids-embed-user-id.md) (doc ids), [DECISION-007](../decisions/DECISION-007-byo-agent-multi-tenant-platform.md) (this model).

## 1. The model

**LL5 is the platform; each tenant brings their own LLM account.** LL5 provides the data layer (6 MCPs), the proactive backend (schedulers), the dashboard, and the agent *persona/skills/runtime shell*. The user supplies their own Claude credential (a Claude Pro/Max subscription via `claude setup-token`, or an Anthropic API key). LL5 hosts a **per-user Claude Code container** that runs with the user's credential and connects to the LL5 MCPs scoped to that user's `user_id`.

This dissolves the "agent pool" cost problem: LL5 never pays for LLM tokens. It pays only for the per-user container shell (RAM/CPU), and owns the persona/skills so every tenant gets the same evolving LL5 experience.

### Locked decisions (2026-05-30)
- **Runtime:** LL5-hosted per-user agent container; user provides the Claude credential. (Not self-host; not a shared per-message agent.)
- **Signup:** Invite-only for v1 (admin or, later, an existing user invites by email). No public signup yet.
- **Tenant boundary:** Isolated individuals — each `user_id` is a fully separate tenant. The `families`/`family_members` tables stay **out of the data path** (optional org grouping only).
- **Identity:** Email + password for humans (enables invite, verification, reset); a separate revocable **agent credential** for the container→MCP auth. Username+PIN retained as an optional phone quick-unlock.

### Review outcome (2026-05-30, approved)
- **Claude credential:** the backend supports **both** kinds (`agent_llm_credentials.kind ∈ {api_key, oauth_setup_token}`), but the **UI collects only an Anthropic API key** for now. This sidesteps the ToS question (API key is unambiguous) while keeping the schema/runtime forward-compatible for subscription tokens if policy allows later. The `oauth_setup_token` path is dormant (no UI), not removed.
- **Email:** a pluggable `EmailSender` interface; default impl is provider-agnostic **SMTP** (works with Postmark/SES/any SMTP via env). If unconfigured, invites/reset **log the link** (dev fallback) and surface a clear "email not configured" state rather than failing silently.
- **Inviter scope:** **admin-only** invites for v1.
- **Agent hosts:** provision agent containers on a **dedicated agent host/pool**, network-isolated from the data plane (confirmed direction; a P4 concern).

## 2. What already exists (reuse — this is why it's reachable)

| Capability | State | Source |
|---|---|---|
| Per-row `user_id` data isolation | ✅ Done + hardened | DECISION-001/006, `docs/reviews/2026-05-29/` |
| MCP per-request `getUserId()` via AsyncLocalStorage | ✅ Done | user-management.md Phase 4 |
| Multi-user schedulers (fan-out over `auth_users WHERE enabled`, 5-min reconcile) | ✅ Done | `scheduler/index.ts` |
| FCM push + WhatsApp routing keyed per `user_id` | ✅ Done | `fcm-sender.ts`, `whatsapp-user-resolver.ts` |
| Admin user CRUD + soft-disable | ✅ Done | `gateway/admin.ts` |
| Onboarding wizard skeleton (name/tz/Google) | ✅ Partial | `dashboard/(user)/onboarding` |
| Per-user encrypted secrets (AES-256-GCM) | ✅ Pattern exists | google OAuth tokens, health creds |
| Agent container internals (supervisor loop, mcp-autoheal, channel MCP, `~/.ll5/token`) | ✅ Exists (single-tenant) | `ll5-run` repo, HANDOFF.md |
| `ll5.` token + `/auth/refresh` (per-user TTL, 7-day grace, auto-refresh) | ✅ Done | `auth.ts`, `shared/auth/token.ts` |

**The only genuinely new build is the agent connection + runtime-orchestration plane** (sections 4–5). Everything below it is in place.

## 3. Identity & access changes

### 3.1 Schema (gateway PG)
```sql
-- auth_users: add human-login identity
ALTER TABLE auth_users ADD COLUMN email           CITEXT UNIQUE;       -- primary login id
ALTER TABLE auth_users ADD COLUMN password_hash    TEXT;               -- bcrypt(12); nullable until set
ALTER TABLE auth_users ADD COLUMN email_verified   BOOLEAN NOT NULL DEFAULT false;
-- username + pin_hash stay (optional phone quick-unlock)

-- invites (invite-only signup)
CREATE TABLE invites (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email        CITEXT NOT NULL,
  token_hash   TEXT NOT NULL,                 -- sha256 of the emailed token
  invited_by   UUID NOT NULL,                 -- auth_users.user_id
  role         TEXT NOT NULL DEFAULT 'user',
  expires_at   TIMESTAMPTZ NOT NULL,
  accepted_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- password reset / email verification (one table, typed)
CREATE TABLE auth_tokens (
  token_hash   TEXT PRIMARY KEY,             -- sha256
  user_id      UUID NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('password_reset','email_verify')),
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ
);

-- agent credential: the long-lived, revocable token the container uses for MCP auth
CREATE TABLE agent_credentials (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL,
  name         TEXT NOT NULL DEFAULT 'agent',
  token_hash   TEXT NOT NULL,                -- sha256 of the issued ll5 agent token
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- the user's BYO Claude credential, encrypted at rest
CREATE TABLE agent_llm_credentials (
  user_id      UUID PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('oauth_setup_token','api_key')),
  ciphertext   TEXT NOT NULL,                -- AES-256-GCM, same ENCRYPTION_KEY pattern as google/health
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- per-user agent runtime state (orchestrator-owned)
CREATE TABLE agent_runtimes (
  user_id      UUID PRIMARY KEY,
  container_id TEXT,
  host         TEXT,                          -- which agent host runs it
  status       TEXT NOT NULL DEFAULT 'none'   -- none|provisioning|running|stopped|error
                 CHECK (status IN ('none','provisioning','running','stopped','error')),
  last_seen_at TIMESTAMPTZ,                   -- channel-MCP heartbeat
  last_error   TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 3.2 Auth flows
- **Login:** email+password (bcrypt) → existing `ll5.` session token (7-day TTL, refresh). Username+PIN path kept for the phone.
- **Invite → signup:** `POST /invites` (admin/inviter) emails a link `…/accept?token=…` → invitee sets password → `auth_users` row created with `email_verified=true`, `enabled=true` → schedulers pick them up within 5 min.
- **Password reset / email verify:** `auth_tokens` rows, emailed links, single-use, expiring.
- **Agent credential:** minted on the "Connect your agent" step — a long-TTL (e.g. 90-day) `ll5.` token bound to the user's `uid`, tracked in `agent_credentials` (hash only) so it is **listable + revocable** in the dashboard. The container auto-refreshes it (channel MCP already does). Revoke → orchestrator stops the container.
- **Email sender:** new platform dependency (SMTP/Postmark/SES) for invites, verification, reset. Config via env; fail-closed if unset (invites just can't be sent).

## 4. Agent connection plane (the kit a container needs to act as a tenant)

A per-user container becomes "tenant X's agent" from four inputs, all generated server-side:

1. **Agent token** → written to `~/.ll5/token` (auto-refreshing). Carries `uid=X`; every MCP call is `getUserId()`-scoped to X (already enforced + verified).
2. **`.mcp.json`** → the 6 MCP HTTPS endpoints (`mcp-*.noninoni.click`) + the channel MCP, all using that token. Generated by the gateway (`GET /agent/mcp-config`, admin/self only).
3. **Workspace** → the `ll5-run` persona (`CLAUDE.md`), skills, hooks — baked into the base image (section 5), not per-user.
4. **Claude credential** → the user's `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or `ANTHROPIC_API_KEY`, decrypted from `agent_llm_credentials` and injected at launch (env, never logged).

Dashboard surface: **`/settings/agent`** ("Your Agent") — shows runtime status (from `agent_runtimes`), the agent credential (issue/rotate/revoke), and the Claude-credential connect/replace control.

## 5. Agent runtime orchestration (the new core build)

### 5.1 Base image
Generalize the existing `ll5-agent` image (from `ll5-run`) to be **parameterized by env**, not baked to one user:
- `LL5_USER_ID`, `LL5_AGENT_TOKEN` → writes `~/.ll5/token` + renders `.mcp.json`.
- `CLAUDE_CODE_OAUTH_TOKEN` **or** `ANTHROPIC_API_KEY` → the user's Claude credential.
- Keeps the existing supervisor loop + `mcp-autoheal-server.sh` + channel MCP bridge.
- Persona/skills/hooks are in the image; updates ship as image rebuilds (existing `ll5-run` CI).

### 5.2 Orchestrator service (`packages/agent-orchestrator`, new)
A small control plane that owns `agent_runtimes` and drives container lifecycle on one or more **dedicated agent hosts** via the Docker Engine API (not Coolify per-app — avoids app sprawl and the known Coolify volume/network landmines):

- `provision(userId)` → mint/inject creds → `docker run` base image with per-user env + a small named volume for `~/.ll5` and Claude session state → record container_id/host/status.
- `stop/restart/status(userId)`; `deprovision(userId)` → stop + remove + revoke agent credential.
- **Health:** the channel MCP heartbeats to the gateway; orchestrator reconciles `agent_runtimes.status`/`last_seen_at` and restarts crashed containers (mirrors the existing supervisor + autoheal philosophy, lifted to N tenants).
- **Placement:** simple bin-packing across agent hosts with a per-host container cap (section 7). Runs with Docker socket access on the agent host — **kept off the data-plane hosts** (security, section 7).
- Triggered by: the onboarding "connect agent" step, admin actions, and user enable/disable.

### 5.3 Why a service, not Coolify-per-user
Per-user Coolify apps would multiply deploy objects and hit the documented Coolify quirks (network strip on compose-up, `custom_docker_run_options` stripping `-v`, no storage REST API). A thin orchestrator over the Docker API is the same primitive the current `ll5-agent`/`claude-box`/`sess` setup already uses, generalized.

## 6. Onboarding — one guided flow (invite → working agent)

1. **Invite** (admin/inviter enters email) → email link.
2. **Accept** → set email + password + display name.
3. **Wizard** (single flow; folds today's scattered settings):
   a. Profile — name, timezone, work-week, `self_names`.
   b. Notifications — levels + quiet hours.
   c. Google — OAuth connect (existing popup flow).
   d. Channels — WhatsApp QR pair; Health (Garmin) connect; (Telegram later).
   e. Phone — install Android app, log in; **live "phone linked ✓"** when FCM register lands.
   f. **Connect your agent** — choose Claude Pro/Max (`claude setup-token`, guided) or API key → stored encrypted → orchestrator provisions the container → **live "agent connected ✓"** when the channel heartbeat arrives → the agent posts a greeting in the chat thread.
4. **Done.** `/settings/agent` shows ongoing status; `onboarding.completed=true`.

Each step writes `user_settings.onboarding.steps.*` so the flow is resumable. Nothing blocks an un-onboarded user, but the dashboard nudges remaining steps.

## 7. Risks, security, and limits (design these, don't discover them)

- **We now hold users' Claude credentials.** Trust + liability. Encrypt at rest (AES-256-GCM, per-user), decrypt only at container launch, never log, isolate per-container, allow rotate/revoke, and **prefer the API-key path** for users who don't want to hand over a subscription token. → security review before GA.
- **Anthropic ToS check (blocking question):** confirm that running a user's Claude **subscription** credential inside an LL5-hosted container is permitted. The **API-key** path is unambiguous; the `setup-token`/subscription path needs verification and may have to be self-host-only. **Must resolve before P4 ships.**
- **Resource ceiling:** N idle Claude Code containers consume RAM and hold MCP SSE connections; the shared host's disk IOPS is already the known bottleneck (incident memory). State a per-host container cap and a "needs another agent host at N tenants" line; the orchestrator enforces it.
- **Docker-socket privilege:** the orchestrator is privileged; run it only on dedicated agent hosts, network-isolated from the data plane.
- **Persona/skill rollout:** updates = base-image rebuild + rolling restart of N containers (orchestrator-driven, anti-flap).
- **Email deliverability:** invites/reset depend on a real sender; pick a provider and SPF/DKIM early.

## 8. Phased plan (to "actually work")

| Phase | Scope | Breaks existing? |
|---|---|---|
| **P1 — Identity & invite** | email/password, `invites`, `auth_tokens`, reset+verify, email sender, login update. Humans can be invited and sign in. | No |
| **P2 — Unified onboarding** | fold all setup into one wizard + phone-link live verification. | No |
| **P3 — Connection plane** | `agent_credentials`, `.mcp.json` generator, `/settings/agent`, Claude-credential capture + encryption (`agent_llm_credentials`). A user can connect a *self-run* Claude Code immediately (validates the plane before orchestration). | No |
| **P4 — Runtime orchestration** | base-image parameterization, `agent-orchestrator` service + Docker API, provision/stop/health, dashboard agent status. **The core new build.** Gated on the ToS check. | No |
| **P5 — Lifecycle & ops** | disable→teardown+revoke, persona rollout, resource caps + scaling, `/admin` agent observability, security review. | No |

Each phase is independently shippable; the existing single admin agent keeps working throughout (it becomes "tenant 0" under the same orchestrator once P4 lands).

## 9. Open questions for review
1. **ToS:** OK to run a user's Claude *subscription* token in our container, or API-key-only for hosted (subscription → self-host)? (Blocks P4 shape.)
2. **Agent hosts:** dedicate a box (or small pool) for agent containers, separate from the data-plane Coolify host? (Recommended.)
3. **Inviter scope:** admin-only invites for v1, or can any user invite (with a cap)?
4. **Email provider** preference (Postmark/SES/SMTP)?
5. **Self-host escape hatch** in P3 (publish the connection kit so power users can run their own always-on Claude Code) — include now or later?
