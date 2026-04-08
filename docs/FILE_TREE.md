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
│   └── build-and-push.yml            # CI: build changed packages, push to GHCR, auto-deploy via appleboy/ssh-action
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
├── packages/shared/                   # @ll5/shared — types, interfaces, utilities
│   └── src/
│       ├── types/                    # 16 domain types (fact, person, place, horizon, etc.)
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
│       ├── repositories/elasticsearch/  # 5 ES repositories (fact, person, place, profile, data-gap)
│       ├── repositories/interfaces/     # Repository interfaces
│       ├── tools/                       # 17 MCP tools (all logged via withToolLogging)
│       ├── __tests__/                   # 41 tests: person repo, people tools
│       ├── setup/indices.ts             # ES index creation
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
│       ├── repositories/elasticsearch/  # 5 ES repositories (location, message, entity-status, calendar, notable)
│       ├── tools/                       # 17 MCP tools (situation, location+delete, messages, journal, user model+versioning, geo search, media)
│       ├── setup/indices.ts
│       └── server.ts
│
├── packages/gateway/                  # @ll5/gateway — Express HTTP service
│   └── src/
│       ├── admin.ts                    # Admin CRUD: /admin/users (list/get/create/patch/pin/delete), /admin/families (list/create/members)
│       ├── auth.ts                    # POST /auth/token (PIN + username login, rate limiting), POST /auth/refresh (token refresh)
│       ├── chat.ts                    # /chat/* REST + SSE listen endpoint
│       ├── processors/                # GPS geocoding, IM processing, calendar (dedup + enrich), WhatsApp webhook (images, fromMe capture, pushName enrichment, source routing), routing rule matcher
│       ├── scheduler/                 # Calendar sync, daily review, tickler alerts, GTD health, weekly review, message batch, agent nudge (journal+proactivity), journal consolidation, health polling
│       ├── processors/notification-rules.ts  # Priority matcher (sender/app/keyword/group/wildcard)
│       ├── utils/whatsapp-user-resolver.ts # Instance name → user_id mapping with 5min cache
│       ├── utils/data-source-config.ts # Per-source enabled/disabled check with 60s cache (reads user_settings JSONB)
│       ├── utils/system-message.ts    # Shared system message writer with scheduler event correlation + source routing metadata
│       ├── utils/export.ts            # Full user data export (ES + PG → JSON, no media binaries)
│       ├── utils/device-commands.ts   # Queue device command + send FCM data message
│       ├── utils/fcm-sender.ts       # FCM v1 API sender (service account JWT + OAuth2, 4-level notification)
│       ├── utils/escalation.ts      # Conversation escalation: detect user activity in low-priority chats, 30-min attention window
│       ├── migrations/                # auth_users, chat_messages, NOTIFY trigger, notification_rules, device_commands, user_settings, contact_settings, chat_notify_source, user_management (019: role/enabled/username + families)
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
├── packages/messaging/                # @ll5/messaging — PG-backed MCP (live: mcp-messaging.noninoni.click)
│   └── src/
│       ├── clients/                   # Evolution API (WhatsApp), Telegram Bot API
│       ├── repositories/postgres/     # Accounts, conversations, contacts (with person linking)
│       ├── tools/                     # 14 tools (send, read, sync, contacts, link, auto-match)
│       ├── migrations/               # 001 tables, 002 contacts, 003 archived conversations
│       └── server.ts
│
├── packages/dashboard/                # @ll5/dashboard — Next.js 15 web UI
│   └── src/
│       ├── app/(auth)/login/          # Login page + server action
│       ├── middleware.ts               # Injects x-pathname header for server-side route detection
│       ├── app/(user)/                # 27 pages: dashboard, calendar (+settings +ticklers), actions, projects, inbox, shopping, people, knowledge, horizons, contacts (old), locations, places, media, health, journal, phone-data, sessions, export, profile, settings/ (contacts [3 tabs + link/unlink/auto-match], notifications, messaging, health, notification-levels, scheduler)
│       ├── app/(admin)/               # Admin pages: health, users, tools, logs (Datadog-style LogExplorer), audit
│       ├── app/api/chat/              # Proxy routes: messages (latest-N), conversations
│       ├── components/                # Nav (Calendar/Organize/People/Data dropdowns, profile menu), cards, chat widget, shadcn/ui
│       ├── lib/                       # MCP client, auth helpers, env
│       └── providers/                 # React Query
│
├── packages/shared/src/__tests__/      # 21 tests: auth token generation, validation, expiry
├── packages/gateway/src/__tests__/     # 106 tests: whatsapp webhook, notification rules, chat, admin API
│
└── packages/ll5-auth/                 # @ll5/auth-cli — login/status/logout CLI
    └── src/
        ├── commands/                  # login, logout, status, setup
        └── utils/                     # config, token, prompt helpers
```








