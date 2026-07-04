# DECISION-022 — Credential vault + server-side browser login (agent uses passwords it never sees)

Status: accepted — 2026-07-04

## Context

The agent needs authenticated browsing (school portals, deliveries, utilities) —
"easy access to browsers and a vault for the user's passwords." The browser layer
exists (DECISION-010: Playwright MCP container, persistent profile, basicAuth).
The missing piece is credentials — and the dominant risk is not storage but
**exposure paths**: everything the model sees lands in transcripts, session
history, the tool ledger, and eval logs, all indexed into ES. A password that
enters model context is a password copied into half a dozen stores. The second
risk is **prompt injection**: a browsing agent with credential access can be
steered by page content into filling secrets on the wrong site.

## Decision

1. **Vault = self-hosted Vaultwarden** (own Coolify service, `vault.noninoni.click`).
   Real client apps for the user to manage entries; E2E encryption (server never
   holds plaintext); TOTP seeds supported (phase 2). **Scoping by collection**: an
   `LL5` organization collection holds ONLY what the agent may use; the user's
   personal vault never touches the system. A dedicated **machine account**
   (its own master password held as a service secret, never in the repo or agent
   env) is a member of that collection alone.

2. **The agent never sees a secret — server-side injection.** New `vault` MCP
   (packages/vault) whose container runs the official `bw serve` (Bitwarden Vault
   Management API) as a localhost sidecar, unlocked with the machine account.
   Tools:
   - `list_login_sites()` — item names + bound domains only, never secrets;
   - `browser_login({site})` — connects to the SAME live browser the agent uses
     (shared CDP endpoint, below), navigates to the entry's bound URL, fills the
     credential fetched from `bw serve`, submits, and returns success/fail only.
   The secret's entire lifecycle is inside the vault container.

3. **Shared browser via CDP.** The browser container now launches headless
   Chromium with an internal-only CDP port and runs Playwright MCP with
   `--cdp-endpoint` against it; the vault MCP connects to the same CDP endpoint
   (internal Docker network, never exposed via Traefik). One live browser + one
   persistent profile: after `browser_login`, the agent's own browsing tools are
   inside the authenticated session.

4. **Two hard safety rules in `browser_login`:**
   - **Domain binding** — a credential fills ONLY on the exact registrable domain
     of its vault entry's URL. Page content can never redirect a fill elsewhere;
     phishing/prompt-injection becomes structurally ineffective.
   - **Site allowlist with user approval** — `user_settings.vault.approved_sites`;
     a login on an unapproved site is refused and generates an approval request
     (alert-level push). Only user-authenticated surfaces (dashboard/phone) can
     approve — same authority model as `permission_change_requests` (agent can
     ask, never grant).

5. **Redaction discipline:** the vault MCP's tool results and app-log/telemetry
   entries never include credential material or vault item content; `args_summary`
   for its tools is name-only.

6. **Session persistence stays the cheap 80%:** one-time assisted logins persist
   in the shared profile; the vault path is for expired sessions and
   credentialed flows. **Out of scope permanently:** payments/bank transactions
   (human-only); passkey-only sites (assisted login).

## Alternatives considered

- **Homegrown vault** (PG + AES-GCM like agent_llm_credentials): no client apps,
  we own key management for the crown jewels. Rejected.
- **"get_password" tool** returning secrets to the agent: every transcript/index
  becomes a credential store; unacceptable. Rejected — injection only.
- **Second browser profile for the vault MCP**: avoids CDP rework but logins
  wouldn't benefit the agent's browsing session — defeats the purpose. Rejected.
- **Bitwarden cloud** instead of Vaultwarden: fine too, but self-hosting keeps
  vault data on the box with everything else; user can migrate later — the MCP
  speaks the same API either way.

## Consequences

- New surface: Vaultwarden service, vault MCP (+ bw sidecar), browser-container
  launch change (CDP mode), allowlist knob + approval push, persona note.
- User onboarding required: accept the org invite, set a master password, move
  chosen credentials into the LL5 collection (that act IS the permission grant,
  item by item).
- The browser container change must be verified carefully — DECISION-010's
  working setup is in production (basicAuth + allowed-hosts stay unchanged).
- Prompt-injection residual risk drops to "agent browses somewhere bad while
  already logged in" — mitigated by existing --blocked-origins and by the
  allowlist keeping the credentialed surface small.

## Tenant scoping (2026-07-04 addendum)

The initial implementation was single-tenant (one hardcoded "LL5" org resolved
by name; operator provisioned via bootstrap script + bw CLI) — violating
principle #3 (multi-tenancy from day one). Amended as follows:

1. **One Vaultwarden Organization per tenant** — named `LL5 <first-8-of-userId>`
   with one `agent` collection each. The single machine account creates every
   tenant org and stays Owner of all of them (that's how the one bw sidecar can
   serve every tenant); each tenant's human is Owner of their own org only.
   Cross-tenant isolation therefore does NOT come from Bitwarden membership —
   it comes from the mapping below.

2. **userId→org mapping lives in gateway PG** (`vault_tenants`, migration 035:
   user_id pk, org_id, collection_id, status provisioning|invited|active) —
   MCPs stay stateless. The vault MCP reads it via GET /vault/tenant (self-
   scoped, token-authed) before EVERY bw query and REFUSES when unmapped
   ("vault not provisioned for this user"). All bw list/get calls carry
   `organizationId` (+ collectionId) filters, and every returned item's org id
   is asserted against the caller's org before use — `list_login_sites` /
   `browser_login` cannot return another tenant's items by construction.
   Mapping WRITES (PUT /vault/tenant) require a `service`-role token that only
   AUTH_SECRET holders (the vault MCP) can mint — an agent token can never
   remap its row onto another tenant's org. The pre-tenancy admin org is
   seeded by the migration so the existing setup keeps working.

3. **Provisioning is agent-driven, self-scoped** (revised from dashboard-only):
   the lifecycle ships as vault MCP tools — `provision_vault({user_email})`
   (idempotent: org + collection + Owner-invite email via SMTP, registers the
   mapping), `confirm_vault_membership()` (owner-confirm after the user
   accepts the emailed invite), `vault_status()`. Safe as agent tools because
   they only ever act on the CALLER's tenant (userId from the auth token,
   never an argument) and touch no credential material. The onboarding UX is
   the agent walking its user through the flow in chat (persona section in
   ll5-run/CLAUDE.md). What stays user-authority is unchanged: site approval
   (agent files requests; only user surfaces grant) and the credentials
   themselves (entered in the user's own vault UI, never in chat).
   Implementation: scripts/bootstrap.ts's client-side Bitwarden KDF/org/invite
   code became the src/provision.ts library (TenantProvisioner; needs
   BW_EMAIL + BW_PASSWORD); src/tenancy.ts is the one lifecycle service behind
   both the tools and the vault MCP's internal HTTP routes.

4. **Gateway /me/vault/* routes** (chatAuth, same shape as /me/agent/*) are the
   dashboard's future contract, proxying the vault MCP's /internal/tenant/*
   surface (service-to-service, token-authed, NOT MCP tools):
   POST /me/vault/provision, POST /me/vault/confirm, GET /me/vault/status →
   {status, org_id, sites_count, approved_sites}. No dashboard page yet.
