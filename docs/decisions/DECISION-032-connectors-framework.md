# DECISION-032 — Connectors: one framework for external accounts, events plus ledgers, read-only

**Date:** 2026-09-06 · **Status:** accepted (Arnon: "lets do it") · **Design:** `docs/design/connectors.md` · **Research:** `docs/research/2026-09-06-israeli-connectors.md`

## Context

Arnon wants the assistant to see his cards, bank, HMO (Clalit), municipality, bills and home, including individual transactions as they happen. Today every external source is hand-rolled (Google OAuth, Evolution webhooks, Garmin, a dozen phone signals). Israeli open banking is closed to individuals (licensed companies only); scrapers exist and break monthly; card apps push or SMS every transaction. One WhatsApp group produced 83 agent triggers in an hour this morning (ISS-033), so any new feed must be cost-bounded by construction.

## Decision

1. **Two feeds per source.** Events (phone notification/SMS capture, Home Assistant webhooks) for immediacy; ledgers (scrapers, portal skills, APIs) for truth. A reconciler links them; the unmatched become findings.
2. **A `connectors` MCP owns the data** (PostgreSQL, application-level AES-256-GCM on payloads, HMAC merchant keys, per-user rows). The gateway keeps ingest, parsing, rules, coalescing and scheduling, and posts events to the MCP's REST route; it never writes the MCP's tables.
3. **Read-only towards the world.** No payment, booking or write tool exists; credentials enter through a dashboard REST route, never a chat tool.
4. **Cost guard in the gateway:** at most 3 immediate triggers per connector per hour, overflow coalesced, everything else a notable event and one line in the morning brief. Rules: amount threshold, unknown merchant, foreign, duplicate, charge while asleep at home.
5. **Routes per source** (from the research): cards by notification capture now and `israeli-bank-scrapers` (via moneyman) for ledgers later; Home Assistant for the house and for IEC/water/gas; Clalit and municipality as a weekly agent skill through the vault; no direct open-banking APIs; Financy considered if a paid, credential-free ledger is wanted.
6. **Open questions decided by standing authorization:** OTP by chat paste first (SMS forwarding is a consent switch, off); connector tool results redacted from the audit log; retention 24 months ledger / 90 days raw text; family attribution later.

## Alternatives considered

- Extend the health MCP (has the credential/adapter skeleton): rejected, different domain and different sensitivity boundary.
- Per-source bespoke code, as today: rejected, the fifth copy of the same lifecycle.
- Scrapers first, events later: rejected, events are cheaper, credential-free and what Arnon asked for.

## Consequences

- One more service on the box; one more image in CI; compose lint covers it.
- The catalog in `@ll5/shared` is the single list a new connector edits; adding one touches the catalog, a parser and/or an adapter, the Android package map, and FILE_TREE.
- Verification per phase is in the design's Section 9; Phase 1's proof is a real card charge visible in `query_events` within minutes and at most one system message for it.
