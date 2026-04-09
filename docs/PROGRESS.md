# LL5 Progress

Current state of the LL5 personal assistant system.

---

## Current Status

**Phase:** Full system operational — 6 MCPs, gateway, dashboard, Android app, agent client

### Deployed Services (Coolify @ 95.216.23.208)

| Service | Status | URL |
|---------|--------|-----|
| personal-knowledge MCP | Live | mcp-knowledge.noninoni.click |
| gtd MCP | Live | mcp-gtd.noninoni.click |
| awareness MCP | Live | mcp-awareness.noninoni.click |
| calendar MCP | Live | mcp-google.noninoni.click |
| health MCP | Live | mcp-health.noninoni.click |
| messaging MCP | Live | mcp-messaging.noninoni.click |
| gateway | Live | gateway.noninoni.click |
| dashboard | Live | ll5.noninoni.click |
| Elasticsearch 8.15.0 | Healthy | internal |
| PostgreSQL 16 | Healthy | internal |

### Client (ll5-run)

| Component | Status |
|-----------|--------|
| MCP connections (6) | Working |
| Skills | review, daily, clarify, engage, sweep, plan, welcome, consolidate, catchup, calendar-review, doc-audit |
| Welcome launcher | Working |
| Chat bridge (SSE listener) | Working |
| Stop/FileChanged hooks | Configured |
| Auth (signed tokens + PIN) | Working |

## Tool & Page Counts

Counts go stale. To get current numbers:

```bash
# MCP tools per package
for pkg in personal-knowledge gtd awareness google messaging health; do
  echo "$pkg: $(grep -r 'server\.tool(' packages/$pkg/src/tools/ | wc -l | tr -d ' ')"
done
# Channel MCP tools
grep "name: '" ll5-run/channel/ll5-channel.mjs | wc -l
# Dashboard pages
find packages/dashboard/src/app -name "page.tsx" | wc -l
# Gateway schedulers
ls packages/gateway/src/scheduler/*.ts | wc -l
# Gateway REST endpoints
grep -E 'app\.(get|post|put|patch|delete)\(' packages/gateway/src/server.ts packages/gateway/src/chat.ts | wc -l
```

Last audited (2026-04-07): 111 tools, 33 pages, 10 schedulers, ~39 REST endpoints.

## Roadmap Status

### Done

| Feature | Date | Notes |
|---------|------|-------|
| Unified contacts & routing | Apr 6-7 | contact_settings table, 3-tab UI (people/contacts/groups), contact-only person stubs, link/unlink/auto-match, optimistic UI + sessionStorage cache |
| Geo search | Apr 5 | Built into awareness MCP (not separate MCP): search_nearby_pois, geocode_address, get_area_context, get_distance |
| Push notification levels | Apr 3 | 4 levels (silent/notify/alert/critical), agent chooses per push, user ceiling + quiet hours |
| Source routing for replies | Apr 7 | metadata.source on system messages, channel MCP passes to agent, agent replies on correct platform |
| Conversation escalation | Apr 4 | User activity in ignored/batched chat → 30-min immediate window |
| Journal consolidation | Apr 1 | User model ES index, nightly consolidation trigger |
| Proactive agent | Apr 4 | 8 schedulers, audit trail, data-rich heartbeat, agent nudge |
| Health MCP | Mar 31 | Garmin: sleep, HR, body battery, HRV, VO2 Max, respiration, training readiness |
| Calendar integration | Mar 29 | Google Cal + phone sync, ticklers (recurring), week view, availability check |
| WhatsApp integration | Mar 30+ | Evolution API, webhook, image download, pushName enrichment, contact sync (2,874 contacts) |
| Android app | Mar 29 | Chat, GPS, notification capture, FCM, Health Connect |
| User management | Apr 8 | All 5 phases: AsyncLocalStorage, admin CRUD, username login, rate limiting, PIN validation, multi-user schedulers, WhatsApp routing, onboarding, families |
| Data source config | Apr 7-8 | Per-source toggles, gateway enforcement, dashboard UI, Android device command sync |
| Health polling scheduler | Apr 7 | Polls every 20min, sleep/activity/HR/stress/energy/weight detection, 7-day baselines |
| Admin log explorer | Apr 8 | Datadog-style: faceted sidebar, time range, search, slide-out detail, separate app/audit pages |
| Test suite (369 tests) | Apr 8-9 | All 8 packages: shared, gateway, knowledge, gtd, awareness, health, messaging, google |
| Auto-match contacts | Apr 9 | Person-first, Hebrew-Latin cross-script, multi-candidate UI, name similarity scoring |
| Android phone contacts push | Apr 9 | Address book sync → gateway → messaging_contacts enrichment (fixes 2043 nameless contacts) |
| WhatsApp image download fix | Apr 9 | Gateway decrypts Evolution API key before media download (was passing encrypted key) |

