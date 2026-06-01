# DECISION-008: Google Find Hub via a Python sidecar, into a separate index

## Context

We want LL5 to locate Bluetooth trackers (keys, bag, car) and other devices
shared to the user's Google account, using Google's Find Hub network. The only
viable client is [GoogleFindMyTools](https://github.com/leonboe1/GoogleFindMyTools)
— a reverse-engineered **Python** project. LL5 is otherwise pure TypeScript/Node
(even the Garmin integration was reimplemented in TS rather than run as a Python
process).

Two questions: (1) how to run Python-only GoogleFindMyTools, and (2) where the
resulting locations live in the data model.

## Decision

**1. Run GoogleFindMyTools as an isolated Python sidecar** (`packages/findhub-poller`)
that pushes to the existing gateway webhook as a new `tracked_device` item type,
rather than porting the protocol/decryption to TypeScript.

**2. Store fixes in a new `ll5_awareness_tracked_devices` index** (current-state,
upsert per device), NOT in `ll5_awareness_locations` and NOT through
`processLocation`.

## Alternatives considered

- **Port the Find Hub protocol to TypeScript** (like the Garmin client). Keeps
  the stack pure-TS and dependency-light, but means owning the reverse-
  engineering of an E2EE, frequently-changing, undocumented protocol — large
  effort and a perpetual maintenance tax. Rejected: the value is locating
  things, not reimplementing Google's crypto.
- **Route Find Hub fixes through `processLocation`.** Reuses geocoding/place-
  matching, but those docs mean "where the USER is" — trackers would pollute the
  user's GPS history, trigger false arrival notifications, and be subjected to
  drift filtering that's wrong for single crowd-sourced fixes. Rejected.
- **A dedicated `/webhook/findhub` route.** More surface area; the existing
  `/webhook` already does auth, rate-limiting, and per-item validation. Rejected
  in favor of adding an item type to the discriminated union.

## Consequences

- The stack gains its first Python service. It's deployment-isolated (its own
  container/image) and touches LL5 only via the public webhook, so it can't
  destabilize the Node services.
- Upstream fragility is contained in `findhub_client.py`; the rest of the poller
  and all of LL5 is insulated.
- `Auth/secrets.json` must be generated with Chrome locally and mounted in; it
  can expire and need re-minting. Operational cost documented in HANDOFF.
- The new index and item type are additive — no migration, no impact on existing
  clients. A future v1.1 can add per-device notifications and history.
