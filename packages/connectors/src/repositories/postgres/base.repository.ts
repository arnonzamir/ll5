import type { Pool } from 'pg';
import { getContextUserId, encrypt, decrypt } from '@ll5/shared';
import { logger } from '../../utils/logger.js';

/**
 * Tenancy + encryption boundary for every PG repository. The user id is read
 * from the request context (runWithRequestContext), never taken as an
 * argument — a query cannot be issued for another tenant by mistake.
 */
export abstract class PgRepository {
  constructor(
    protected readonly pool: Pool,
    protected readonly encryptionKey: string,
  ) {}

  protected userId(): string {
    const uid = getContextUserId();
    if (!uid) throw new Error('No user context — request not wrapped in runWithRequestContext()');
    return uid;
  }

  protected encryptJson(value: unknown): string {
    return encrypt(JSON.stringify(value ?? null), this.encryptionKey);
  }

  /**
   * Decrypt a stored JSON payload. A row that fails to decrypt (key rotation,
   * corruption) is reported in-band and logged — never silently dropped.
   */
  protected decryptJson(enc: string | null, where: string): Record<string, unknown> | null {
    if (enc == null) return null;
    try {
      const parsed = JSON.parse(decrypt(enc, this.encryptionKey)) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch (err) {
      logger.error(`[${where}] payload decrypt failed`, { error: err instanceof Error ? err.message : String(err) });
      return { error: 'decrypt_failed' };
    }
  }
}

export function iso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function num(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Trim CHAR(3) padding; null stays null. */
export function currency(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s ? s : null;
}
