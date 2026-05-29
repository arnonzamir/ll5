# DECISION-003 — Persist rotated Google OAuth refresh tokens

Date: 2026-05-29
Status: Accepted
Scope: google MCP (`utils/google-client.ts`, `repositories/postgres/oauth-token.repository.ts`)

## Context

On access-token refresh, `getAuthenticatedClient` persisted only the new access token + expiry (`updateAccessToken`). When Google returned a **rotated `refresh_token`** in the credentials, it was applied to the in-memory client but never written to `google_oauth_tokens`. After the next process restart the stale stored refresh token was reused → permanent `invalid_grant` → silent Google disconnect until manual re-auth.

Live trace: **18** `invalid_grant`/refresh-fail log lines; `google` was the #1 error-emitting service (42 errors) in `ll5_app_log`.

## Decision

After a successful refresh, if `credentials.refresh_token` is present **and differs from the stored value**, persist it via a new `updateRefreshToken(userId, refreshToken)` repository method (encrypt-before-store, `WHERE user_id = $2` scoped — consistent with existing token encryption). Emit `info google_refresh_token_rotated { user_id }` when this happens, so rotation is observable.

The `google_oauth_tokens` table already has a `refresh_token` column — no schema migration required.

## Alternatives considered

- **Always re-write the refresh token on every refresh** — rejected: an unnecessary encrypt + write on the hot path; the differs-from-stored guard avoids it and makes the log meaningful (it only fires on a genuine rotation).
- **Force full re-auth on `invalid_grant`** — that remains the recovery path when no valid refresh token exists, but it is not a substitute for persisting rotations; it would have made the user re-consent repeatedly.

## Consequences

- Google connections survive refresh-token rotation across restarts.
- A spike in `google_refresh_token_rotated` is now a legible signal (e.g. after a consent change) rather than an invisible state transition.
- Tests cover both the rotation-persisted path and the negative cases (same token / omitted token → no write), verified RED first.
