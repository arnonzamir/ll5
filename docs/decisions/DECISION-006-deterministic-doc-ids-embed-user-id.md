# DECISION-006 — Deterministic ES doc ids must embed `user_id`

Date: 2026-05-29
Status: Accepted
Scope: every writer that derives an Elasticsearch `_id` deterministically (gateway, google, health, awareness)

## Context

A cross-tenant contamination audit (2026-05-29, `docs/reviews/2026-05-29/`) found a recurring class of bug: writers that compute a **deterministic** ES doc id from content/external keys **without including `user_id`**. Two tenants producing the same key then map to the same `_id`, so one tenant's write silently overwrites the other's document (last-writer-wins), and any delete/reindex keyed on that id crosses tenants. Reads don't leak (they filter `user_id`), but the document is corrupted/overwritten.

Instances found and fixed:
- gateway `phoneEventId = sha256(title|start|end)` → collision on identically-titled, same-time events.
- health `writeActivityToES` id `${sourceId}-activity-${sourceActivityId}` (`sourceId` is the source *type*, e.g. `garmin`) → collision on equal provider activity ids.
- health `writeStressToES` (earlier batch) created an id-less orphan with no `user_id` in the body.
- google calendar event id `google-<event_id>` → collision on shared/imported Google event ids (fixed via user-namespaced id, [DECISION-002](DECISION-002-calendar-event-storage-contract.md)).

The repos that were already correct (`profile` id=`userId`, `networks` `${userId}::${bssid}`, `narratives` `${userId}::${kind}::${ref}`) all embed `user_id` in the id.

## Decision

**Any deterministic ES doc id MUST include `user_id` as a component**, and the document body MUST carry `user_id`. Two complementary rules:

1. **Id construction:** salt the deterministic id with `user_id` — either as a namespace prefix (`${userId}::…`) or inside the hash input (`sha256(userId|…)`). Auto-generated (random) ids are exempt (no collision risk) but their body must still carry `user_id`.
2. **By-id mutation guard:** any `update`/`delete`/`upsert` that targets a caller-influenced id must either (a) be reachable only with a server-derived `user_id` baked into the id, or (b) fetch-then-verify `_source.user_id === actorUserId` before mutating (see [DECISION-001](DECISION-001-tenant-scoped-by-id-access.md)). Reject mismatches with `warn cross_user_access_denied`.

## Alternatives considered

- **Rely on the body `user_id` + read-time filtering only** — rejected: protects reads but not write-overwrites; the document is still silently clobbered.
- **Random ids everywhere** — rejected: deterministic ids are needed for idempotent upserts (calendar re-sync, dedup); the fix is to salt them, not abandon them.

## Consequences

- New regression tests assert "two `user_id`s produce different doc ids for the same content key" for each fixed writer.
- One-time repair scripts re-key legacy unscoped docs where needed (calendar event ids), dry-run by default.
- Review checklist for any new ES writer: deterministic id → is `user_id` in it? by-id mutate → is ownership verified?
