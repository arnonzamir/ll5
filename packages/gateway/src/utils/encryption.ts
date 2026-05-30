import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Decrypts a hex-encoded AES-256-GCM ciphertext.
 * Compatible with the encrypt() function in @ll5/messaging.
 */
export function decrypt(encryptedHex: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const packed = Buffer.from(encryptedHex, 'hex');

  const iv = packed.subarray(0, IV_LENGTH);
  const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

// ---------------------------------------------------------------------------
// AES-256-GCM secret-at-rest (BYO Claude credential — agent_llm_credentials).
//
// Copied from packages/google/src/utils/encryption.ts: a self-describing
// colon-delimited `iv:authTag:ciphertext` (all hex) format. Distinct from the
// packed-hex decrypt() above (which is bound to the @ll5/messaging format used
// by the WhatsApp webhook) so the two schemes never collide. Uses the same
// ENCRYPTION_KEY (config.encryptionKey, hex) as google/health.
// ---------------------------------------------------------------------------

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * Returns a hex string in the format: iv:authTag:ciphertext
 */
export function encryptSecret(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypts a string produced by encryptSecret().
 * Expects input in the format: iv:authTag:ciphertext (all hex).
 */
export function decryptSecret(encryptedStr: string, keyHex: string): string {
  const parts = encryptedStr.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted string format');
  }

  const [ivHex, authTagHex, ciphertext] = parts;
  const key = Buffer.from(keyHex, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
