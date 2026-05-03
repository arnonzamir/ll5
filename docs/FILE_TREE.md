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
│   └── build-and-push.yml            # CI: build changed packages, push to GHCR, deploy via SSH (pulls only GHCR images, never DBs; 15min command_timeout — 5min wasn't enough under host pressure)
│
│ (ll5-run repo — client workspace — is a separate git repo.)
│ (ll5-run/ll5 launcher: exports MCP_TIMEOUT=30000, parallel /health pre-warm, then exec claude.)
│ (ll5-run/channel/ll5-channel.mjs: SSE chat bridge + MCP connectivity probe for all 6 remote MCPs)
│ (every 10min, exposes `check_mcp_connectivity` tool, rate-limited system notifications on failure.)
│ (Apr 19: simplified push_to_user (drops channel heuristic), added new_conversation + react tools,)
│ (passes reply_to_id/reaction/display_compact through SSE meta, handles conversation_archived/_created events.)
│ (May 3: added `narrate` tool — writes display_compact + metadata.kind="thinking" so web/android render asterisk-prefixed italic lines as the agent's internal voice.)
│ (May 3: dashboard chat — inline reaction strip in the hover/long-press bar (8 icons: 6 reactions + reply + copy), drops the popover. /settings/contacts column labels become Authority + Delivery, with column-specific button labels (Blocked/Read/Reply for Authority; Drop/Batch/Notify for Delivery) and a paired-bump rule that lifts the silent twin off ignore when the user opens the other column.)
│ (May 3: WhatsApp messages now carry conversation_id + conversation_name in ES; MessageBatchReviewScheduler clusters by sender|app|conversation and surfaces group name + first/last snippet per cluster in its summary.)
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
│   └── docker-compose.prod.yml       # Production reference (Coolify uses its own)
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
│       ├── types/                    # 16 domain types (fact, person, place, horizon, etc.)
│       ├── indices/                  # Canonical ES mappings for cross-package indices — awareness.ts (7 ll5_awareness_* indices + ensureAwarenessIndices helper), knowledge.ts (ll5_knowledge_networks; shared by personal-knowledge + gateway wifi processor). Prevents drift between gateway-writer and MCP-reader.
│       ├── repositories/             # 13 repository interfaces
│       ├── storage/                  # ES + PG client factories
│       ├── auth/                     # Token generate/validate, Express middleware
│       ├── mcp/                      # MCP server helpers
│       ├── audit.ts                  # ES audit writer (100% mutation coverage across all MCPs)
│       ├── app-log.ts               # ES app logger (all tool calls, errors, webhooks)
│       └── utils/                    # env, logger, errors
│
├── packages/personal-knowledge/       # @ll5/personal-knowledge — ES-backed MCP
│   └── src/
│       ├── repositories/elasticsearch/  # 6 ES repositories (fact, person, place, profile, data-gap, network)
│       ├── repositories/interfaces/     # Repository interfaces
│       ├── tools/                       # 21 MCP tools (all logged via withToolLogging) — includes networks: find_place_by_bssid, label_network, unlabel_network, list_known_networks
│       ├── __tests__/                   # 41 tests: person repo, people tools
│       ├── setup/indices.ts             # ES index creation (6 indices: profile, facts, people, places, data_gaps, networks)
│       └── server.ts                    # MCP server with StreamableHTTP + AsyncLocalStorage (auth from @ll5/shared)
│
├── packages/gtd/                      # @ll5/gtd — PG-backed MCP (45 tests)
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
│       ├── repositories/elasticsearch/  # 7 ES repositories (location, message, entity-status, calendar, notable, phone-status, wifi)
│       ├── services/                    # LocationService — fuses GPS + wifi BSSID → CurrentLocation with provenance (used by get_current_location + where_is_user tools)
│       ├── tools/                       # 22 MCP tools (situation, location+delete+where_is_user, messages, journal, user model+versioning, geo search, media, phone_status x2, wifi x2)
│       ├── setup/indices.ts             # Shared 7 awareness indices imported from @ll5/shared + 4 awareness-exclusive (journal, user_model, media, media_links)
│       └── server.ts
│
├── packages/gateway/                  # @ll5/gateway — Express HTTP service
│   └── src/
│       ├── admin.ts                    # Admin CRUD: /admin/users (list/get/create/patch/pin/delete), /admin/families (list/create/members)
│       ├── auth.ts                    # POST /auth/token (PIN + username login, rate limiting), POST /auth/refresh (token refresh)
│       ├── chat.ts                    # /chat/* REST + SSE listen endpoint; unified-conversation routing (active LL5-native conv per user via chat_conversations, unique partial index), 30s grace + 409 on archived writes, /chat/conversations/new (atomic archive+open), /chat/conversations/search (ES-first + ILIKE fallback), reactions (semantic enum, XOR with content), display_compact flag, NOTIFY over chat_messages + chat_conversations channels
│       ├── processors/                # GPS geocoding, IM processing, calendar (dedup + enrich), WhatsApp webhook (images, fromMe, pushName enrichment, group participant enrichment, LID→phone mapping), WhatsApp contact webhook (CONTACTS_UPSERT/UPDATE), routing rule matcher, phone contacts enrichment
│       ├── scheduler/                 # Calendar sync, daily review, tickler alerts, GTD health, weekly review, message batch, agent nudge, journal consolidation, health polling, mcp-health-monitor (2min /health + tool-error-rate; 2-alert cap per episode), channel-liveness-monitor (pending-inbound stall; 2-alert cap per episode), whatsapp-flow-monitor (ES-based "no WhatsApp in 6h" during active hours — catches Evolution ghost-connected), phone-liveness-monitor (ES-based "no GPS/phone_status in 3h" — promotes heartbeat warning to FCM critical), agent-output-monitor (compares `channel='system'` inbound count over lookback window against last assistant-outbound timestamp; alerts when schedulers are firing but the agent hasn't replied in N hours — catches "channel drains but agent silent"), character-refresh (every 4h during active hours inserts a `[Character Refresh]` system message — opens with the full anchored time banner + explicit time contract (paired utc/local, today/yesterday/tomorrow resolve in session TZ), then re-asserts the two-roles persona with proactive instructions: Executor creates tasks/ticklers without asking, Coach initiates conversations and pushes user on stalled goals; agent must NOT send messages on user's behalf; no FCM push). Heartbeat now uses `timeBanner` (full date + weekday + local + TZ name + UTC); default silence threshold 30 min, mcp-status-pulse (temp: 2h notify-level summary, expires 2026-04-21), chat-search-indexer (cluster-wide singleton: tails NOTIFY into ll5_chat_messages + ll5_chat_conversations ES indices with multilingual analyzer; Hebrew-safe search; at-least-once semantics keyed on message id; idempotent backfill() helper)
│       ├── processors/notification-rules.ts  # Priority matcher (sender/app/keyword/group/wildcard)
│       ├── utils/whatsapp-user-resolver.ts # Instance name → user_id mapping with 5min cache
│       ├── utils/data-source-config.ts # Per-source enabled/disabled check with 60s cache (reads user_settings JSONB)
│       ├── utils/system-message.ts    # Shared system message writer with scheduler event correlation + source routing metadata
│       ├── utils/export.ts            # Full user data export (ES + PG → JSON, no media binaries)
│       ├── utils/device-commands.ts   # Queue device command + send FCM data message
│       ├── utils/fcm-sender.ts       # FCM v1 API sender (service account JWT + OAuth2, 4-level notification). Exposes getFcmStats() — per-reason failure counter for /admin/health.fcm
│       ├── utils/scheduler-health.ts  # Per-scheduler health registry (last_ok_at, last_error_at, consecutive_failures). withSchedulerHealth() wrapper used by the 5 non-inserting monitors; inserting schedulers get implicit tracking via insertSystemMessage.
│       ├── utils/webhook-stats.ts     # Failure counter for webhook ancillary paths (phone-contact enrichment, calendar cleanup) — these were silent logger.warn before.
│       ├── utils/escalation.ts      # Conversation escalation: detect user activity in low-priority chats, 30-min attention window, scoped recent messages, resolved contact name + chat type
│       ├── migrations/                # 000_schema_migrations (LEDGER — tracks applied filenames, set up Apr 21 after the 021 crash-loop, first-boot backfill detects legacy deploys). Each other file runs exactly once per DB. auth_users, chat_messages, NOTIFY trigger, notification_rules, device_commands, user_settings, contact_settings, chat_notify_source, user_management (019: role/enabled/username + families), chat_conversations (020: unified-conv table + unique partial index + 14-day dormant backfill gate), chat_reactions (021: reaction enum, display_compact, nullable content + XOR constraint — ADD CONSTRAINT guarded via DO-block since PG 16 has no ADD CONSTRAINT IF NOT EXISTS), chat_notify_and_counters (022: updated trigger maintains conv counters + new NOTIFY fields, chat_conversations archival/creation NOTIFY trigger), fix_system_channel_trigger (023: scope the trigger's conv-counter INSERT to web/android/cli only — system-channel messages are ephemeral and collided with the unique partial index, silently breaking every scheduler + escalation + whatsapp→system insert for 37h), chat_notify_metadata_kind (024: project metadata.kind into the NOTIFY payload so narrate-tool rows render as ThinkingRow live, not after a 15–30s sweep — extensible to other kinds)
│       └── server.ts                  # Express app: webhooks, auth, chat, media, commands, availability check, health, schedulers
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
│       ├── clients/                     # HealthSourceAdapter interface + Garmin adapter (garmin-connect npm + connectapi.garmin.com direct API)
│       ├── tools/                       # 8 tools: sources (connect/disconnect/list/status), sleep, heart rate, daily stats, activities, body comp, trends, sync
│       ├── types/                       # Generic health types (SleepData, HeartRateData, DailyStatsData, StressData, ActivityData, BodyCompositionData)
│       ├── setup/indices.ts             # 5 ES indices (ll5_health_sleep, heart_rate, daily_stats, activities, body_composition)
│       ├── utils/                       # env, encryption (AES-256-GCM), logger, migration runner
│       ├── migrations/                  # health_source_credentials table
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
│       ├── repositories/postgres/     # Accounts, conversations, contacts (with person linking)
│       ├── tools/                     # 16 tools (send, read, sync, contacts, link, auto-match, backfill-contact-names, restart-whatsapp-account)
│       ├── migrations/               # 001 tables, 002 contacts, 003 archived conversations
│       └── server.ts
│
├── packages/dashboard/                # @ll5/dashboard — Next.js 15 web UI
│   └── src/
│       ├── app/(auth)/login/          # Login page + server action; honors ?next= with same-origin guard; LoginForm wrapped in <Suspense> so useSearchParams can bail out of SSG
│       ├── middleware.ts               # Redirects non-public pages to /login?next=<path> when ll5_token cookie is missing (catches (admin) routes) + auto-refreshes token within 2-day window via POST /auth/refresh (writes to both request.cookies and response cookie) + clears cookie & redirects to /login on hard expiry or malformed token + injects x-pathname header
│       ├── app/(user)/                # 27 pages: dashboard, calendar (+settings [Google connect/reconnect: pre-opens about:blank synchronously then sets location.href, avoids post-await popup block] +ticklers), actions, projects, inbox, shopping, people (server-side search + pagination), knowledge, horizons, contacts (old), locations, places, media, health, journal, phone-data, sessions, export, profile, settings/ (contacts [3 tabs + link/unlink/auto-match + z-indexed popover], notifications, messaging, health, notification-levels, scheduler)
│       ├── app/(admin)/               # Admin pages: health, users, tools, logs (Datadog-style LogExplorer), audit, gps-cleanup (scan+prune ll5_awareness_locations via direct ES _delete_by_query; time-range selector + outside-Israel bbox filter + one-click scan-and-delete)
│       ├── app/api/chat/              # Proxy routes: messages (latest-N), conversations (list + new + active + search + [id]), upload, listen
│       ├── app/(user)/chat/page.tsx   # Full-screen "coach" chat view — server component seeds initial convo + history, renders <ChatRoot/>
│       ├── components/chat/           # /chat-only components: chat-root (layout + shortcuts + overlays), message-stream (unboxed assistant + compact groups + thinking caret), composer (CLI-flavored, slash hints, paste-to-attach), conversation-list (active/archived + debounced ES search), command-palette (⌘K, fuzzy across commands + conversations), new-conversation-dialog, message-bubble (shared unboxed/bubble variants)
│       ├── lib/chat/                  # Shared types, reaction constants + icons, format helpers (uploadsUrl, shortTime, buildRenderItems, indexReactions) — imported by both chat-widget (dashboard tile) and the /chat view to prevent drift
│       ├── hooks/use-chat-store.ts    # Zustand store + useChatSession (SSE + 15s visibility-gated sweep) + sendChatMessage/reactToMessage/startNewConversation actions. Single `ingest(source, msg)` funnel handles echo/SSE/sweep/history merge, temp-id promotion, 409 grace auto-retry, conversation_archived pivot, and the "agent answered" thinking-off signal.
│       ├── components/                # Nav (+ Chat top-level link), cards, chat-widget (unified-conversation-aware: reactions, reply-to quoting, compact rendering with 60s grouping, new-conversation dialog, 409 auto-retry — dashboard tile, unchanged), chat-sidebar (conversation list + debounced ES search with `<em>` highlight snippets), shadcn/ui
│       ├── lib/                       # MCP client, auth helpers, env
│       └── providers/                 # React Query
│
├── packages/shared/src/__tests__/      # 21 tests: auth token generation, validation, expiry
├── packages/gateway/src/__tests__/     # 113 tests: whatsapp webhook, notification rules, chat, admin API, phone contacts
│
└── packages/ll5-auth/                 # @ll5/auth-cli — login/status/logout CLI
    └── src/
        ├── commands/                  # login, logout, status, setup
        └── utils/                     # config, token, prompt helpers
```
















