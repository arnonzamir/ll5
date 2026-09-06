import type { CredentialRecord } from '../../types.js';

/** Encrypted per-connector secrets. Decrypted only by `get`, for a pull. */
export interface CredentialRepository {
  get(connectorId: string): Promise<CredentialRecord | null>;
  put(connectorId: string, authType: string, secret: Record<string, unknown>): Promise<void>;
  /** Connector ids that have a stored secret — never the secrets themselves. */
  connectorIdsWithCredentials(): Promise<Set<string>>;
}
