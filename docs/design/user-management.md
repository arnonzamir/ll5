# LL5 User Management -- Full Implementation Plan

## Current State Summary

After thorough exploration, here is the precise state of the system:

**Auth infrastructure:**
- `auth_users` PG table with: `id` (PK), `user_id` (UUID, unique), `pin_hash`, `name`, `token_ttl_days`, `created_at`. The `role` column exists in the runtime (queried in `auth.ts` line 32) but is missing from the migration `001_auth_users.sql` -- it was added manually to the production DB.
- Token format: `ll5.<base64url_payload>.<32char_hex_hmac>` with payload `{uid, role, iat, exp}`.
- Single auth endpoint: `POST /auth/token` (PIN + user_id -> token).
- No user CRUD endpoints exist on the gateway.

**Dashboard:**
- Admin users page (`/admin/users/page.tsx`) is a placeholder -- shows current user's token info and a stub message "User management requires a gateway admin endpoint."
- Login form takes raw `user_id` (UUID) + PIN.
- Profile page reads display name from the `personal-knowledge` MCP's `get_profile` tool.

**Multi-user readiness:**
- Every data store (ES indices, PG tables) includes `user_id` and all queries filter by it. Data isolation is fully built in.
- Auth middleware on all MCPs extracts `userId` from the token and injects it into the request.
- However: the `currentUserId` pattern in MCPs (e.g., `awareness/src/server.ts` line 22, `gtd/src/server.ts` line 20) uses a module-level variable, not `AsyncLocalStorage`. This is a concurrency hazard under concurrent requests from different users.

**Scheduler -- single user hardcoded:**
- `scheduler/index.ts` line 23: `const userId = Object.values(config.webhookTokens)[0]` -- takes only the first user.
- All 10+ schedulers receive a single `userId` at construction time.
- WhatsApp webhook (`server.ts` line 764): `const userId = Object.values(config.webhookTokens)[0]` -- same pattern.

**Channel MCP (`ll5-channel.mjs`):**
- Runs as a stdio subprocess of Claude Code. Reads token from `~/.ll5/token`.
- One instance per Claude Code session. Each user would need their own Claude Code instance.

**External services:**
- WhatsApp (Evolution API): `messaging_whatsapp_accounts` table is already per-user. Each account has its own `instance_name`, `api_url`, `api_key`.
- Google OAuth: `google_oauth_tokens` table is per-user. OAuth flow exists (tools: `get_auth_url`, `handle_oauth_callback`).
- FCM: `fcm_tokens` table is per-user. Push notifications already route by `user_id`.

---

## Implementation Plan

### Phase 1: User CRUD API + Admin UI (Gateway + Dashboard)

This is fully incremental and does not break existing single-user functionality.

#### 1A. Database Migration -- `015_auth_users_v2.sql`

Add the missing `role` column formally, add `enabled`, `display_name`, `timezone`, `settings` (JSONB), and `updated_at`:

```sql
-- Formalize role column (if not present already, use DO block)
ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'Asia/Jerusalem';
ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}';
ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
```

The `settings` JSONB column holds per-user notification preferences, onboarding state, and any future extensible config without schema changes.

**File:** `/Users/arnon/workspace/ll5/packages/gateway/src/migrations/015_auth_users_v2.sql` (new)

#### 1B. Admin User CRUD Endpoints on Gateway

Add a new file `/Users/arnon/workspace/ll5/packages/gateway/src/admin.ts` with an Express router mounted at `/admin/users`. All endpoints require the `admin` role in the token.

