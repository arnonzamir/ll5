import { createDecipheriv } from 'node:crypto';

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
