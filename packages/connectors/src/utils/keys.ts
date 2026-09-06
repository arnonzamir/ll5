/**
 * Pure key helpers.
 *
 * merchant_key: HMAC-SHA256 of the normalized merchant string with a per-service
 * sub-key derived from ENCRYPTION_KEY (never the AES key itself). Lets the
 * reconciler match an event to a ledger row without either side keeping the
 * merchant in plaintext.
 *
 * dedupe_key: sha256 over the stable parts of a source event, for callers that
 * build the envelope here (the gateway computes its own with the same recipe).
 */
import { createHash, createHmac } from 'node:crypto';
import { deriveSubKey } from '@ll5/shared';

export const MERCHANT_KEY_LABEL = 'll5-connectors/merchant-key/v1';

/** Derive the merchant-hashing sub-key from the service ENCRYPTION_KEY. */
export function merchantSubKey(encryptionKeyHex: string): string {
  return deriveSubKey(encryptionKeyHex, MERCHANT_KEY_LABEL);
}

/**
 * Normalize a merchant string so the same business hashes the same way across
 * a notification ("SUPER-PHARM  TLV") and a ledger row ("super pharm tlv"):
 * NFKC, lower case, letters/digits/spaces only, whitespace collapsed.
 * Returns '' for an empty / non-string input.
 */
export function normalizeMerchant(merchant: unknown): string {
  if (typeof merchant !== 'string') return '';
  return merchant
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** HMAC-SHA256(normalized merchant) with the sub-key; null when there is no merchant. */
export function merchantKey(merchant: unknown, subKeyHex: string): string | null {
  const norm = normalizeMerchant(merchant);
  if (!norm) return null;
  return createHmac('sha256', Buffer.from(subKeyHex, 'hex')).update(norm, 'utf8').digest('hex');
}

/** sha256 over the joined parts, `|`-separated, nullish parts as ''. */
export function dedupeKey(parts: ReadonlyArray<string | number | null | undefined>): string {
  const joined = parts.map((p) => (p == null ? '' : String(p))).join('|');
  return createHash('sha256').update(joined, 'utf8').digest('hex');
}
