import { BasePostgresRepository } from './base.repository.js';
import type {
  OAuthStateRepository,
  OAuthStateRecord,
} from '../interfaces/oauth-state.repository.js';

interface OAuthStateRow {
  user_id: string;
  scopes: string[];
}

export class PostgresOAuthStateRepository
  extends BasePostgresRepository
  implements OAuthStateRepository
{
  async putState(state: string, userId: string, scopes: string[], ttlMs: number): Promise<void> {
    // Opportunistic sweep keeps the table from accumulating dead rows without a
    // separate scheduler. Cheap thanks to idx_google_oauth_states_expires_at.
    await this.sweepExpired();

    const expiresAt = new Date(Date.now() + ttlMs);
    await this.query(
      `INSERT INTO google_oauth_states (state, user_id, scopes, expires_at)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (state) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         scopes = EXCLUDED.scopes,
         created_at = now(),
         expires_at = EXCLUDED.expires_at`,
      [state, userId, JSON.stringify(scopes), expiresAt],
    );
  }

  async takeState(state: string): Promise<OAuthStateRecord | null> {
    // DELETE ... RETURNING makes the consume atomic (single-use).
    const row = await this.queryOne<OAuthStateRow>(
      `DELETE FROM google_oauth_states
       WHERE state = $1 AND expires_at > now()
       RETURNING user_id, scopes`,
      [state],
    );
    if (!row) return null;
    return { userId: row.user_id, scopes: row.scopes ?? [] };
  }

  async sweepExpired(): Promise<number> {
    const rows = await this.query<{ state: string }>(
      `DELETE FROM google_oauth_states WHERE expires_at <= now() RETURNING state`,
      [],
    );
    return rows.length;
  }
}
