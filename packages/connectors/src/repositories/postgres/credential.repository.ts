import type { CredentialRepository } from '../interfaces/credential.repository.js';
import type { CredentialRecord } from '../../types.js';
import { PgRepository, iso } from './base.repository.js';

export class PgCredentialRepository extends PgRepository implements CredentialRepository {
  async get(connectorId: string): Promise<CredentialRecord | null> {
    const res = await this.pool.query(
      `SELECT connector_id, auth_type, secret_enc, updated_at
       FROM connector_credentials WHERE user_id = $1 AND connector_id = $2`,
      [this.userId(), connectorId],
    );
    const r = res.rows[0];
    if (!r) return null;
    const secret = this.decryptJson(r.secret_enc, 'PgCredentialRepository.get');
    if (!secret || secret.error === 'decrypt_failed') {
      throw new Error(`Stored credentials for ${connectorId} cannot be decrypted — re-enter them`);
    }
    return {
      connector_id: String(r.connector_id),
      auth_type: String(r.auth_type),
      secret,
      updated_at: iso(r.updated_at) ?? '',
    };
  }

  async put(connectorId: string, authType: string, secret: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      `INSERT INTO connector_credentials (user_id, connector_id, auth_type, secret_enc, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (user_id, connector_id)
       DO UPDATE SET auth_type = $3, secret_enc = $4, updated_at = now()`,
      [this.userId(), connectorId, authType, this.encryptJson(secret)],
    );
  }

  async connectorIdsWithCredentials(): Promise<Set<string>> {
    const res = await this.pool.query(
      `SELECT connector_id FROM connector_credentials WHERE user_id = $1`,
      [this.userId()],
    );
    return new Set(res.rows.map((r) => String(r.connector_id)));
  }
}
