# Code-quality / bug review — 2026-05-29

Branch: `fix/review-batch-2026-05-29`. Reviewer fan-out across all 11 packages; fixes implemented as 7 parallel workstreams, each TDD (genuine RED captured before any source edit, then GREEN).

- **Result:** 674 tests passing (was ~611), typecheck exit 0 across all 11 packages.
- **New tests:** +63 (incl. two-user multi-tenancy tests for every scoping fix).
- **Decision records:** [DECISION-001](../../decisions/DECISION-001-tenant-scoped-by-id-access.md) … [DECISION-005](../../decisions/DECISION-005-cross-entity-search-scoring.md).
- **Test logs:** `*-RED.log` / `*-GREEN.log` in this directory (one pair per workstream).

## Live ES traces (confirmed before fixing — admin user)

The four highest-impact bugs were verified against production Elasticsearch, not just reasoned about:

| Bug | Index queried | Trace |
|-----|---------------|-------|
| Garmin `activeSeconds` precedence | `ll5_health_daily_stats` | **every** doc had `active_seconds: 0` (incl. 6,800-step days) |
| Calendar `location = title` | `ll5_awareness_calendar_events` | **89** docs `location == title`, **348** docs `location: "(no title)"` |
| Stress-upsert orphan | `ll5_health_daily_stats` | **2** docs with stress data but no `user_id`/`date` (invisible to scoped reads) |
| OAuth refresh discarded | `ll5_app_log` | **18** `invalid_grant`/refresh-fail lines; `google` = #1 error service (42) |

The multi-tenancy scoping bugs left no traces (single-tenant today) — proven instead by two-user tests that fail RED on the unscoped code.

## Findings → fixes

### Tier 1 — logic bugs (misbehaving in production)

| # | Bug | Fix | RED proof | Log added |
|---|-----|-----|-----------|-----------|
| 1 | gtd `deleteAction` ran DELETE twice → always returned `false` | single `DELETE … RETURNING id` | `expected false to be true`; `called 2 times` | `action_deleted {id, user_id, deleted}` |
| 2 | Garmin `activeSeconds` operator-precedence (`??` vs `?:`) → 0/NaN | explicit if/else ladder, NaN-guarded | `expected NaN to be 4200` | `active_seconds source selected {…}` |
| 3 | Rotated Google `refresh_token` never persisted → invalid_grant | new `updateRefreshToken` (encrypted, scoped) | `updateRefreshToken … 0 calls` | `google_refresh_token_rotated {user_id}` |
| 4 | Calendar enrichment wrote old title into `location` | fall back to `existing.location`, else omit | `expected 'busy' to be 'Tel Aviv Office'` | `calendar_merge {event_id, location_source}` |
| 5 | 30-min sync full-replace reset `created_at` + reverted merge | bulk `update` w/ `{doc, upsert}`, field-ownership split | `hasIndexReplace expected true to be false` | `calendar_sync {event_count, op, errors}` |
| 6 | Stress upsert created orphan doc with no `user_id` | upsert sets `user_id`/`date`/`source` | `expected undefined to be 'user-test-1'` | `stress_upsert {user_id, date}` |
| 7 | Notable-events severity filtered after `size:100` truncation | severity as query-time `terms` filter | `query body to contain 'severity'` | — |
| 8 | Telegram `read_messages` used `getUpdates` (queue, not history) | return explicit not-supported error | unsafe `getUpdates` path executed | — |
| 9 | `bulkUpsert` crashed (PG 21000) on intra-batch dup JID | dedupe by `(platform, platform_id)` last-wins | `expected 2 to be 1` | `bulkUpsert dedupe {input_count, deduped_count}` |

### Tier 2 — multi-tenancy scoping (latent today; hard-rule violations) — see DECISION-001

| Surface | Fix | RED proof |
|---------|-----|-----------|
| gateway `GET /journal` | add `user_id` term | `user_id term … expected undefined to be defined` |
| gateway `PATCH /journal/:id` | ownership check, 404 on miss | `expected 200 to be 404` |
| gateway `GET /sessions/:id` | ownership check, 404 on miss | `expected 200 to be 404` |
| gateway `GET /media/:id/links` | add `user_id` term | `user_id term … undefined` |
| gateway `whatsapp-webhook` contact/conversation lookups | add `WHERE user_id` | SQL `to match /user_id = \$\d/` |
| awareness `location.repository.delete` | `deleteByQuery` + `user_id`, stop swallowing errors | raw `client.delete` called; error swallowed |
| awareness `resolve_journal` by entry_id | ownership check before update | attacker `update` mutated owner's entry |
| awareness `link_media` / unlink / cleanup | verify media ownership + scope by `user_id` | link created without ownership; unscoped cleanup |
| google calendar event doc id | user-namespaced id + `deleteForUser` (DECISION-002) | both users mapped to identical id |

### Tier 3 — robustness / correctness polish

