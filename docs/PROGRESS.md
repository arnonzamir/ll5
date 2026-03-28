# LL5 Progress

Current state of the LL5 personal assistant system.

---

## Current Status

**Phase:** Core system operational, dashboard live, chat bridge working

### Deployed Services (Coolify @ 95.216.23.208)

| Service | Status | URL |
|---------|--------|-----|
| personal-knowledge MCP | Live | mcp-knowledge.noninoni.click |
| gtd MCP | Live | mcp-gtd.noninoni.click |
| awareness MCP | Live | mcp-awareness.noninoni.click |
| gateway | Live | gateway.noninoni.click |
| dashboard | Live | ll5.noninoni.click |
| Elasticsearch 8.15.0 | Healthy | internal |
| PostgreSQL 16 | Healthy | internal |

### Built, Ready to Deploy

| Service | Notes |
|---------|-------|
| google MCP | Needs Google OAuth credentials |
| messaging MCP | Needs Evolution API URL |

### Client (ll5-run)

| Component | Status |
|-----------|--------|
| MCP connections (3) | Working |
| GTD skills (6) | Written |
| Welcome launcher | Working |
| Chat bridge (SSE listener) | Working |
| Stop/FileChanged hooks | Configured |
| Auth (signed tokens + PIN) | Working |

## Tool Count

| MCP | Tools |
|-----|-------|
| personal-knowledge | 17 |
| gtd | 14 + 3 chat |
| awareness | 8 |
| google | 9 |
| messaging | 8 |
| **Total** | **59** |

## Recent Changes

- 2026-03-29: Location map page with Leaflet, clustering, timeline slider, trail visualization
- 2026-03-29: Shopping list fixed to parse grouped MCP response
- 2026-03-29: All dashboard pages: search, edit/delete, profile page
- 2026-03-29: Channel MCP bridge (replaces file-watcher approach) for real-time chat
- 2026-03-29: Android companion app with chat, location tracking, notification capture
- 2026-03-28: Chat message queue with PG LISTEN/NOTIFY + SSE
- 2026-03-28: Dashboard deployed with chat panel (50/50 split)
- 2026-03-28: Auth token system with role in payload
- 2026-03-28: All 5 MCPs built, 4 deployed
- 2026-03-28: Coolify infrastructure set up
- 2026-03-27: Design docs, monorepo foundation, first MCPs

## Known Issues

- Dashboard MCP client sometimes gets stale responses (needs cache-busting)
- FileChanged hook replaced by Channel MCP (channel approach works reliably)
- Gateway SSE listener needs reconnect-on-error improvement
- No automated deploy step with SSH keys in GitHub secrets (manual deploy works)

## Tech Debt

- personal-knowledge and gtd MCPs have duplicated auth-middleware.ts (should use @ll5/shared)
- ES indices use 8.15.0 (not latest) due to server cache
- No tests for any MCP or gateway
- Dashboard pages fully implemented (no more stubs)
- Leaflet packages added to dashboard but lockfile was out of sync (fixed)
