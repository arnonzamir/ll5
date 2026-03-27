# LL5 — Personal Assistant System

## Project Overview

A personal AI assistant built as a set of MCP servers integrated with Claude Code. The system manages personal knowledge, GTD task management, real-world awareness (GPS, IM, calendar), Google integrations, and messaging channels.

## Before You Start

Always read these documents to understand what we're building and why:

- **[Vision](docs/vision.md)** — what the system does for the user
- **[Purpose](docs/purpose.md)** — design principles and constraints

For architecture and component design, refer to the docs/design/ folder. For implementation plans, refer to docs/implementation/.

## Key Design Principles

1. **Separation of concerns** — each MCP owns one domain, no cross-MCP calls
2. **Storage abstraction** — repository interfaces, never direct DB calls; engines are swappable
3. **Multi-tenancy from day one** — every record has a user_id, every query is scoped
4. **Remote deployment** — MCPs are HTTP/SSE services, not local stdio
5. **Simplicity** — if Claude can do it in conversation, don't build infrastructure for it

## Storage

- **Elasticsearch** — personal-knowledge MCP, awareness MCP (fuzzy search, full-text, geo, schema flexibility)
- **PostgreSQL** — gtd MCP, google MCP, messaging MCP (relational queries, ACID, state transitions)
- All storage accessed through repository interfaces, never direct queries

## MCP Servers

| MCP | Storage | Domain |
|-----|---------|--------|
| personal-knowledge | Elasticsearch | Facts, people, places, preferences, data gaps |
| gtd | PostgreSQL | Actions, projects, horizons, inbox, shopping |
| awareness | Elasticsearch | GPS, IM messages, entity statuses, calendar, situational context |
| google | PostgreSQL | Google Calendar, Gmail, OAuth tokens |
| messaging | PostgreSQL | WhatsApp, Telegram send/receive |

## Additional Components

- **Gateway** — thin HTTP service receiving phone push data (GPS, IM, calendar), writes to awareness DB
- **Skills** — Claude Code slash commands for structured workflows (/review, /daily, /clarify, /engage, /sweep, /plan)
- **Scheduled triggers** — Claude Code /schedule for proactive behavior (morning review, weekly review, periodic checks)

## When Learning About the User

When the user mentions personal information (facts, people, places, preferences), store it via the personal-knowledge MCP — not in Claude Code's local memory. Claude Code memory is for working preferences about how to collaborate. Life data goes to the MCP.