| Area | Fix | RED proof |
|------|-----|-----------|
| gtd `updateAction` `completed_at` clobber (DECISION-004) | clear only on `→ active` | SQL matched `completed_at = NULL` for on_hold/dropped |
| gateway SSE `/listen` error-path leak | single idempotent `cleanup()` | `clientEnd expected to be called` |
| gateway `/availability/check` no abort | `req.on('close')` abort | close handler never registered |
| gateway login rate-limit key | normalize bucket key (trim+lowercase) | `expected 401 to be 429` |
| gateway `PUT /contact-settings` partial-update reset | split INSERT defaults from UPDATE binds | `expected 'batch' to be null` |
| evolution `connectionState` swallowed transient errors | return distinct `transient_error` | `'disconnected' not to be 'disconnected'` |
| shared API-key compare timing side-channel | `timingSafeEqualStr` | `timingSafeEqual … never called` |
| pk cross-entity search scoring (DECISION-005) | raw BM25 + single global normalization | type-tops all collapsed to `1.0` |

## Deterministic logging standard (applied to every fixed path)

Project rule: **no silent errors / defaults.** Each fixed path now emits exactly one structured line on its decision or outcome (matching each package's existing logger):

- **Scoping denial** → `warn cross_user_access_denied { actor_user_id, owner_user_id, resource, id }` (gateway journal/sessions, awareness journal/media).
- **Calendar** → `calendar_merge { event_id, location_source }`, `calendar_sync { event_count, op, errors }`.
- **Health** → `active_seconds source selected {…}`, `stress_upsert { user_id, date }`.
- **OAuth** → `google_refresh_token_rotated { user_id }` (only on genuine rotation).
- **GTD** → `action_deleted { id, user_id, deleted }`, completed_at-cleared on re-open.
- **Messaging** → `bulkUpsert` dedupe counts; `connectionState` transient-vs-logout distinct.

Hot success paths (e.g. API-key accept) stay silent to avoid log noise.

## Data repairs (authored, NOT run)

Guarded one-time scripts (dry-run default, `--apply` to execute, tenant-scoped). Run manually after deploy of the code fixes:

- `gateway/scripts/repair-calendar-locations.ts` — clears the ~437 bogus locations (`location==title` / generic-title); real location repopulates on next Google sync.
- `health/scripts/repair-orphan-daily-stats.ts` — backfills `user_id`/`date`/`source` on the 2 orphan stress docs (parsed from `_id`).
- `google/scripts/repair-calendar-event-ids.ts` — reindexes legacy unscoped calendar doc ids to the user-namespaced form.

None are wired into deploy/startup.

## Cross-tenant contamination audit (follow-up)

After the first batch, a dedicated read-only audit enumerated **every** data-access point across all packages (ES + SQL), classifying each as scoped / unscoped-risk / intentionally-global. It confirmed the first-batch fixes are in place and the repository base helpers (`buildBoolQuery`, `getById` recheck, `deleteById` user filter) inject `user_id` everywhere. It found **6 additional vectors** beyond the first batch, all now fixed (RED-first; logs `J/K/L/M-*`):

| # | Vector | Severity | Fix |
|---|--------|----------|-----|
| A1 | gateway `whatsapp-webhook.ts` read Evolution creds `FROM messaging_whatsapp_accounts LIMIT 1` (no `user_id`) | MODERATE | `WHERE user_id = $1 ORDER BY instance_name` |
| A2 | gateway `phoneEventId = sha256(title\|start\|end)` unsalted → cross-tenant calendar overwrite | MODERATE | salt hash with `userId`; aligned the `server.ts` cleanup id reconstruction |
| A3 | health `writeActivityToES` id `${source}-activity-${id}` unsalted | LOW/MED | id now embeds `userId`; body carries `user_id`/`date`/`source` |
| A4 | messaging `getMessageCountToday(accountId)` (no `user_id`; gated by prior ownership check) | MODERATE (def-in-depth) | signature → `(userId, accountId)`, `AND user_id = $2` |
| A5 | awareness calendar-event `upsert` by caller id, no owner verify (gateway-ingest-only, latent) | LOW | fetch-then-verify owner before index |
| A6 | awareness `location-service.lookupBssidPlace` no `_source.user_id` recheck (id is server-derived) | LOW (def-in-depth) | recheck `user_id`, return null + warn on mismatch |

Root cause for A2/A3 (and the earlier calendar-event id + stress orphan) is the same: **deterministic ES doc ids that omit `user_id`** — codified in [DECISION-006](../../decisions/DECISION-006-deterministic-doc-ids-embed-user-id.md). No SQL-injection vectors found (all bindings parameterized). Two benign notes left as optional hardening: a gtd self-join missing `p.user_id = h.user_id` (UUID PKs, not exploitable) and the google legacy-id co-delete during the calendar-id migration window (self-resolving).

**After both batches:** 694 tests passing, typecheck clean. Empirical two-tenant verification (synthetic tenants, before/after deploy) recorded in `verification.md` in this directory.
