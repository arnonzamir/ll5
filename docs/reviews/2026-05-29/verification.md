# Synthetic-tenant cross-tenant verification

Empirical verification that tenant isolation holds on the deployed system, using two synthetic tenants (A and B) seeded directly into production Elasticsearch and probed through the gateway HTTP API with per-tenant signed tokens.

> Status: harness + results filled in during the 2026-05-29 deploy run (see below). Code-level "before" (pre-fix leak) is already proven by the RED test logs in this directory; this doc adds the end-to-end "after" proof on the deployed code.

## Method

- Two synthetic tenant UUIDs (no real user data touched). Tokens minted with `AUTH_SECRET` via the same `@ll5/shared` signing path the app uses.
- Seed: index one `ll5_agent_journal` doc and one `ll5_session_history` doc owned by tenant A (via SSH → ES, since ES is internal-only).
- Probe with tenant B's token against gateway: `GET /journal`, `GET /sessions/:id` (A's id), `PATCH /journal/:id` (A's id).
- Expected on fixed code: B sees none of A's data — empty list / `404` — and a `cross_user_access_denied` log line is emitted.
- Cleanup: delete the seeded docs by id; no `auth_users` rows are created.

## Results

_(populated by the run)_
