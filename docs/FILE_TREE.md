# LL5 File Tree

Annotated source tree of the ll5 monorepo.

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
│   ├── Dockerfile.gateway            # Gateway-specific Dockerfile
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
│   │   ├── mcp-awareness.md          # 8 tools, ES indices
│   │   ├── mcp-google.md             # 9 tools, OAuth
│   │   ├── mcp-messaging.md          # 8 tools, WhatsApp/Telegram
│   │   ├── gateway.md                # Webhook receiver design
│   │   ├── skills.md                 # Claude Code skill designs
│   │   ├── claude-personality.md     # GTD coaching, autonomy, emotional contract
│   │   └── ui-design.md             # Dashboard: user + admin pages
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
│       ├── audit.ts                  # ES audit writer (mutations)
│       ├── app-log.ts               # ES app logger (all tool calls, errors, webhooks)
│       └── utils/                    # env, logger, errors
│
├── packages/personal-knowledge/       # @ll5/personal-knowledge — ES-backed MCP
│   └── src/
│       ├── repositories/elasticsearch/  # 5 ES repositories (fact, person, place, profile, data-gap)
│       ├── repositories/interfaces/     # Repository interfaces
│       ├── tools/                       # 17 MCP tools
│       ├── setup/indices.ts             # ES index creation
│       ├── auth-middleware.ts           # Token + legacy auth
│       └── server.ts                    # MCP server with StreamableHTTP
│
├── packages/gtd/                      # @ll5/gtd — PG-backed MCP
│   └── src/
│       ├── repositories/postgres/       # 3 PG repositories (horizon, inbox, review-session)
│       ├── repositories/interfaces/     # Repository interfaces
│       ├── tools/                       # 14 GTD tools + 3 chat tools
│       ├── migrations/                  # SQL: gtd_horizons, gtd_inbox, gtd_review_sessions
│       ├── auth-middleware.ts
│       └── server.ts
│
├── packages/awareness/                # @ll5/awareness — ES-backed MCP
│   └── src/
│       ├── repositories/elasticsearch/  # 5 ES repositories (location, message, entity-status, calendar, notable)
│       ├── tools/                       # 10 MCP tools (situation, location, messages, journal, user model, etc.)
│       ├── setup/indices.ts
│       └── server.ts
│
├── packages/gateway/                  # @ll5/gateway — Express HTTP service
│   └── src/
│       ├── auth.ts                    # POST /auth/token (PIN login)
│       ├── chat.ts                    # /chat/* REST + SSE listen endpoint
│       ├── processors/                # GPS geocoding, IM processing, calendar (dedup), WhatsApp webhook, unified rule matcher (4 levels + conversation type)
│       ├── scheduler/                 # Calendar sync, daily review, tickler alerts, GTD health, weekly review, message batch, journal consolidation
│       ├── processors/notification-rules.ts  # Priority matcher (sender/app/keyword/group/wildcard)
│       ├── utils/system-message.ts    # Shared system message writer with dedup
│       ├── utils/device-commands.ts   # Queue device command + send FCM data message
│       ├── utils/fcm-sender.ts       # FCM v1 API sender (service account JWT + OAuth2, includes notification_level in data payload)
│       ├── migrations/                # auth_users, chat_messages, NOTIFY trigger, notification_rules (unified 4-level), device_commands
│       └── server.ts                  # Express app: webhooks, auth, chat, media, commands, availability check, health, schedulers
│
├── packages/google/                   # calendar MCP — unified calendar layer (PG+ES)
│   └── src/
│       ├── repositories/postgres/     # OAuth tokens (encrypted), calendar config, user settings
│       ├── repositories/elasticsearch/ # Calendar event read/write (uses .keyword for text-mapped fields)
│       ├── tools/                     # 18 tools — calendar (CRUD, sync, availability 3-path, tickler), Gmail, OAuth
│       ├── utils/encryption.ts        # AES-256-GCM for token storage
│       └── server.ts                  # MCP server (dual auth) + OAuth callback + REST API
│
├── packages/health/                   # @ll5/health — health monitoring MCP (ES+PG)
│   └── src/
│       ├── clients/                     # HealthSourceAdapter interface + Garmin adapter (garmin-connect npm)
│       ├── tools/                       # 8 tools: sources (connect/disconnect/list/status), sleep, heart rate, daily stats, activities, body comp, trends, sync
│       ├── types/                       # Generic health types (SleepData, HeartRateData, DailyStatsData, StressData, ActivityData, BodyCompositionData)
│       ├── setup/indices.ts             # 5 ES indices (ll5_health_sleep, heart_rate, daily_stats, activities, body_composition)
│       ├── utils/                       # env, encryption (AES-256-GCM), logger, migration runner
│       ├── migrations/                  # health_source_credentials table
│       └── server.ts                    # MCP server with ES+PG, registers adapters
│
├── packages/messaging/                # @ll5/messaging — PG-backed MCP [not deployed]
│   └── src/
│       ├── clients/                   # Evolution API (WhatsApp), Telegram Bot API
│       ├── repositories/postgres/     # Accounts, conversations
│       ├── tools/                     # 8 tools (send, read, sync, permissions)
│       ├── migrations/               # 001 tables, 002 contacts, 003 archived conversations
│       └── server.ts
│
├── packages/dashboard/                # @ll5/dashboard — Next.js 15 web UI
│   └── src/
│       ├── app/(auth)/login/          # Login page + server action
│       ├── app/(user)/                # dashboard, calendar, actions, projects, inbox, shopping, people (grouped filter), locations, places, media, health (browsing+settings), phone-data, sessions, settings (notifications, messaging, health), profile
│       ├── app/(admin)/               # Admin pages: health, users, tools
│       ├── app/api/chat/              # Proxy routes: messages (latest-N), conversations
│       ├── components/                # Nav (grouped menu, profile dropdown), cards, chat widget (SSE real-time + status + typing), shadcn/ui
│       ├── lib/                       # MCP client, auth helpers, env
│       └── providers/                 # React Query
│
└── packages/ll5-auth/                 # @ll5/auth-cli — login/status/logout CLI
    └── src/
        ├── commands/                  # login, logout, status, setup
        └── utils/                     # config, token, prompt helpers
```