### Not Built — Planned

| Feature | Design Doc | Priority | Effort |
|---------|-----------|----------|--------|
| ~~Android phone contacts push~~ | — | ~~Medium~~ | ~~DONE (Apr 9)~~ |
| WhatsApp history backfill | ROADMAP.md | Low | Medium — Evolution API findMessages or export parser |
| Email sync from phone | ROADMAP.md | Low | Medium — Android ContentProvider for metadata |
| Money tracking MCP | ROADMAP.md | Low | Large — bank APIs, categorization, projections |

### Tech Debt

| Item | Priority |
|------|----------|
| Auth hardening (device-bound sessions, passkeys, or OAuth) | Low — current PIN+bcrypt sufficient for family use |
| Tests: 362 passing across 8 packages. Dashboard uncovered. | Low |
| Evolution API findContacts times out on full dataset (2913 contacts) | Low — workaround: single-JID queries work |

## Recent Changes

- 2026-04-09: Fix WhatsApp image download: gateway was passing encrypted Evolution API key to getBase64FromMediaMessage (regression from api_key encryption). Added decrypt util + ENCRYPTION_KEY env var to gateway.
- 2026-04-09: Android phone contacts push: ContactsRepository reads device address book (ContactsContract), pushes name→phone pairs as phone_contact webhook items. Gateway normalizes phone numbers (Israeli +972/0 variants), enriches messaging_contacts display_name where current name is null/phone-number/JID.
- 2026-04-09: Contacts & Routing: person-first auto-match with Hebrew-Latin cross-script matching (~80 Israeli name lookup table), multi-candidate UI, link contact from People tab via search modal, "Named only" filter (excludes JIDs/phone numbers), client-side pagination (50/page), calendar event cleanup (delete phone events removed from calendar)
- 2026-04-08: Android: alert vibration bypasses silent mode (Vibrator.vibrate), data source toggle sync via device commands, calendar push window reduced (1+14 days, was 7+60), device_calendar webhook items accepted
- 2026-04-08: Admin log overhaul: Datadog-style LogExplorer with faceted sidebar, time range presets, sortable columns, search, slide-out detail panel. Separate /admin/logs and /admin/audit. "Only" button on facets.
- 2026-04-08: Tech debt: 362 tests across 8 packages (was 0). Auth-middleware deduplicated (4 copies → @ll5/shared). Logging format fixed (shared 0% → 100%).
- 2026-04-08: User management: all 5 phases — AsyncLocalStorage (6 MCPs), DB migration 019, admin CRUD API (10 endpoints + dashboard), username login, rate limiting, PIN validation (6+ blocklist), multi-user schedulers, WhatsApp routing, onboarding wizard, families tables
- 2026-04-07: Data source config: per-source toggles (GPS, IM, calendar, health, WhatsApp) in user_settings JSONB. Gateway isSourceEnabled() helper with 60s cache. Enforcement in processItem + WhatsApp webhook. Dashboard /settings/data-sources page with toggle switches.
- 2026-04-07: Health polling scheduler: polls ES every 20min during active hours, detects new sleep/activity/HR anomaly/stress/energy/weight events, batches into system messages with notification levels. 7-day baseline for conditional alerts. Dedup per day.
- 2026-04-07: Source routing metadata on system messages: WhatsApp webhook includes platform/remote_jid/sender in metadata, PG NOTIFY passes it through, channel MCP exposes it in meta.source. Agent instructions updated: MUST reply on the same platform using send_whatsapp with remote_jid.
- 2026-04-07: Contacts page: instant optimistic UI (fire-and-forget server updates, no blocking), sessionStorage cache (instant paint on revisit, background refresh if stale >5min)
- 2026-04-07: Fix WhatsApp sync: re-encrypt Evolution API key (was stored as plain text), synced 2,874 contacts with names. Auto-match UI shows phone number + KB person notes for better match verification.
- 2026-04-06: Contact matching UI: link popover (search KB people), unlink button per platform, auto-match wizard (fuzzy name matching with accept/skip)
- 2026-04-06: WhatsApp webhook enriches contact display_name from pushName (only overwrites null/empty/phone-number-only names)
- 2026-04-06: Fix CI deploy: add docker login to GHCR before pull (server auth was expiring, causing deploys to skip image updates silently)
- 2026-04-06: Unified contacts system: Person `status` field (full/contact-only), 3-tab Contacts & Routing page (People, Contacts, Groups). Unlinked messaging contacts get lazy-created stub persons on first setting change. Promote button moves contact-only → full KB person. Gateway matcher unchanged — all routing via person_id.
- 2026-04-05: 100% audit logging across all MCPs (personal-knowledge, awareness, health, messaging). Audit log entity IDs are hoverable with detail tooltips. Gateway initAudit ready for server-side processors.
- 2026-04-05: Fix export (per-index limits, no media, request timeouts), fix WhatsApp image download (pass full message to Evolution API)
- 2026-04-05: User model versioning (history index + list/get version tools), consolidation reloads model + pushes silent update, GPS accuracy filter (>100m discarded)
- 2026-04-05: 100% tool logging: add withToolLogging + initAppLog to personal-knowledge and messaging MCPs (were missing entirely). All 6 MCPs now log every tool call.
- 2026-04-05: Map z-index fix, places page map view (list+map split with Leaflet), data export page (/export), location query returns doc IDs for delete_location_point
- 2026-04-05: Geo search tools on awareness MCP: search_nearby_pois (Overpass), geocode_address (Nominatim), get_area_context, get_distance (OSRM). Plus delete_location_point for GPS error cleanup.
- 2026-04-05: Calendar week view: timeline layout with hour grid, work hour coloring, current time line, respects week start day from profile settings
- 2026-04-04: Proactive agent overhaul: audit trail (correlation IDs on all scheduler messages), data-rich heartbeat (events past+future + pending counts), configurable scheduler settings UI (/settings/scheduler), all intervals readable from user_settings JSONB
- 2026-04-04: Agent nudge scheduler, recurring ticklers, conversation escalation, Garmin body battery/HRV/VO2 Max, work week settings
- 2026-04-03: Design docs for roadmap items, unified user_settings, notification levels, archived groups, places auto-geocoding
- 2026-04-01: Journal consolidation, chat SSE, chat progress feedback
- 2026-03-31: Health MCP + dashboard, media gallery, unified message priority, check_availability
- 2026-03-29-30: Calendar integration, Android app, channel MCP bridge, dashboard pages, audit log
- 2026-03-28: Infrastructure: Coolify, auth, MCPs built + deployed, chat system
- 2026-03-27: Project start: design docs, monorepo foundation

## Known Issues

- Evolution API `findContacts({where:{}})` times out on 2913 contacts — single-JID queries work fine
- Most messaging contacts lack display names — Evolution API only provides WhatsApp `pushName`. Fix deployed: Android phone contacts push enriches from address book (needs READ_CONTACTS permission grant + first sync).
- Dashboard MCP client sometimes gets stale responses (needs cache-busting)












