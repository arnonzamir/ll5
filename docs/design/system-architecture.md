# System Architecture

High-level architecture, component topology, data flows, and deployment model.

---

## Topology

```
┌─────────────────────────────────────────────────────────┐
│                      Claude Code                         │
│                                                          │
│  CLAUDE.md ─ personality, GTD coaching, autonomy rules   │
│  Skills ─ /review, /daily, /clarify, /engage, /sweep     │
│  Scheduled Triggers ─ morning review, weekly review,     │
│                        proactive checks                  │
│                                                          │
└──┬──────┬──────┬──────┬──────┬───────────────────────────┘
   │      │      │      │      │  MCP protocol (HTTP+SSE)
   │      │      │      │      │
┌──┴───┐┌─┴──┐┌──┴──┐┌──┴─┐┌───┴────┐
│person││gtd ││aware││goog││messag- │
│-al   ││    ││-ness││-le ││ ing    │
│knowl.││    ││     ││    ││        │
└──┬───┘└─┬──┘└──┬──┘└──┬─┘└───┬────┘
   │      │      │      │      │
   ES    PG     ES     PG     PG
                 ▲
                 │ writes
          ┌──────┴──────┐
          │   Gateway    │  ← Phone pushes GPS, IM, calendar
          │  (HTTP svc)  │
          └──────────────┘
```

---

## Components

### Claude Code (Agent Layer)

Claude Code IS the agent. It handles:
- Conversation management and context
- Intent understanding (no custom classifier needed)
- Tool selection and orchestration
- Multi-turn workflows via Skills
- Memory for working preferences
- Scheduling for proactive behavior

Claude Code connects to all five MCPs via HTTP+SSE transport. Each MCP appears as a set of tools Claude can call.

### MCP Servers (Data Layer)

Five independent MCP servers, each owning a single domain:

| MCP | Domain | Storage | Reason |
|-----|--------|---------|--------|
| `personal-knowledge` | Identity, facts, people, places, preferences, data gaps | Elasticsearch | Fuzzy search, full-text, schema flexibility |
| `gtd` | Actions, projects, horizons 0-5, inbox, shopping list | PostgreSQL | Relational queries, precise state, ACID |
| `awareness` | GPS, IM notifications, entity statuses, calendar events, situational context | Elasticsearch | Time-series, geo queries, text search |
| `google` | Google Calendar, Gmail, OAuth tokens | PostgreSQL | OAuth token management, config |
| `messaging` | WhatsApp (Evolution API), Telegram (Bot API) | PostgreSQL | Account config, conversation state |

### Gateway (Ingestion Layer)

A thin HTTP service that receives push data from the user's phone:
- GPS locations → reverse geocode, match against known places, store
- IM notifications → store with sender, app, timestamp
- Calendar events → store with source

The gateway writes to the same Elasticsearch index that the `awareness` MCP reads. It does no AI processing — just receives, enriches (geocoding), and stores.

### Skills (Workflow Layer)

Claude Code skills (slash commands) that orchestrate multi-turn structured interactions:

| Skill | Purpose | Key MCP calls |
|-------|---------|---------------|
| `/review` | Weekly GTD review (6 phases) | gtd, awareness, google |
| `/daily` | Morning summary | gtd, awareness, google |
| `/clarify` | Inbox processing, one item at a time | gtd |
| `/engage` | "What should I do now?" recommendations | gtd, awareness |
| `/sweep` | Mind dump by life category | gtd |
| `/plan` | Natural Planning Model for a project | gtd, personal-knowledge |

### Scheduled Triggers

Claude Code's `/schedule` feature runs prompts on cron schedules:

| Trigger | Schedule | Purpose |
|---------|----------|---------|
| Morning review | `0 8 * * *` | Daily summary via `/daily` |
| Weekly review | `0 10 * * 6` | Weekly review via `/review` |
| Proactive check | `*/5 8-22 * * *` | Check for notable events, overdue items |
| Night check | `*/30 22-8 * * *` | Reduced frequency overnight |

---

## Data Flows

### User Conversation Flow

```
User message
  → Claude Code processes (understands intent, loads context)
  → Calls MCP tools as needed
    → personal-knowledge: read/write facts, people, places
    → gtd: create actions, list projects, process inbox
    → awareness: get situation, get calendar
    → google: calendar events, emails
    → messaging: send messages
  → Claude responds
  → If user mentioned personal info → write to personal-knowledge MCP
```

### Phone Push Flow

```
Phone (Tasker/Shortcuts)
  → POST /webhook to Gateway
  → Gateway processes:
    - GPS: reverse geocode, match known places
    - IM: parse sender, app, content
    - Calendar: parse event details
  → Write to Elasticsearch (awareness index)
  → Next proactive check picks up notable events
```

### Proactive Flow

```
Cron trigger fires (every 5 min)
  → Claude Code runs proactive check prompt
  → Calls awareness MCP: get_notable_events()
  → Calls gtd MCP: get_gtd_health()
  → If anything noteworthy:
    - Notable location change → surface relevant actions
    - Overdue items → gentle mention
    - Upcoming calendar event → prep reminder
    - Stale waiting-for → suggest follow-up
  → Deliver via appropriate channel
```

### Learning Flow

```
During conversation, Claude notices personal information:
  → "I'm vegetarian" → call upsert_fact(type: preference, ...)
  → "My sister Dana" → call upsert_person(name: Dana, relationship: sister)
  → "I work from home on Tuesdays" → call upsert_fact(type: habit, ...)

During proactive check, new IM messages processed:
  → "Mom says she's at the doctor" → call update entity status
  → "Nitai says timeline is delayed" → surface in next interaction
```

---

## Authentication and Multi-Tenancy

See [Auth and Multi-Tenancy](./auth-and-multitenancy.md) for details.

Summary:
- Each MCP authenticates requests via API key or JWT
- Every tool call includes a user context (user_id)
- Every database query is scoped to the user
- Elasticsearch uses filtered aliases or query-time filtering per user
- PostgreSQL uses user_id columns with row-level scoping
- The gateway authenticates via webhook tokens (one per user)

---

## Deployment Model

See [Deployment Plan](../implementation/deployment.md) for details.

Summary:
- Docker images built in GitHub Actions, pushed to GHCR
- Coolify pulls pre-built images (no building on server)
- Infrastructure containers (Elasticsearch, PostgreSQL) managed by Coolify
- Each MCP is a separate container
- Gateway is a separate container
- All containers on one Docker network for internal communication
- MCPs exposed via reverse proxy with TLS