**Middleware:** Create a `requireAdmin` middleware that checks `tokenPayload.role === 'admin'`. Can wrap the existing `chatAuthMiddleware` plus a role check.

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/admin/users` | List all users (admin only). Returns `user_id`, `name`, `display_name`, `role`, `enabled`, `timezone`, `created_at`, `updated_at` -- never `pin_hash`. |
| `GET` | `/admin/users/:id` | Get single user detail. |
| `POST` | `/admin/users` | Create user. Body: `{display_name, pin, role?, timezone?, settings?}`. Generates `user_id` as UUID. Hashes PIN with bcrypt. |
| `PATCH` | `/admin/users/:id` | Update user. Supports partial: `display_name`, `role`, `timezone`, `enabled`, `settings`. |
| `POST` | `/admin/users/:id/pin` | Set/reset PIN. Body: `{pin}`. Hashes and stores. Separate endpoint so it is distinct from profile edits. |
| `DELETE` | `/admin/users/:id` | Soft delete (set `enabled = false`). Hard delete is too dangerous with data across ES/PG. |

**Key files to modify:**
- `/Users/arnon/workspace/ll5/packages/gateway/src/server.ts` -- mount the admin router
- `/Users/arnon/workspace/ll5/packages/gateway/src/auth.ts` -- update the login query to check `enabled = true`

**PIN hashing:** Use the existing `bcryptjs` dependency already in the gateway. Hash with salt rounds 12.

#### 1C. Admin Dashboard UI

Replace the placeholder in `/Users/arnon/workspace/ll5/packages/dashboard/src/app/(admin)/admin/users/page.tsx` with a full user management interface.

**Components needed:**
1. **User list table** -- shows all users with columns: display name, role badge, enabled status, timezone, created date. Each row has Edit/Disable actions.
2. **Create user dialog** -- modal form with: display name, PIN (with confirmation), role selector (admin/user), timezone selector.
3. **Edit user dialog** -- same form, pre-filled. PIN reset is a separate action within the dialog.
4. **Server actions** in `users-server-actions.ts` -- call the gateway admin API using the current user's token.

The dashboard already has `dialog.tsx`, `input.tsx`, `select.tsx`, `badge.tsx`, `button.tsx` UI components, so the form building blocks exist.

**New file:** The admin users page needs gateway API calls. Since the dashboard currently calls MCPs via the helper in `api.ts`, add a new helper function for gateway admin calls:

```typescript
// Direct gateway API call (not MCP)
async function gatewayAdminCall(path: string, options?: RequestInit) {
  const token = await getToken();
  return fetch(`${env.GATEWAY_URL}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options?.headers },
  });
}
```

This goes in a new server action file or directly in `users-server-actions.ts`.

### Phase 2: Auth Improvements

#### 2A. Rate Limiting on Failed Login Attempts

Add a simple in-memory rate limiter to `POST /auth/token` in `/Users/arnon/workspace/ll5/packages/gateway/src/auth.ts`:

- Track failed attempts per `user_id` in a `Map<string, {count, lastAttempt}>`.
- After 5 failed attempts, lock for 15 minutes (respond 429).
- Reset on successful login.
- No need for Redis -- the gateway is a single instance. If it restarts, rate limits reset, which is acceptable.

#### 2B. PIN Strength Validation

On create/reset PIN in the admin endpoints:
- Minimum 6 characters.
- Reject common patterns (123456, 000000, etc.) -- a small blocklist.
- The login form currently uses `inputMode="numeric"` but `type="password"`, so PINs can be alphanumeric. Keep this flexibility.

#### 2C. Token Refresh Endpoint

Add `POST /auth/refresh` to the auth router:
- Accepts a valid (non-expired) token.
- Issues a new token with refreshed `iat`/`exp`.
- Does not require PIN -- the existing token is proof of authentication.
- Validate the user is still `enabled` before refreshing.

The dashboard can call this periodically or when detecting a near-expiry token (check `exp` on page load in the user layout).

#### 2D. Login Page UX

The current login requires typing a UUID as user_id. For multi-user:
- Add a `username` or `short_id` column to `auth_users` that acts as a human-friendly login identifier (e.g., "arnon" instead of "f08f46b3-0a9c-41ae-9e6a-294c697424e4").
- Update the login endpoint to accept either UUID or username.
- Update the login form placeholder text accordingly.

### Phase 3: Multi-User Scheduler Architecture

This is the biggest structural change.

#### 3A. Scheduler Refactoring

**Current problem:** `startSchedulers()` takes the first user from `webhookTokens` and starts all schedulers for that single user.

**Solution:** Iterate over all active users from the database, start scheduler sets per user.

Modify `/Users/arnon/workspace/ll5/packages/gateway/src/scheduler/index.ts`:

```
export async function startSchedulers(config, es, pgPool):
  1. Query: SELECT user_id, timezone, settings FROM auth_users WHERE enabled = true
  2. For each user:
     a. Read user-specific settings (timezone, active hours, intervals) from settings JSONB
     b. Fall back to environment-level defaults from config
     c. Create all scheduler instances with that user's userId + settings
     d. Start them
  3. Store scheduler instances in a Map<userId, SchedulerSet>
  4. Set up a periodic check (every 5 min) to detect new/disabled users
     and start/stop their scheduler sets accordingly
```

Each scheduler already accepts `userId` in its config -- no changes to individual scheduler classes needed. The only change is the orchestration in `index.ts`.

**Per-user settings stored in `auth_users.settings` JSONB:**
```json
{
  "active_hours": { "start": 7, "end": 22 },
  "daily_review_hour": 7,
  "weekly_review": { "day": 5, "hour": 14 },
  "message_batch_interval_minutes": 30,
  "journal_consolidation_hour": 2,
  "gtd_health_interval_hours": 4,
  "google_mcp_url": null,
  "google_mcp_api_key": null
}
```

This lets admins configure per-user schedules from the admin UI without environment variable changes.

#### 3B. WhatsApp Webhook User Routing

**Current problem:** `server.ts` line 764: `const userId = Object.values(config.webhookTokens)[0]` hardcodes user.

**Solution:** Evolution API webhook URLs include the instance name. Map instance names to users:

1. Add a lookup: query `messaging_whatsapp_accounts` to find the `user_id` for the instance that matches the webhook payload's `instance` field.
2. If no match, fall back to the default user (backwards compatible).
3. This requires the messaging MCP's PG tables to be accessible from the gateway (they share the same PG database).

**File:** `/Users/arnon/workspace/ll5/packages/gateway/src/processors/whatsapp-webhook.ts`

#### 3C. Webhook Token Deprecation Path

Currently, `WEBHOOK_TOKENS` is a static env var mapping opaque tokens to user_ids. For multi-user:
- The Android app already sends an `ll5.*` auth token in the webhook URL path (handled by `server.ts` lines 786-806).
- Remove dependency on `WEBHOOK_TOKENS` for user_id resolution -- just use the auth token from the URL path or Authorization header.
- Keep `WEBHOOK_TOKENS` as an optional legacy fallback that can be removed later.

### Phase 4: MCP Concurrency Fix

**Current problem:** All MCPs use a module-level `let currentUserId = ''` that gets overwritten per-request. Under concurrent requests from different users, this is a race condition.

**Solution:** Use Node.js `AsyncLocalStorage` to store `userId` per-request context.

Files to modify (same pattern in all MCPs):
- `/Users/arnon/workspace/ll5/packages/awareness/src/server.ts`
- `/Users/arnon/workspace/ll5/packages/gtd/src/server.ts`
- `/Users/arnon/workspace/ll5/packages/messaging/src/server.ts`
- `/Users/arnon/workspace/ll5/packages/google/src/server.ts`

The change is small per file:
```typescript
import { AsyncLocalStorage } from 'node:async_hooks';
const userStore = new AsyncLocalStorage<string>();

function getUserId(): string {
  return userStore.getStore() ?? '';
}

// In the request handler:
app.all('/mcp', authMw, async (req, res) => {
  const userId = (req as AuthenticatedRequest).userId;
  await userStore.run(userId, async () => {
    // ... existing MCP handling
  });
});
```

This is a critical fix that should happen early, ideally in Phase 1 or 2, even if only one user exists, because it prevents a class of bugs from the start.

### Phase 5: Onboarding Flow

#### 5A. Onboarding State Machine

Store onboarding state in `auth_users.settings`:

```json
{
  "onboarding": {
    "completed": false,
    "steps": {
      "pin_set": true,
      "timezone_configured": false,
      "google_connected": false,
      "android_installed": false,
      "whatsapp_connected": false
    }
  }
}
```

#### 5B. Dashboard Onboarding Page

New route: `/onboarding` (under the `(user)` route group).

Steps:
1. **Welcome + PIN** -- already set during admin user creation. Show "PIN set" checkmark.
2. **Timezone** -- dropdown selector. Calls the gateway to update `auth_users.timezone` and also calls the Google MCP's `set_timezone` tool.
3. **Google Account** -- button that calls `get_auth_url` on the calendar MCP, redirects to Google OAuth, handles callback. Show connection status via `get_connection_status`.
4. **Android App** -- generate a QR code containing the gateway URL and the user's token (or a short-lived setup token). The Android app scans this to auto-configure itself.
5. **WhatsApp** -- trigger `create_whatsapp_account` on the messaging MCP. Show the QR code from Evolution API for WhatsApp linking.

The user layout (`/Users/arnon/workspace/ll5/packages/dashboard/src/app/(user)/layout.tsx`) can check the onboarding state and redirect to `/onboarding` if `onboarding.completed === false`.

#### 5C. Admin-Initiated User Creation Flow

When an admin creates a user:
1. Admin sets: display name, PIN, role, timezone.
2. System generates user_id (UUID), hashes PIN, creates `auth_users` row.
3. System creates the user's profile in `personal-knowledge` MCP (calls `update_profile` with the display name).
4. System returns a shareable login link or QR code with the user_id pre-filled, so the new user just needs to enter their PIN.

### Phase 6: Channel MCP Per-User Agent

#### Architecture Decision: One Claude Code Agent Per User

The `ll5-channel.mjs` runs as a stdio subprocess of a specific Claude Code session. It reads a single token from `~/.ll5/token`. This is fundamentally per-user by design.

For multiple users, each user needs:
1. Their own Claude Code session (running on the host or in a container).
2. Their own `~/.ll5/token` file (or parametrized token source).
3. Their own `.mcp.json` config pointing to the shared MCP servers but with their token.

**Recommended approach:**
- Keep the single-agent model for now. LL5 is a personal assistant, and Claude Code sessions are heavyweight (long-running, stateful).
- The admin creates users who use the dashboard and get proactive messages via the scheduler, but they do not get their own Claude Code agent immediately.
- A future "agent pool" feature could be built later using the Claude API (`claude-agent-sdk`) instead of Claude Code, which would allow spawning lightweight per-user agent threads.

### Phase 7: Evolution API Architecture

**Decision: Shared Evolution API Instance, Per-User WhatsApp Accounts**

This is already supported by the architecture:
- Evolution API supports multiple instances (one per phone number).
- The `messaging_whatsapp_accounts` table stores `instance_name` and `api_url` per user.
- Each user connects their own WhatsApp number by creating a new Evolution API instance.
- The webhook URL for each instance includes a user identifier, allowing the gateway to route incoming messages to the correct user.

No architectural change needed -- just operational setup (one Evolution API deployment, multiple instances created via the messaging MCP's `create_whatsapp_account` tool).

---

## Implementation Sequencing

| Priority | Phase | Effort | Breaks Existing? |
|----------|-------|--------|:-:|
| 1 | 4: AsyncLocalStorage MCP fix | Small (4 files, ~20 lines each) | No |
| 2 | 1A: DB migration | Small | No |
| 3 | 1B: Admin CRUD endpoints | Medium (new file ~200 lines) | No |
| 4 | 1C: Admin dashboard UI | Medium (rewrite ~300 lines) | No |
| 5 | 2A: Rate limiting | Small (~30 lines) | No |
| 6 | 2D: Username login | Small (migration + 2 code changes) | No |
| 7 | 2C: Token refresh | Small (~30 lines) | No |
| 8 | 3A: Multi-user scheduler | Medium (~100 lines refactor) | No |
| 9 | 3B: WhatsApp webhook routing | Small (~20 lines) | No |
| 10 | 5B: Onboarding UI | Medium (new page ~300 lines) | No |
| 11 | 5C: Admin creation flow | Small (extends Phase 1B) | No |
| Later | 6: Per-user agents | Large / deferred | N/A |

Everything through Phase 5 can be implemented incrementally without breaking the existing single-user setup. The existing admin user continues to work exactly as before throughout.

---

## Key Architecture Decisions

1. **Soft delete, not hard delete**: Disabling a user sets `enabled = false`. Their data remains intact across all ES indices and PG tables. This prevents orphaned data and allows re-enabling.

2. **Settings in JSONB, not columns**: Per-user settings (schedule config, onboarding state, notification prefs) go in the `settings` JSONB column. This avoids a migration for every new setting and keeps the schema stable.

3. **Scheduler per-user via DB query**: Rather than encoding users in environment variables, the scheduler reads active users from `auth_users`. New users get schedulers automatically within 5 minutes.

4. **No shared Claude Code agent**: Each user who needs a Claude Code agent gets their own session. This is a deployment concern, not a code architecture concern. The MCPs are already multi-tenant.

5. **Admin-only user management**: Only `role='admin'` users can create/modify other users. There is no self-registration flow. This fits the personal/family use case.

---

### Critical Files for Implementation

- `/Users/arnon/workspace/ll5/packages/gateway/src/auth.ts` -- add rate limiting, username login support, and check `enabled` on login
- `/Users/arnon/workspace/ll5/packages/gateway/src/server.ts` -- mount admin router, update WhatsApp webhook user resolution
- `/Users/arnon/workspace/ll5/packages/gateway/src/scheduler/index.ts` -- refactor from single-user to multi-user scheduler orchestration
- `/Users/arnon/workspace/ll5/packages/dashboard/src/app/(admin)/admin/users/page.tsx` -- replace placeholder with full user CRUD UI
- `/Users/arnon/workspace/ll5/packages/shared/src/auth/token.ts` -- token generation/validation (may need token refresh support)
