import { BasePostgresRepository } from './base.repository.js';
import type { OAuthTokenRepository, OAuthTokenRecord, StoreTokenInput } from '../interfaces/oauth-token.repository.js';
import { encrypt, decrypt } from '../../utils/encryption.js';

interface OAuthTokenRow {
  id: string;
  user_id: string;
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_at: Date;
  scopes: string[];
  created_at: Date;
  updated_at: Date;
}

export class PostgresOAuthTokenRepository extends BasePostgresRepository implements OAuthTokenRepository {
  constructor(pool: import('pg').Pool, private encryptionKey: string) {
    super(pool);
  }

  async store(userId: string, tokens: StoreTokenInput): Promise<void> {
    const encAccessToken = encrypt(tokens.access_token, this.encryptionKey);
    const encRefreshToken = encrypt(tokens.refresh_token, this.encryptionKey);

    await this.query(
      `INSERT INTO google_oauth_tokens (user_id, access_token, refresh_token, token_type, expires_at, scopes)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE SET
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         token_type = EXCLUDED.token_type,
         expires_at = EXCLUDED.expires_at,
         scopes = EXCLUDED.scopes,
         updated_at = now()`,
      [userId, encAccessToken, encRefreshToken, tokens.token_type, tokens.expires_at, tokens.scopes],
    );
  }

  async get(userId: string): Promise<OAuthTokenRecord | null> {
    const row = await this.queryOne<OAuthTokenRow>(
      `SELECT * FROM google_oauth_tokens WHERE user_id = $1`,
      [userId],
    );

    if (!row) return null;

    return {
      user_id: row.user_id,
      access_token: decrypt(row.access_token, this.encryptionKey),
      refresh_token: decrypt(row.refresh_token, this.encryptionKey),
      token_type: row.token_type,
      expires_at: row.expires_at,
      scopes: row.scopes ?? [],
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  async updateAccessToken(userId: string, accessToken: string, expiresAt: Date): Promise<void> {
    const encAccessToken = encrypt(accessToken, this.encryptionKey);

    await this.query(
      `UPDATE google_oauth_tokens SET access_token = $1, expires_at = $2, updated_at = now() WHERE user_id = $3`,
      [encAccessToken, expiresAt, userId],
    );
  }

  async delete(userId: string): Promise<void> {
    await this.query(`DELETE FROM google_oauth_tokens WHERE user_id = $1`, [userId]);
  }
}
