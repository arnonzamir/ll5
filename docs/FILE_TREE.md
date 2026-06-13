# LL5 File Tree

Annotated source tree of the ll5 monorepo. MCP server names use ll5- prefix (ll5-calendar, ll5-messaging) to avoid Claude Code SDK collisions.

---

```
ll5/
├── CLAUDE.md                          # Project instructions for Claude Code
├── package.json                       # npm workspaces root
├── tsconfig.json                      # Base TypeScript config
├── .env.example                       # All environment variables documented
│
├── .github/workflows/
│   ├── build-and-push.yml            # CI: build changed packages, push to GHCR, deploy via SSH (pulls only GHCR images, never DBs; 15min command_timeout — 5min wasn't enough under host pressure). `detect-changes` diffs the TIP commit only (`HEAD~1..HEAD`): a `shared`/`docker` change rebuilds all 8, but if it sits under a later tip commit it's skipped → stale dependents (partial-deploy trap; force a full rebuild with a docs-only commit or `workflow_dispatch` empty `packages`). Host `docker login` uses non-expiring `GHCR_READ_PAT`, NOT `GITHUB_TOKEN` (the ephemeral `ghs_` token clobbered the shared host cred → recurring GHCR `denied`; fixed 2026-05-22). Also runs `compose-drift-check` in parallel with build — diffs the on-host compose vs `docker/docker-compose.prod.yml` and fails loudly on manual edits (does not block deploy; deploy resyncs from repo).
│   └── compose-drift-check.yml       # Standalone daily 06:00 UTC drift check (same logic as the parallel job) — catches manual on-host edits within 24h even when no one is pushing. Also workflow_dispatch.
│
│ (ll5-run repo — client workspace — is a separate git repo.)
│ (ll5-run/ll5 launcher: exports MCP_TIMEOUT=30000, parallel /health pre-warm, then exec claude.)
│ (ll5-run/channel/ll5-channel.mjs: SSE chat bridge + MCP connectivity probe for all 6 remote MCPs)
│ (every 10min, exposes `check_mcp_connectivity` tool, rate-limited system notifications on failure.)
│ (Apr 19: simplified push_to_user (drops channel heuristic), added new_conversation + react tools,)
│ (passes reply_to_id/reaction/display_compact through SSE meta, handles conversation_archived/_created events.)
│ (May 3: added `narrate` tool — writes display_compact + metadata.kind="thinking" so web/android render asterisk-prefixed italic lines as the agent's internal voice.)
│ (May 3: dashboard chat — inline reaction strip in the hover/long-press bar (8 icons: 6 reactions + reply + copy), drops the popover. /settings/contacts column labels become Authority + Delivery, with column-specific button labels (Blocked/Read/Reply for Authority; Drop/Batch/Notify for Delivery) and a bidirectional pairedAdjust rule that lifts the silent twin off ignore when the user opens the other column AND drops the active twin to ignore when the user blocks the other column.)
│ (May 3: WhatsApp messages now carry conversation_id + conversation_name in ES; MessageBatchReviewScheduler clusters by sender|app|conversation and surfaces group name + first/last snippet per cluster in its summary.)
│ (May 3: /settings/contacts categorization hardened — tab counts use filtered values; @g.us / Telegram-negative IDs excluded from Contacts tab regardless of the is_group column; list_people limit raised to 5000 to stop People↔Contacts flapping when there are >200 KB people. Personal-knowledge MCP list_people Zod max raised 200→5000 to allow this. Groups tab now unions messaging_conversations + messaging_contacts(is_group=true) keyed on JID — fixes "150 cap" where the conversations table was incomplete. May 22: Source-filter chips (All/WhatsApp/Slack/SMS/Gmail…, derived live from loaded data) scope all 3 tabs.)
│
│ (ll5-android repo — Android app — is a separate git repo.)
│ (data/remote/ChatApi.kt: chat/conversations/active, /new, PATCH /chat/messages/{id} for reactions.)
│ (data/repository/ChatRepository.kt: listenForEvents parses conversation_archived/_created, reply_to_id,)
│ (reaction, display_compact. sendMessage surfaces 409 as structured response, not exception.)
│ (ui/chat/ChatScreen.kt: reply-quote bubbles, reaction strip, long-press action sheet + reaction sheet,)
│ (compact rendering with 60s group-collapse, new-conversation dialog. Ships via manual APK install.)
│
├── docker/
│   ├── Dockerfile.mcp                # Shared Dockerfile for all MCP servers (PACKAGE_NAME build arg)
│   ├── Dockerfile.gateway            # Gateway-specific Dockerfile (copies src/migrations to dist)
│   ├── Dockerfile.dashboard          # Next.js standalone Dockerfile
│   ├── docker-compose.yml            # Local dev: ES + PG
│   └── docker-compose.prod.yml       # **Production source of truth** (11 services; dashboard at ll5.noninoni.click; google + messaging need AUTH_SECRET in their env block; `browser` = Playwright MCP at mcp-browser.noninoni.click behind Traefik basicAuth + --allowed-hosts, with --blocked-origins SSRF hardening + a persistent profile bind-mounted from /opt/ll5/browser-profile, DECISION-010). ES now requires auth (xpack.security.enabled=true; clients use inline creds via ELASTICSEARCH_URL=http://elastic:${ELASTIC_PASSWORD}@…; dashboard via lib/es.ts; authed ES healthcheck; DECISION-011). CI scp's to host on every deploy; never edit on host.
│
├── docs/
│   ├── vision.md                     # What the system does for the user
│   ├── purpose.md                    # Design principles and constraints
│   ├── PROGRESS.md                   # Current status, recent changes, known issues
│   ├── HANDOFF.md                    # Everything to continue: server, auth, DBs, deploy
│   ├── FILE_TREE.md                  # This file
│   ├── design/
│   │   ├── system-architecture.md    # Topology, components, data flows
│   │   ├── storage-architecture.md   # ES + PG, abstraction layer, index/schema design
│   │   ├── auth-and-multitenancy.md  # User model, API key (v1), JWT (v2)
│   │   ├── auth-token-system.md      # Signed tokens with PIN re-auth
│   │   ├── mcp-personal-knowledge.md # 17 tools, ES indices
│   │   ├── mcp-gtd.md               # 14 tools, PG tables
│   │   ├── mcp-awareness.md          # ES indices (IM, location, calendar, journal, user model, geo search, media, notification rules)
│   │   ├── LOCATION_SERVICE.md       # GPS + wifi fusion design (awareness MCP)
│   │   ├── mcp-google.md             # 9 tools, OAuth
│   │   ├── mcp-messaging.md          # 8 tools, WhatsApp/Telegram
│   │   ├── gateway.md                # Webhook receiver design
│   │   ├── skills.md                 # Claude Code skill designs
│   │   ├── claude-personality.md     # GTD coaching, autonomy, emotional contract
│   │   ├── ui-design.md             # Dashboard: user + admin pages
│   │   ├── mcp-geo-search.md       # Geo-search MCP (POI, distance, context — separate service)
│   │   ├── health-polling-scheduler.md  # Health event detection scheduler
│   │   ├── data-source-config.md   # Per-source enable/disable toggles
│   │   ├── skill-gtd-review.md     # GTD daily + weekly review workflows
│   │   └── agent-routing-rename.md # Rename notification rules → routing rules
│   └── implementation/
│       ├── mcp-implementation.md     # Phased build plan for all MCPs
│       ├── deployment.md             # Docker, CI/CD, Coolify
│       ├── deployment-log.md         # What was deployed, lessons learned
│       ├── coolify-setup.md          # Step-by-step Coolify guide
│       └── mcp-client-config.md      # How to configure Claude Code for MCPs
│
├── packages/shared/                   # @ll5/shared — types, interfaces, utilities, canonical ES index definitions
│   └── src/
│       ├── types/                    # 16 domain types (fact, person, place + radius_m, horizon, etc.)
│       ├── location/                 # CANONICAL location-resolution domain (2026-06-04, DECISION-009): constants.ts (every location threshold — single source; incl. WIFI_CONNECTED_ANCHOR_MS=2h + DEPARTURE_ACCURACY_M=50m anti-flap knobs, STATIONARY/DRIVING_SPEED_MPS motion thresholds, TRIP_PULSE_MS=12min), geo.ts (haversineMeters), types.ts (GpsSignal{+road/neighborhood/bearingDeg/speedMps}/WifiSignal/BssidPlace/PriorLabel/ResolvedLocation{+description/motion}/Motion; Freshness=live/recent/stale/unknown [unified 2026-06-12], Precision=high/approximate/coarse/unknown), filter.ts (gateAccuracy + detectDriftGlitch), describe.ts (cardinal bearing→8-point, motionState from speed, describeLocation → the USEFUL "driving on Route 6, heading south — near Kfar Saba" baseline string; **2026-06-12** freshnessLabel/precisionLabel/speedKmh classifiers), resolve.ts (resolveLocation = 7-tier GPS+WiFi fusion + WiFi anchoring + departure hysteresis, attaches description+motion; usability tiers computed off age, no freshness enum). Imported by BOTH gateway write/transition path and awareness read path so they can't disagree. Tested in __tests__/location-resolve.test.ts (incl. cardinal/motion/describe/freshness/precision/speed).
│       ├── indices/                  # Canonical ES mappings for cross-package indices — awareness.ts (7 ll5_awareness_* indices + ensureAwarenessIndices helper), knowledge.ts (ll5_knowledge_networks; shared by personal-knowledge + gateway wifi processor), narratives.ts (ll5_knowledge_observations + ll5_knowledge_narratives — atomic subject-tagged observations + lazy per-subject rollups, deterministic doc id `{user}::{kind}::{ref}`; narrative `observation_count` is recomputed LIVE from observations on every read in ElasticsearchNarrativeRepository — stored field is display-only/stale, May 21). Prevents drift between gateway-writer and MCP-reader.
│       ├── repositories/             # 13 repository interfaces
│       ├── storage/                  # ES + PG client factories
│       ├── auth/                     # Token generate/validate, Express middleware. `token.ts` exports `generateToken`, `validateToken` (Bearer-header form, throws on expiry), and `validateLl5Token` (raw-token form returning `ValidationResult` discriminated union — single source of truth for the four gateway call sites after Phase 2)
│       ├── mcp/                      # MCP server helpers
│       ├── audit.ts                  # ES audit writer (100% mutation coverage across all MCPs)
│       ├── app-log.ts               # ES app logger (all tool calls, errors, webhooks)
│       └── utils/                    # env, logger, errors
│
├── packages/personal-knowledge/       # @ll5/personal-knowledge — ES-backed MCP
│   └── src/
│       ├── repositories/elasticsearch/  # 8 ES repositories (fact, person, place, profile [May 13: + primary_language field for agent response-language override], data-gap, network, observation, narrative)
│       ├── repositories/interfaces/     # Repository interfaces
│       ├── tools/                       # 28 MCP tools (all logged via withToolLogging) — includes networks (find_place_by_bssid, label_network, unlabel_network, list_known_networks) and narratives (note_observation, recall, list_narratives, get_narrative, upsert_narrative, delete_observation, consolidate_narrative — narratives.ts)
│       ├── __tests__/                   # 77 tests: person repo, people tools, observation repo (recall/stats/listForSubject/delete), narrative repo (deterministic id, sensitivity OR-bump, status filters, stale_for_days)
│       ├── setup/indices.ts             # ES index creation (8 indices: profile, facts, people, places, data_gaps, networks, observations, narratives)
│       └── server.ts                    # MCP server with StreamableHTTP + AsyncLocalStorage (auth from @ll5/shared)
│
├── packages/gtd/                      # @ll5/gtd — PG-backed MCP (45 tests). Also hosts the agent's channel bridge (tools/chat.ts: check_messages/send_message/list_conversations → gateway /chat/* — needs GATEWAY_URL=http://gateway:3000)
│   └── src/__tests__/                   # GTD action CRUD, inbox, health metrics
│   └── src/
│       ├── repositories/postgres/       # 3 PG repositories (horizon, inbox, review-session)
│       ├── repositories/interfaces/     # Repository interfaces
│       ├── tools/                       # 14 GTD tools + 3 chat tools
│       ├── migrations/                  # SQL: gtd_horizons, gtd_inbox, gtd_review_sessions
│       └── server.ts                    # Auth from @ll5/shared + AsyncLocalStorage
│
├── packages/awareness/                # @ll5/awareness — ES-backed MCP
│   └── src/
│       ├── repositories/elasticsearch/  # 8 ES repositories (location, message, entity-status, calendar, notable, phone-status, wifi, tracked-device). tracked-device.repository.ts reads ll5_awareness_tracked_devices (listAll by last_seen desc; getByName fuzzy match) — Google Find Hub device/tracker current-state.
│       ├── services/                    # LocationService — fuses GPS + wifi BSSID → the rich CurrentLocation snapshot with provenance (position/trail/motion/heading/wifi; backs the single where_is_user tool + get_situation); stay-point-service.ts — PURE clustering (no I/O): `detectStayPoints(points, params)` runs classic dwell detection (STAY_RADIUS_M=150, MIN_DWELL_MS=10min, MAX_GAP_MS=30min; all overridable) → `Visit[]` with centroid/start/end/duration/point_count + dominant matched place; `groupVisitsIntoCandidates` groups nearby visit centroids into frequent-place candidates. Backs query_visits + suggest_frequent_places.
│       ├── tools/                       # 26 MCP tools (situation, location+delete+where_is_user+query_visits+suggest_frequent_places, messages, journal, user model+versioning, geo search, media, phone_status x2, wifi x2, tracked-devices x2). location.ts now takes the ES client (threaded via tools/index.ts) for the known-place geo_distance exclusion in suggest_frequent_places. tracked-devices.ts → get_tracked_devices + where_is_device (Google Find Hub; collapse provenance to one `place`: saved-place > Google semantic > address > coords; report freshness/age_minutes).
│       ├── utils/geo.ts                 # Pure helper: `haversineDistance(lat1, lon1, lat2, lon2)` returns great-circle distance in meters. Re-extracted from geo-search.ts on May 18 so geo-search has unit-testable foundations.
│       ├── setup/indices.ts             # Shared 8 awareness indices imported from @ll5/shared (incl. tracked_devices) + 4 awareness-exclusive (journal, user_model, media, media_links)
│       ├── __tests__/tools.test.ts       # situation/messages/journal/user_model real handler tests (Phase 0, May 18)
│       ├── __tests__/tools-extra.test.ts # calendar/entity-statuses/location/media/notable-events/phone-status/wifi real handler tests (Phase 0 carryforward, May 18; notification-rule tool tests removed 2026-05-22 with the table). + query_visits / suggest_frequent_places handler tests (Stage 4, 2026-05-30).
│       ├── __tests__/stay-point-service.test.ts # Pure clustering unit tests (Stage 4): empty/single/desc-sorted/identical-timestamp inputs, dwell rule, radius+gap splitting, matched-place propagation, candidate grouping. 15 tests.
│       ├── __tests__/geo-search.test.ts  # haversineDistance unit + search_nearby_pois/geocode_address/get_area_context/get_distance handler tests via vi.stubGlobal('fetch'). beforeEach calls resetNominatimRateLimitForTests() to clear module-local rate-limiter state — keeps suite ~1s instead of >25s. 25 tests.
│       └── server.ts
│
├── packages/gateway/                  # @ll5/gateway — Express HTTP service
│   └── src/
│       ├── admin.ts                    # Admin CRUD: /admin/users (list/get/create/patch/pin/delete), /admin/families (list/create/members)
│       ├── auth.ts                    # POST /auth/token (PIN + username login, rate limiting), POST /auth/refresh (token refresh)
│       ├── chat.ts                    # /chat/* REST + SSE listen endpoint; unified-conversation routing (active LL5-native conv per user via chat_conversations, unique partial index), 30s grace + 409 on archived writes, /chat/conversations/new (atomic archive+open), /chat/conversations/search (ES-first + ILIKE fallback), reactions (semantic enum, XOR with content), display_compact flag, NOTIFY over chat_messages + chat_conversations channels. Filename randomness for uploaded media is now 16 bytes (was 4 — scannable). `getOrCreateActiveConversation` exported for direct testing (May 18, 8 dedicated retry-loop tests).
│       ├── whatsapp-webhook-route.ts   # createWhatsappWebhookRouter — extracted from server.ts (May 18, Phase 1.2). Requires X-Webhook-Secret header (constant-time compare); rejects unknown instance with 404 (no "first user" fallback). Mounted at /webhook/whatsapp and /webhook/whatsapp/*. 10 tests.
│       ├── uploads-route.ts            # createUploadsRouter — auth + per-file ownership (May 18, Phase 1.3). Also createPublicUploadsRouter (2026-05-23): NO-auth `/public/*` static serve of `/app/public-uploads` (crypto-random filenames, nosniff, no index) for shareable image links uploaded via `POST /chat/upload?public=1`. `isFileOwnedBy` enforces filename-prefix → user mapping for both chat uploads (`<userId>_…`) and WhatsApp media (`wa_<kind>_<userIdSlice8>_…`); blocks path traversal and prefix-collision attacks. Replaces the bare `express.static(uploadsDir)` mount. 11 tests.
│       ├── processors/                # GPS geocoding + place/region state machine (location.ts: tracks current semantic label = known place ≤100m OR geocoded city in ll5_awareness_location_state doc per user; geocoding.ts now parses `road` (Nominatim road / Google route) + stores road on the location doc; resolveLocation gets road/neighborhood/bearing/speed → rich `description`+`motion`; FCM push policy [2026-06-05 "stops + pulse"]: push on place arrivals + stops (driving→stationary), SUPPRESS town-by-town city spam while driving, emit one rich trip pulse ≤ every TRIP_PULSE_MS=12min ("Driving on Route 6, heading south — near Hadera"); state carries last_motion/last_pulse_at; TRANSITION_DEDUP_MS anti-flap still applies to stops), IM processing (message.ts: phone-mirrored SMS/Slack/email — parses the real author via message-identity.ts (strips Slack's "#channel: " prefix + (bot) tag), resolves+enriches the AUTHOR in messaging_contacts by platform=app, synthesizes conversation_id (app:group:#channel | app:author), emits "[Slack] Opsgenie (bot) in #data-platform-alerts: …" with source routing incl. person_id, resolves the clean author to a person_id so per-person contact_settings can filter bot/channel noise (the channel itself is the group target); ES doc gains author/source:'phone'/is_bot; direction-aware via item.from_me — outbound renders "[SMS] You → {recipient}", source from_me:true, indexed processed:true), shared message-identity.ts (parseMessageAuthor + enrichContact unified upsert + buildSourceRouting — used by BOTH message.ts and whatsapp-webhook.ts), calendar (dedup + enrich), WhatsApp webhook (images, fromMe, pushName enrichment via shared enrichContact, group participant enrichment, LID→phone mapping; resolves conversation peer display_name + person_id and surfaces them in source routing — outbound renders "You → {recipient}", source carries contact_name/person_id/from_me), WhatsApp contact webhook (CONTACTS_UPSERT/UPDATE), contact-routing resolver (contact_settings), phone contacts enrichment
│       ├── scheduler/                 # Calendar sync, daily review, tickler alerts, GTD health, weekly review, message batch, agent nudge, journal consolidation, stuck-message-sweep (every 10min, flips system-channel rows stuck in pending/processing for 30+min to delivered — safety net for the case where channel MCP marks `processing` but the agent handles via push_to_user / journal / silent ack without ever using the reply tool to flip to `delivered`; tunables: stuck_message_sweep_minutes, stuck_message_after_minutes), narrative-consolidation (default ON as of 2026-05-22; disable per-user via user_settings.scheduler.narrative_consolidation_enabled=false — fires once a day at configured hour, default 3am, asks the agent to scan list_narratives for threads with ≥5 new observations since last_consolidated_at and refresh them), health polling, agent-output-monitor (May 15: sole "agent isn't keeping up" signal after channel-liveness-monitor was retired — default agent_output_silence_hours 0.5h, throttle-aware because it measures outbound flow not pending depth; May 21: journal-aware — also counts ll5_agent_journal writes as "alive" so silent work like consolidation no longer false-fires the "agent silent" critical FCM), mcp-health-monitor (every 2min: parallel `/health` HTTP probe + `tools/list` MCP probe via streamable-HTTP — failure if either errors or `tool_count === 0`; catches the "connected but cannot list tools" ghost mode that `/health` alone misses; gateway entry skips the tools probe; tools/list Bearer-authenticates with `API_KEY` when set (universal across MCPs, avoids false-positive `Invalid credentials` against MCPs without their own `AUTH_SECRET`) and falls back to a signed `generateToken` otherwise; independent ll5_app_log error-rate sweep stays as-is; 2-alert cap per episode), whatsapp-flow-monitor (ES-based "no WhatsApp in 6h" during active hours — catches Evolution ghost-connected), phone-liveness-monitor (ES-based "no GPS/phone_status in 3h" — promotes heartbeat warning to FCM critical), character-refresh (every 4h during active hours inserts a `[Character Refresh]` system message — opens with the full anchored time banner + explicit time contract (paired utc/local, today/yesterday/tomorrow resolve in session TZ), then re-asserts the two-roles persona with proactive instructions: Executor creates tasks/ticklers without asking AND records as it goes (every meaningful event → journal/note_observation; skipping is the rare logged exception) AND re-anchors two slipped habits — narrate reasoning during multi-step work (markers ≠ narration) and always reply with a one-line confirmation when a direct request is done (journal/update_*/marker ≠ reply), Coach initiates conversations and pushes user on stalled goals; agent must NOT send messages on user's behalf; no FCM push). Heartbeat now uses `timeBanner` (full date + weekday + local + TZ name + UTC); default silence threshold 30 min, chat-search-indexer (cluster-wide singleton: tails NOTIFY into ll5_chat_messages + ll5_chat_conversations ES indices with multilingual analyzer; Hebrew-safe search; at-least-once semantics keyed on message id; idempotent backfill() helper)
│       ├── processors/contact-routing.ts  # ContactRoutingResolver — routing/media resolved from contact_settings only (escalation→immediate, group by conversation_id, 1:1 by person_id). Media default differs by shape: groups OFF (opt-in), 1:1 ON (pictures unless explicitly disabled). Replaced notification-rules.ts when notification_rules was dropped (2026-05-22).
│       ├── utils/whatsapp-user-resolver.ts # Instance name → user_id mapping with 5min cache
│       ├── utils/data-source-config.ts # Per-source enabled/disabled check with 60s cache (reads user_settings JSONB)
│       ├── utils/self-names.ts        # User's own display names (user_settings.self_names, 60s cache) → message.ts flags from_me on self-authored phone-mirrored messages (Slack channels)
│       (Dashboard) packages/dashboard/src/app/(user)/settings/data-sources/data-sources-types.ts — types + DEFAULTS for the data-sources page. Extracted from data-sources-server-actions.ts on May 18 because Next.js 15 rejects non-async exports from a "use server" file.
│       ├── utils/system-message.ts    # Shared system message writer with scheduler event correlation + source routing metadata
│       ├── utils/export.ts            # Full user data export (ES + PG → JSON, no media binaries)
│       ├── utils/device-commands.ts   # Queue device command + send FCM data message
│       ├── utils/fcm-sender.ts       # FCM v1 API sender (service account JWT + OAuth2, 4-level notification). Exposes getFcmStats() — per-reason failure counter for /admin/health.fcm
│       ├── utils/scheduler-health.ts  # Per-scheduler health registry (last_ok_at, last_error_at, consecutive_failures). withSchedulerHealth() wrapper used by the 5 non-inserting monitors; inserting schedulers get implicit tracking via insertSystemMessage.
│       ├── utils/webhook-stats.ts     # Failure counter for webhook ancillary paths (phone-contact enrichment, calendar cleanup) — these were silent logger.warn before.
│       ├── utils/escalation.ts      # Conversation escalation: detect user activity in low-priority chats, 30-min attention window, scoped recent messages, resolved contact name + chat type
│       ├── utils/key-mutex.ts        # (2026-05-30 GPS-S2 G5) In-process per-key async mutex (KeyMutex + shared gatewayKeyMutex). Chains ops per key so concurrent webhooks for the same user/network don't interleave read-modify-write (transition state keyed location-state:${userId}; network upsert keyed network-obs:${userId}::${bssid}). Single-process gateway → in-memory lock suffices.
│       ├── scheduler/location-state.ts # (2026-05-30 GPS-S2 A2/A3) Shared reader for the ll5_awareness_location_state doc — getCurrentPlace() + buildLocationLine() ("Location: at/in <label> (as of <local time>)", omitted when absent or >6h stale). Used by heartbeat + daily-review.
│       ├── migrations/                # 000_schema_migrations (LEDGER — tracks applied filenames, set up Apr 21 after the 021 crash-loop, first-boot backfill detects legacy deploys). Each other file runs exactly once per DB. auth_users, chat_messages, NOTIFY trigger, notification_rules, device_commands, user_settings, contact_settings, chat_notify_source, user_management (019: role/enabled/username + families), chat_conversations (020: unified-conv table + unique partial index + 14-day dormant backfill gate), chat_reactions (021: reaction enum, display_compact, nullable content + XOR constraint — ADD CONSTRAINT guarded via DO-block since PG 16 has no ADD CONSTRAINT IF NOT EXISTS), chat_notify_and_counters (022: updated trigger maintains conv counters + new NOTIFY fields, chat_conversations archival/creation NOTIFY trigger), fix_system_channel_trigger (023: scope the trigger's conv-counter INSERT to web/android/cli only — system-channel messages are ephemeral and collided with the unique partial index, silently breaking every scheduler + escalation + whatsapp→system insert for 37h), chat_notify_metadata_kind (024: project metadata.kind into the NOTIFY payload so narrate-tool rows render as ThinkingRow live, not after a 15–30s sweep — extensible to other kinds), chat_idempotency (025: nullable idempotency_key + partial unique index (user_id, idempotency_key) — POST /chat/messages dedupes via ON CONFLICT so the conversation-unify hooks' auto-POSTs are retry/double-fire-safe), drop_notification_rules (026: unify all per-contact/per-chat settings into contact_settings — re-backfill conversation rows, best-effort migrate sender rules→person via messaging_contacts.display_name, then DROP TABLE notification_rules; keyword feature + dead rule types removed), oneonone_media_default (027: flip existing person rows to download_media=true — 1:1 chats include pictures by default; groups stay opt-in), chat_notify_scheduler (032: extend meta_proj to also project metadata.scheduler onto the NOTIFY payload, so the agent's trigger envelope carries scheduler="heartbeat"|... for the ll5-run proactivity eval recorder to tag trigger_class/source from ground truth; mirrors 024 otherwise). Conversation-unify session-mirror hooks live in ll5-run/.claude/hooks (activity-marker/stop-mirror/cli-input-mirror, flag-gated by LL5_MIRROR); web `lib/chat/constants.ts` compactIcon renders metadata.kind='activity' rows with a distinct glyph.
│       └── server.ts                  # Express app: webhooks, auth, chat, media, commands, availability check, health, schedulers. May 18: `POST /webhook` (canonical bearer-only) added alongside the deprecated `POST /webhook/:token` (emits Deprecation + Sunset headers); WhatsApp webhook route delegated to whatsapp-webhook-route.ts; /uploads gated via uploads-route.ts. 2026-06-01: `tracked_device` push item → processors/findhub.ts (processTrackedDevice).
│
├── packages/findhub-poller/           # DISABLED 2026-06-03 (Find Hub locate requests rang devices; container stopped on box, commented out of compose, removed from build-and-push.yml PACKAGES + pull loop). Python sidecar (the stack's only Python) — polls Google Find Hub via GoogleFindMyTools (pinned d46e952), POSTs `tracked_device` items to gateway /webhook. poller.py (loop + gateway POST with explicit UA — Cloudflare 403s default Python UA), findhub_client.py (ISOLATED upstream adapter — drives request_device_list/get_canonic_ids + FcmReceiver/create_location_request/nova_request WITH a timeout + a vendored decrypt loop that RETURNS locations; per-report decrypt is defensive re upstream #22 phone InvalidTag; verified live 2026-06-01, 5 trackers OK), Dockerfile (clones GoogleFindMyTools, Chrome-less — repo-root-relative COPY since CI builds context=.; secrets.json injected via FINDHUB_SECRETS_B64 env written at startup), README (TWO-login Chrome auth procedure + base64-secrets). DEPLOYED as compose service `findhub-poller` in docker/docker-compose.prod.yml (internal gateway URL); image built by build-and-push.yml (in matrix, Node steps guarded off; also in the deploy-job pull loop). Dashboard: (user)/tracked-devices/ (page + view + server-actions → awareness get_tracked_devices) + Find Hub toggle in settings/data-sources. Ops: .github/workflows/diagnose-findhub.yml (manual read-only SSH dump of poller state/logs); the deploy job in build-and-push.yml upserts FINDHUB_* (GitHub secrets) into the on-host .env before `docker compose up`. See docs/design/findhub.md + DECISION-008.
│
├── packages/google/                   # calendar MCP — unified calendar layer (PG+ES)
│   └── src/
│       ├── repositories/postgres/     # OAuth tokens (encrypted), calendar config, user settings
│       ├── repositories/elasticsearch/ # Calendar event read/write (uses .keyword for text-mapped fields)
│       ├── tools/                     # 18 tools — calendar (CRUD, sync, availability), tickler (RRULE recurring, never creates calendars), Gmail, OAuth
│       │                              # REST: /api/events, /api/ticklers, /api/auth-url, /api/connection-status
│       ├── utils/encryption.ts        # AES-256-GCM for token storage
│       └── server.ts                  # MCP server (dual auth) + OAuth callback + REST API (no OAuth discovery handlers)
│
├── packages/health/                   # @ll5/health — health monitoring MCP (ES+PG)
│   └── src/
│       ├── clients/                     # HealthSourceAdapter interface + Garmin adapter + registry. `clients/registry.ts` exports `HealthClientRegistry` class (instance-scoped Map; `register`/`get`/`list`/`clear`) plus default-instance `registry` for production callers and back-compat `registerAdapter`/`getAdapter`/`listAdapters` shims (May 18 — extracted out of process-global state so tests can isolate per-instance).
│       ├── tools/                       # 8 tools: sources (connect/disconnect/list/status), sleep, heart rate, daily stats, activities, body comp, trends, sync
│       ├── types/                       # Generic health types (SleepData, HeartRateData, DailyStatsData, StressData, ActivityData, BodyCompositionData)
│       ├── setup/indices.ts             # 5 ES indices (ll5_health_sleep, heart_rate, daily_stats, activities, body_composition)
│       ├── utils/                       # env, encryption (AES-256-GCM), logger, migration runner
│       ├── migrations/                  # health_source_credentials table
│       ├── __tests__/tools.test.ts       # source/sleep/heart-rate/daily-stats/activities/body-comp/trends/sync handler tests (Phase 0)
│       ├── __tests__/registry.test.ts    # HealthClientRegistry register/get/list/clear semantics + per-instance isolation + default-instance shim contract (May 18, 9 tests)
│       └── server.ts                    # MCP server with ES+PG, registers adapters
│
├── packages/system/                  # @ll5/system — local stdio MCP for this Mac (battery, cpu, memory, disk, system_health)
│   └── src/
│       ├── collectors.ts              # macOS shell-based collectors (pmset, vm_stat, df, ps, os module) + threshold-based health summary
│       └── index.ts                   # MCP server on StdioServerTransport, 6 tools
│
├── packages/messaging/                # @ll5/messaging — PG-backed MCP (live: mcp-messaging.noninoni.click)
│   └── src/
│       ├── clients/                   # Evolution API (WhatsApp), Telegram Bot API
│       ├── repositories/postgres/     # Accounts, conversations, contacts (with person linking). conversation repo resolves `permission` from contact_settings via join (1:1→person_id, group→JID; default 'input') — the row no longer stores it.
│       ├── tools/                     # 19 tools (send, read, sync, contacts, link, auto-match, backfill-contact-names, restart-whatsapp-account, provision-whatsapp-account, get-pairing-qr, disconnect-whatsapp-account [last 3 added May 18 for dashboard /settings/messaging Add/Re-pair/Disconnect buttons]). update-permissions.ts → update_conversation_permissions now sets contact_settings.permission (Authority), not routing.
│       ├── migrations/               # 001 tables, 002 contacts, 003 archived conversations, 004 unread_count, 005 drop_conversation_permission (authority lives in contact_settings; column orphaned since gateway 017). Run every boot, idempotent (no ledger).
│       └── server.ts
│
├── packages/dashboard/                # @ll5/dashboard — Next.js 15 web UI
│   └── src/
│       ├── app/(auth)/login/          # Login page + server action; honors ?next= with same-origin guard; LoginForm wrapped in <Suspense> so useSearchParams can bail out of SSG
│       ├── middleware.ts               # Redirects non-public pages to /login?next=<path> when ll5_token cookie is missing (catches (admin) routes) + auto-refreshes token within 2-day window via POST /auth/refresh (writes to both request.cookies and response cookie) + clears cookie & redirects to /login on hard expiry or malformed token + injects x-pathname header
│       ├── app/(user)/                # 28 pages: dashboard, calendar (+settings [Google connect/reconnect: pre-opens about:blank synchronously then sets location.href, avoids post-await popup block] +ticklers), actions, projects, inbox, shopping, people (server-side search + pagination), narratives (list with status/kind/search filters + /narratives/detail?kind=&ref= per-subject view: summary, mood, open threads, recent decisions, full observations timeline; close/dormant/reopen actions; read-only otherwise — narratives are agent-curated), knowledge, horizons, contacts (old), locations, places, media, health, journal, phone-data, sessions, export, profile, settings/ (contacts [3 tabs + link/unlink/auto-match + z-indexed popover], notifications, messaging, health, notification-levels, scheduler)
│       ├── app/(admin)/               # Admin pages: health, users, tools, logs (Datadog-style LogExplorer), audit, gps-cleanup (scan+prune ll5_awareness_locations via direct ES _delete_by_query; time-range selector + OPT-IN geo-boundary filter [gps-bounds.ts: DEFAULT_GEO_BOUNDS + isOutOfBounds(); off by default so abroad points aren't flagged; default Israel box or custom min/max lat-lon] + one-click scan-and-delete)
│       │                              #   gps-cleanup/gps-bounds.ts — pure geo-bounds helper (DEFAULT_GEO_BOUNDS, isOutOfBounds) + gps-bounds.test.ts (9 unit tests)
│       ├── app/api/chat/              # Proxy routes: messages (latest-N), conversations (list + new + active + search + [id]), upload, listen
│       ├── app/(user)/chat/page.tsx   # Full-screen "coach" chat view — thin client shell; bootstrap moved to useChatSession (cache-then-fetch). May 11: was server component with force-dynamic + two sequential cache:no-store fetches per visit; now renders ChatRoot immediately and lets the store hydrate from localStorage cache.
│       ├── components/chat/           # /chat-only components: chat-root (layout + shortcuts + overlays), message-stream (unboxed assistant + compact groups + thinking caret), composer (CLI-flavored, slash hints, paste-to-attach), conversation-list (active/archived + debounced ES search), command-palette (⌘K, fuzzy across commands + conversations), new-conversation-dialog, message-bubble (shared unboxed/bubble variants; unboxed assistant text wraps in a left-aligned speech bubble, CompactGroup label is left-aligned)
│       ├── lib/chat/                  # Shared types, reaction constants + icons, format helpers (uploadsUrl, shortTime, buildRenderItems, indexReactions) — imported by both chat-widget (dashboard tile) and the /chat view to prevent drift
│       ├── hooks/use-chat-store.ts    # Zustand store + useChatSession (cache hydrate + SSE + 15s visibility-gated sweep) + sendChatMessage/reactToMessage/startNewConversation actions. Single `ingest(source, msg)` funnel handles echo/SSE/sweep/history merge, temp-id promotion, 409 grace auto-retry, conversation_archived pivot, and the "agent answered" thinking-off signal. May 11: bootstrap reads localStorage cache (key `ll5_chat_cache_v1`, last 30 messages) on mount → paints in <50ms → in parallel fetches `/active` + `/messages?limit=30` → merges. Persists tail on every store change. First-fetch limit 200→30; sweep 200→50.
│       ├── components/                # Nav (+ Chat top-level link), cards, chat-widget (dashboard tile — unified-conversation-aware: reactions, reply-to quoting, compact rendering with 60s grouping, new-conversation dialog, 409 auto-retry; May 11: localStorage cache via shared `ll5_chat_cache_v1` key with /chat, first-fetch limit 200→30, sweep 200→50, paints in <50ms when cache hits), chat-sidebar (conversation list + debounced ES search with `<em>` highlight snippets), shadcn/ui
│       ├── lib/                       # MCP client, auth helpers, env
│       └── providers/                 # React Query
│
├── packages/shared/src/__tests__/      # 41 tests: auth token generation, validation, expiry (auth.test.ts: 21); validateLl5Token discriminated-union helper covering malformed/wrong_prefix/bad_signature/expired + role coercion + grace period (validateLl5Token.test.ts: 20, added Phase 2)
├── packages/gateway/src/__tests__/     # 174 tests: whatsapp webhook, whatsapp webhook route (auth + no-fallback), uploads-route (ownership), notification rules, chat, chat-conversations, admin API, phone contacts, getOrCreateActiveConversation retry loop
├── packages/personal-knowledge/src/__tests__/ # 77 tests: person repo (rewrote May 18 to import real ElasticsearchPersonRepository — was last theater test), people tools (real handlers via captureTools), observation repo, narrative repo
├── packages/{gtd,awareness,health,messaging,google}/src/__tests__/ # Real tool-handler tests via captureTools helper. Phase 0 (May 18) + carryforward (May 18). 32 gtd, 164 awareness (tools, tools-extra [+ LocationService recently_left/A7 + the rich where_is_user snapshot: position/trail/heading/precision + query_visits/suggest_frequent_places Stage 4], stay-point-service [Stage 4 clustering], geo-search, cross-tenant-hardening, review-batch; get_situation + where_is_user share one fused snapshot, get_current_location retired Jun 12), 44 health (2 files: tools, registry), 70 messaging (encryption, tools, account-management-tools [provision/get_pairing_qr/disconnect, added May 18], contact-settings-tools [get/set_contact_settings, added May 22], update-permissions-tool [agent-authority write → contact_settings.permission, added Jun 6]), 27 google.
│   Each package has its own __tests__/_helpers.ts with the captureTools/parseToolResponse pattern.
│   Standard documented in docs/testing.md.
│
├── docs/testing.md                     # Testing standard (May 18): one rule — tests must import + invoke real code. Boundary rules for repo / tool / route / state-machine tests, mandatory user_id assertion, references to gold-standard examples in gateway/.
├── docs/runbooks/                      # Operational runbooks. whatsapp-webhook-secret.md: full rollout + rotation procedure for WHATSAPP_WEBHOOK_SECRET. ghcr-shared-credential.md: the recurring GHCR pull `denied` bug — shared host /root/.docker/config.json clobbered by ephemeral GITHUB_TOKEN (`ghs_`) logins; root cause, durable fix (GHCR_READ_PAT), emergency recovery, diagnostics.
│
└── packages/ll5-auth/                 # @ll5/auth-cli — login/status/logout CLI
    └── src/
        ├── commands/                  # login, logout, status, setup
        └── utils/                     # config, token, prompt helpers
