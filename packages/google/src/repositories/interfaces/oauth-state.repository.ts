/**
 * Durable CSRF `state` store for the Google OAuth flow.
 *
 * Rows are single-use and TTL-bounded. Because the state is persisted (not held
 * in an in-memory Map), a callback survives a google-service restart or a
 * delayed chat-link click between get_auth_url and /oauth/callback.
 */
export interface OAuthStateRecord {
  userId: string;
  scopes: string[];
}

/** Default state lifetime: 60 minutes (was a 10-minute in-memory setTimeout). */
export const OAUTH_STATE_TTL_MS = 60 * 60 * 1000;

export interface OAuthStateRepository {
  /** Persist a state token with expires_at = now + ttlMs. */
  putState(state: string, userId: string, scopes: string[], ttlMs: number): Promise<void>;

  /**
   * Atomically consume a state: return + delete the row iff it exists and has
   * not expired. Single-use — a second take of the same state returns null.
   * Returns null for a genuine miss (unknown or expired state).
   */
  takeState(state: string): Promise<OAuthStateRecord | null>;

  /** Best-effort delete of past-expiry rows. Returns how many were removed. */
  sweepExpired(): Promise<number>;
}
