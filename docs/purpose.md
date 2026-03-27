# Purpose and Design Principles

Why this system exists and the rules that govern how it's built.

---

## Why

The original system (ll4/mcps) proved the concept: a personal AI assistant powered by a structured knowledge base, GTD methodology, and multi-channel communication. But it was a monolith — a single NestJS application with 4 databases, a custom agent loop, intent classification, response validation, multi-model routing, and channel adapters.

This redesign strips it to essentials. Claude Code is the agent. MCP servers are the data layer. Skills are the workflows. Everything else was scaffolding that Claude makes unnecessary.

---

## Architecture Principles

### Separation of Concerns

Each MCP server owns one domain. It manages its own storage, exposes its own tools, and knows nothing about the others. The agent (Claude Code) is the only thing that sees across domains.

No MCP calls another MCP. No MCP knows about Claude Code. No storage engine is shared between MCPs.

### Storage Abstraction

Every MCP accesses storage through a repository interface, never through direct database calls. The interface defines operations (find, create, update, delete, search). The implementation chooses the engine.

This means:
- Swapping Elasticsearch for OpenSearch, Typesense, or Meilisearch requires only a new repository implementation
- Swapping PostgreSQL for MySQL, SQLite, or CockroachDB requires only a new repository implementation
- Tests run against in-memory implementations
- No ORM lock-in, no query builder lock-in

### Simplicity Over Cleverness

Fewer moving parts. No custom event systems, no internal message buses, no background processing pipelines. If Claude can do it in conversation, don't build infrastructure for it.

The question for every component: "Does this need to exist, or can Claude handle it?"

### Multi-Tenancy from Day One

Every record has a `user_id`. Every MCP tool receives a user context. Every query is scoped. Every index is filtered. This is not negotiable — retrofitting multi-tenancy is one of the hardest things in software.

Single-user today, multi-user tomorrow. The data model doesn't change.

### Remote-First Deployment

MCPs run as remote services (HTTP/SSE transport), not local stdio processes. They're containerized, deployed behind auth, and accessible from any Claude Code client. The user's laptop doesn't need to run anything except Claude Code itself.

### Build Once, Deploy Anywhere

Docker images are built in CI (GitHub Actions) and pushed to a registry. Coolify (or any orchestrator) pulls pre-built images. No building on the deployment server. No compiling in production.

---

## Technology Choices

| Component | Technology | Why |
|-----------|-----------|-----|
| Agent | Claude Code | It IS the agent. No custom loop needed. |
| MCP transport | HTTP + SSE (remote) | MCPs are services, not local processes |
| Document storage | Elasticsearch | Fuzzy search, full-text, schema flexibility, geo queries |
| Relational storage | PostgreSQL | ACID, relational queries, proven at scale |
| MCP runtime | Node.js / TypeScript | Matches MCP SDK ecosystem, team familiarity |
| Containerization | Docker | Standard, works everywhere |
| CI/CD | GitHub Actions | Build images, push to GHCR |
| Deployment | Coolify | Pull pre-built images, manage containers |
| Containers (infra) | Elasticsearch + PostgreSQL | Managed by Coolify on the server |

---

## What This Document Governs

All design and implementation decisions should be checked against these principles. If a proposal violates separation of concerns, introduces unnecessary complexity, or couples to a specific storage engine — it needs a strong justification.

When in doubt, refer to the [Vision](./vision.md) for what we're building and this document for how we build it.
