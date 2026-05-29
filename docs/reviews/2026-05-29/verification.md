# Synthetic-tenant cross-tenant verification

Empirical verification that tenant isolation holds on the deployed system, using two synthetic tenants (A and B) seeded directly into production Elasticsearch and probed through the gateway HTTP API with per-tenant signed tokens.

> Status: harness + results filled in during the 2026-05-29 deploy run (see below). Code-level "before" (pre-fix leak) is already proven by the RED test logs in this directory; this doc adds the end-to-end "after" proof on the deployed code.

## Method

- Two synthetic tenant UUIDs (no real user data touched). Tokens minted with `AUTH_SECRET` via the same `@ll5/shared` signing path the app uses.
- Seed: index one `ll5_agent_journal` doc and one `ll5_session_history` doc owned by tenant A (via SSH → ES, since ES is internal-only).
- Probe with tenant B's token against gateway: `GET /journal`, `GET /sessions/:id` (A's id), `PATCH /journal/:id` (A's id).
- Expected on fixed code: B sees none of A's data — empty list / `404` — and a `cross_user_access_denied` log line is emitted.
- Cleanup: delete the seeded docs by id; no `auth_users` rows are created.

## Results (2026-05-29 PM, against deployed fixed code)

Synthetic tenants: A `11111111-…-aaaaaaaaaaaa` (owner), B `22222222-…-bbbbbbbbbbbb` (attacker). Two docs seeded for A (`ll5_agent_journal`, `ll5_session_history`), tokens minted with `AUTH_SECRET`.

| Probe (as tenant B) | Result | Verdict |
|---------------------|--------|---------|
| `GET /journal?status=open` | `{"entries":[],"total":0}` | ISOLATED (A's `SYNTH_A_PRIVATE_JOURNAL_SECRET` not leaked) |
| `GET /sessions/<A's id>` | `HTTP 404 {"error":"Session not found"}` | ISOLATED |
| `PATCH /journal/<A's id>` (status=resolved) | `HTTP 404 {"error":"Not found"}` | ISOLATED (ownership check fired) |
| A's journal entry status after B's PATCH | still `open` | no cross-tenant write |
| Sanity: `GET /journal` as tenant A | returns A's own entry | endpoint + token minting verified working |

Tenant A's data demonstrably **exists** in ES (A reads it) yet tenant B is blocked on read, read-by-id, and write-by-id. Synthetic docs deleted afterward (`found:false` confirmed). The pre-fix leak is evidenced separately by the RED test logs (`*-RED.log`).

## Data repairs applied to prod (dry-run shown, then applied)

| Repair | Dry-run | Applied | Verify |
|--------|---------|---------|--------|
| R1 — clear bogus calendar `location` (==title / generic) | 437 candidates / 1767 user docs | `updated: 437, failures: 0` | 0 remaining |
| R2 — backfill `user_id`/`date`/`source` on orphan stress docs | 2 orphans (ids carry uuid+date) | `updated: 2, failures: 0` | 0 remaining orphans |
| R3 — migrate legacy calendar ids → `${userId}::…` | 1748 legacy, 0 scoped | indexed 1748 scoped + deleted 1748 legacy, 0 errors | `legacy: 0, scoped: 1748` (no dups) |

R3 ran after redeploying the gateway `calendar-sync` id fix; the "before" count already showed 116 scoped docs (the new sync starting to duplicate), which the migration converged. Repairs executed as equivalent scoped ES operations over SSH (ES is internal-only); the authored `packages/*/scripts/repair-*.ts` remain the reusable/documented form.
