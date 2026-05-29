export interface OAuthTokenRecord {
  user_id: string;
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_at: Date;
  scopes: string[];
  created_at: Date;
  updated_at: Date;
}

export interface StoreTokenInput {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_at: Date;
  scopes: string[];
}

export interface OAuthTokenRepository {
  /** Store tokens after initial OAuth exchange. Encrypts tokens before storage. */
  store(userId: string, tokens: StoreTokenInput): Promise<void>;

  /** Get decrypted tokens for a user. Returns null if not connected. */
  get(userId: string): Promise<OAuthTokenRecord | null>;

  /** Update tokens after a refresh. Encrypts the new access token. */
  updateAccessToken(userId: string, accessToken: string, expiresAt: Date): Promise<void>;

  /**
   * Persist a rotated refresh token. Encrypts before storage.
   * Called when Google returns a new refresh_token during a refresh so the
   * stored token does not go stale (stale token → permanent invalid_grant).
   */
  updateRefreshToken(userId: string, refreshToken: string): Promise<void>;

  /** Delete all tokens for a user. */
  delete(userId: string): Promise<void>;
}
