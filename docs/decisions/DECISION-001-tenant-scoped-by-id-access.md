# DECISION-001 — Tenant-scoped by-id access control, 404 convention, deterministic denial logging

Date: 2026-05-29
Status: Accepted
Scope: gateway, awareness, google (the by-id read/update/delete surfaces)

## Context

LL5's first design principle is "multi-tenancy from day one — every record has a `user_id`, every query is scoped." A code review (2026-05-29) found a class of endpoints and repository methods that fetched, updated, or deleted a record **by its raw document id** with no `user_id` predicate:

- gateway `GET /journal`, `PATCH /journal/:id`, `GET /sessions/:id`, `GET /media/:id/links`
- gateway `whatsapp-webhook` contact / conversation name lookups (`messaging_contacts`, `messaging_conversations` — both `UNIQUE(user_id, …)`)
- awareness `location.repository.delete(userId, id)` (ignored `userId`), `resolve_journal` by `entry_id`, `link_media` / media-link cleanup
- google calendar event ES doc id `google-<event_id>` (no tenant component) — see [DECISION-002](DECISION-002-calendar-event-storage-contract.md)

These are latent under the current single-tenant deployment (no traces in ES), but each is a direct violation of the hard scoping rule and would be a cross-tenant read/write/delete the moment a second user exists.

## Decision

1. **Every by-id access is tenant-scoped.** Reads/updates either filter `user_id` in the query, or fetch-then-verify `_source.user_id === actorUserId` before mutating. Deletes use `deleteByQuery` with both an `ids` term and a `user_id` term (matching `BaseElasticsearchRepository.deleteById`), never a raw `client.delete({ id })`.
2. **Ownership miss returns 404, not 403.** A record owned by another tenant is indistinguishable from a non-existent record to the caller — this avoids an existence-disclosure side channel. Codified for `/journal/:id` and `/sessions/:id`.
3. **Denials are logged deterministically.** Every scoping rejection emits exactly one structured line:
   `warn cross_user_access_denied { actor_user_id, owner_user_id, resource, id }`.
   This makes a future cross-tenant probe visible in `ll5_app_log` instead of silent.

## Alternatives considered

- **403 on ownership miss** — rejected: leaks that the id exists.
- **Rely on random ES/PG id unguessability** — rejected: "hard to guess" is not "scoped"; ids leak through other endpoints and the rule is absolute.
- **A shared middleware that post-filters every response by `user_id`** — rejected as too coarse: by-id mutations (PATCH/DELETE) need the check *before* the write, not a response filter.

## Consequences

- Two-user (`userA`/`userB`) tests now exist for each fixed surface, asserting cross-user denial + that the owner's data is untouched. They were verified RED against the unscoped code first (`docs/reviews/2026-05-29/`).
- `404-not-403` is now the gateway convention for any new by-id route — follow it.
- The `cross_user_access_denied` log shape is the standard denial signal; alerting can key on it.
