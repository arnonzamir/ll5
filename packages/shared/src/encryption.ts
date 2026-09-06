/**
 * AES-256-GCM at rest (application-level, not pgcrypto — docs/design/connectors.md,
 * Section 3). Format: `iv:authTag:ciphertext`, all hex. The key is the 64-char hex
 * `ENCRYPTION_KEY` each service is provisioned with (compose-lint checks it).
 *
 * This is the single copy for new code. google and health still carry their
 * identical local copies until touched for another reason.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function keyFromHex(keyHex: string): Buffer {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) {
    throw new Error(`Encryption key must be 32 bytes (64 hex chars), got ${key.length} bytes`);
  }
  return key;
}

/** Encrypt a UTF-8 string. Returns `iv:authTag:ciphertext` (hex). */
export function encrypt(plaintext: string, keyHex: string): string {
  const key = keyFromHex(keyHex);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/** Decrypt a string produced by `encrypt`. Throws on a malformed input or a bad tag. */
export function decrypt(encryptedStr: string, keyHex: string): string {
  const parts = encryptedStr.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted string format');
  }

  const [ivHex, authTagHex, ciphertext] = parts;
  const key = keyFromHex(keyHex);
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Derive a purpose-bound sub-key from the service key (HMAC-SHA256 over a label),
 * so a hashing use (e.g. merchant keys) never reuses the AES key directly.
 * Returns 64 hex chars.
 */
export function deriveSubKey(keyHex: string, label: string): string {
  return createHmac('sha256', keyFromHex(keyHex)).update(label, 'utf8').digest('hex');
}