```
























<!-- 2026-05-23: scheduler settings page surfaces proactivity knobs (agent_output_*, narrative_consolidation, response_timeout_seconds) -->

<!-- 2026-05-24: character-refresh nudge gains habit (3) ONE VOICE — turn-final prose is the message, no third-person recaps -->

<!-- 2026-05-24: character-refresh habit (3) — answers via explicit push/reply; mirroring is backstop only -->

<!-- 2026-05-24: mirror true-backstop (skip when agent delivered via push/reply); persona prose-IS-the-answer for CLI fidelity -->

<!-- 2026-05-24: health/garmin watch battery — getDevices() + device_battery/status/last_sync/name on daily stats -->

<!-- 2026-05-24: garmin battery probe — deviceregistration lacks battery (catalog only); probing mylastused + primary-training-device -->

<!-- garmin battery-key scan probe -->

<!-- garmin: watch battery NOT exposed by web API; device={name,lastSync} from mylastused -->

<!-- health: reconnect_health_source — agent re-logins from SAVED creds (no password in chat) -->

<!-- dashboard chat: agent messages render as GitHub-flavored Markdown (tables/bold/lists/code) via components/chat/markdown.tsx -->

<!-- gateway: camera_photo push type → ll5_media(source:camera, time+gps) + agent system msg (processors/camera-photo.ts) -->

<!-- 2026-05-25 (ll5-run): agent MCP autoheal — ll5-server supervisor loop + scripts/mcp-autoheal-server.sh watcher → claude --continue on endpoint recovery edge; CI deploy joins tailnet via TS_AUTHKEY (expires ~Aug 23). Docs in HANDOFF.md. -->

<!-- 2026-05-27: gateway phone low-battery alert (packages/gateway/src/processors/battery-alert.ts — escalating 20/10/5% on discharge, resets on charge); ES bumped 1g/1.5G → 2g heap/4G in docker/docker-compose.prod.yml to stop ES-restart health cascades. -->

<!-- 2026-05-27: fix whatsapp-webhook.ts from_me enrichment — conversation_name now uses resolved contactDisplayName (was conversationName??groupName → null), so the user's outbound WhatsApp is queryable by contact name (stops the agent re-nagging on already-handled threads). -->

<!-- docs/decisions/ now spans DECISION-001..012 (007 byo-agent, 008 findhub, 009 location-consolidation, 010 browser, 011 es-auth, 012 correlation-ids/tool-ledger/session-accumulation). -->
<!-- 2026-05-29: code-quality/bug review batch (branch fix/review-batch-2026-05-29). NEW: docs/decisions/DECISION-001..006.md (scoping, calendar storage, oauth rotation, gtd completed_at, search scoring, user-salted doc ids); docs/reviews/2026-05-29/ (README audit+evidence, verification.md, per-workstream RED/GREEN .log). NEW data-repair scripts: packages/{gateway,health,google}/scripts/repair-*.ts (dry-run guarded one-offs, not in build/deploy). +20 test files across packages (calendar-merge/sync, *-scoping, cross-tenant-hardening, search-tools, api-key-auth, etc.). 28 bugs fixed incl. multi-tenant by-id scoping + unsalted-doc-id contamination vectors. -->

<!-- 2026-05-29 PM: deployed to prod + verified. gateway scheduler/calendar-sync.ts now writes the user-namespaced `${userId}::google-${id}` doc id (was legacy `google-${id}`), matching the google MCP ESCalendarEventRepository so the two calendar-event writers don't duplicate. Live synthetic-tenant probe confirmed isolation; prod data repairs R1 (437 calendar locations) + R2 (2 orphan stress docs) + R3 (1748 legacy calendar ids → scoped) applied. Results: docs/reviews/2026-05-29/verification.md (legacy=0, scoped=1748, no dups). -->

<!-- 2026-05-30: BYO-agent tenant platform. NEW design docs/design/byo-agent-tenant-platform.md + DECISION-007 (user-management.md Phase 6 superseded). Phase 1 (branch feat/tenant-p1-identity, not deployed): gateway migration 028_identity_and_invites.sql, new src/invites.ts + src/utils/email.ts (EmailSender, log default), auth.ts email/password + forgot/reset. Dashboard: (auth)/{accept-invite,forgot,reset} public pages + login email/password toggle + lib/password.ts; (admin)/admin/invites; middleware PUBLIC_PATHS extended. +26 tests. - W1: superadmin role (migration 029, requireSuperadmin, shared TokenClaims +superadmin), gateway src/tenants.ts (GET /admin/tenants[/:id]), dashboard (admin)/admin/tenants console + admin-nav link. -->>

<!-- 2026-05-30 W2: gateway GET /me/onboarding (self onboarding status, reuses tenants.ts enrichUser); dashboard (user)/onboarding rebuilt as resumable 7-step wizard with live phone/channel verification. -->

<!-- 2026-05-30 W3: gateway migration 030 + src/agent.ts (agent_credentials, agent_llm_credentials, /me/agent/* connection+llm-credential), auth.ts refresh revocation check, utils/encryption.ts encryptSecret/decryptSecret. dashboard (user)/settings/agent (API key + connection kit) + onboarding agent step wired. -->

<!-- 2026-05-30 W4 (P4/P5): NEW packages/agent-orchestrator (Runtime iface, DockerRuntime via node:http socket, MockRuntime, Orchestrator: decrypt key + 0600 env-file cred injection + capacity cap + heartbeat reconcile; HTTP API bearer-auth; docker/Dockerfile.agent-orchestrator + docker/agent-orchestrator.compose.yml for a dedicated host). gateway migration 031 agent_runtimes + src/utils/orchestrator.ts + /me/agent/{provision,stop,runtime,heartbeat} + /admin/tenants/:id/agent/* + disable/revoke lifecycle stops. dashboard /settings/agent runtime panel + tenant-console Agent column. -->

<!-- 2026-05-30 GPS-S2 (branch fix/gps-gateway-deviation, not deployed): GPS ingestion + scheduler location fixes. NEW utils/key-mutex.ts (G5 per-key async mutex) + scheduler/location-state.ts (A2/A3 location-line helper). types/push-data.ts +speed_mps/bearing_deg/altitude_m. processors/location.ts: prevPoint param + StoredPoint return (G1/G2 batch chaining), device-speed-aware drift (G6), low-accuracy stored-flagged not dropped (G9), enriched transition msg [place match]/[city-level] (A4), persists speed/bearing/altitude (G3). server.ts webhook sorts location items by timestamp + threads prevPoint, results written at original index. processors/wifi.ts caps place_observations at 20 (G8) + mutex on upsert. shared indices/awareness.ts +bearing/altitude/low_accuracy. scheduler/{heartbeat,daily-review}.ts location line; daily-review +optional es ctor arg. +5 test files (key-mutex, location-processor, wifi-observations-cap, location-state-helper, webhook-location-ordering); gateway 339 tests. -->
<!-- 2026-05-30 W5: docker/agent-runtime/ (Dockerfile.agent-tenant FROM untouched admin image + tenant-entrypoint.sh: 0600 env-file creds, agent token, ANTHROPIC_API_KEY, heartbeat + README); .github/workflows/build-agent-tenant.yml (manual). gateway SMTP EmailSender (nodemailer, SMTP_* env). orchestrator AGENT_IMAGE default -> ll5-agent-tenant:latest. -->

<!-- 2026-05-30 W5b: SMTP wired live via Brevo (Coolify gateway service env). NOTE: deploy via git push so CI scp-s the repo compose; a Coolify-MCP deploy reverts the host compose to a stale stored copy and dropped the gateway SMTP env lines. -->

<!-- 2026-05-31: AgentOutputMonitor false "agent silent" alarm fixed — journal-alive check now uses max(silenceHours,2h) window so ~hourly overnight journaling registers as alive; failsafe (no chat+no journal 2h+) preserved. scheduler/agent-output-monitor.ts + test. -->
