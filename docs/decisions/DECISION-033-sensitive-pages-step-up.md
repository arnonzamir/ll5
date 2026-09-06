# DECISION-033 — Sensitive pages require identity re-validation

**Date:** 2026-09-06 · **Status:** accepted (Arnon: "This (and possibly other pages too) should be cataloged as sensitive data and require identity validation") · **Follows:** DECISION-032

## Context

The connectors framework brings financial and medical data into the dashboard: ledgers, balances, card events, HMO appointments, and the credentials page for the licensed aggregator. A 30-day session cookie is right for chat and lists; it is the wrong bar for a page that shows every card transaction or accepts an API secret. The same laptop left open, or a token that survives a phone loss, should not expose those pages without the person proving presence again.

## Decision

1. **A catalog of sensitive paths** in the dashboard (`src/lib/sensitive.ts`, `SENSITIVE_PATHS`, prefix match). Initial members: `/finance` and `/settings/connectors`. Adding a page is one line there plus `requireStepUp()` in its server actions.
2. **Step-up by password re-validation.** Visiting a sensitive path without a valid step-up cookie redirects to `/verify?next=…`; the form re-checks the password against the gateway's `POST /auth/token` (the session cookie is not replaced). Success sets `ll5_stepup`: `exp.sig`, `sig = HMAC-SHA256(AUTH_SECRET, userId:exp)`, 15 minutes, httpOnly, sameSite lax. The middleware enforces it at the edge; every server action behind a sensitive page enforces it again, so a direct action call cannot bypass the page.
3. **Scope is the page and its actions, not the API.** The MCPs keep their bearer auth; the step-up is a dashboard-side presence check.
4. **Finance page** (`/finance`) is the first sensitive page: read-only views over the connectors MCP (ledger with filters and pagination, period summary, events, findings) and two writes (mark merchant known, resolve finding, plus sync now). No payment or transfer action exists anywhere.

## Alternatives considered

- **Shorter session everywhere.** Punishes the daily chat use for the benefit of two pages.
- **WebAuthn / passkeys.** Better presence proof; more moving parts (registration flow, device management). The step-up helper is the seam where a passkey check replaces the password later without touching the pages.
- **TOTP.** Adds a second secret to manage for a single user; the password re-check already proves presence against the same credential the session came from.

## Consequences

- The Android app has no finance screen yet; when it gets one it needs an equivalent gate (biometric prompt) before this data is shown there.
- `AUTH_SECRET` is now load-bearing for the dashboard as well as the gateway; rotating it invalidates step-ups (harmless) but must stay in sync in compose.
- Verification: opening `/finance` in a fresh session redirects to `/verify`; a wrong password stays on `/verify`; a correct one lands on `/finance`; after 15 minutes the redirect returns; calling a finance server action without the cookie is refused.
