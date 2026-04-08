import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from '../utils/encryption.js';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_KEY = randomBytes(32).toString('hex'); // 64-hex-char AES-256 key
const WRONG_KEY = randomBytes(32).toString('hex');

// ---------------------------------------------------------------------------
// encrypt / decrypt roundtrip
// ---------------------------------------------------------------------------

describe('encryption', () => {
  it('encrypts and decrypts a simple string', () => {
    const plaintext = 'hello world';
    const encrypted = encrypt(plaintext, VALID_KEY);
    const decrypted = decrypt(encrypted, VALID_KEY);
    expect(decrypted).toBe(plaintext);
  });

  it('encrypts and decrypts an empty string', () => {
    const plaintext = '';
    const encrypted = encrypt(plaintext, VALID_KEY);
    const decrypted = decrypt(encrypted, VALID_KEY);
    expect(decrypted).toBe(plaintext);
  });

  it('encrypts and decrypts unicode text', () => {
    const plaintext = 'Hello \u{1F600} \u05E9\u05DC\u05D5\u05DD \u4F60\u597D';
    const encrypted = encrypt(plaintext, VALID_KEY);
    const decrypted = decrypt(encrypted, VALID_KEY);
    expect(decrypted).toBe(plaintext);
  });

  it('encrypts and decrypts a long string (API key-like)', () => {
    const plaintext = 'B6D7A2F9E1C3D5A8B0E2F4A6C8D0E2F4A6B8C0D2E4F6A8B0C2D4E6F8A0B2C4';
    const encrypted = encrypt(plaintext, VALID_KEY);
    const decrypted = decrypt(encrypted, VALID_KEY);
    expect(decrypted).toBe(plaintext);
  });

  it('produces different ciphertext for the same plaintext (random IV)', () => {
    const plaintext = 'same-input-different-output';
    const encrypted1 = encrypt(plaintext, VALID_KEY);
    const encrypted2 = encrypt(plaintext, VALID_KEY);
    expect(encrypted1).not.toBe(encrypted2);
  });

  it('output is hex-encoded', () => {
    const encrypted = encrypt('test', VALID_KEY);
    expect(encrypted).toMatch(/^[0-9a-f]+$/);
  });

  it('throws when decrypting with wrong key', () => {
    const plaintext = 'secret data';
    const encrypted = encrypt(plaintext, VALID_KEY);
    expect(() => decrypt(encrypted, WRONG_KEY)).toThrow();
  });

  it('throws when decrypting corrupted data', () => {
    const plaintext = 'secret data';
    const encrypted = encrypt(plaintext, VALID_KEY);
    // Corrupt the middle of the ciphertext
    const corrupted = encrypted.slice(0, 30) + 'ff' + encrypted.slice(32);
    expect(() => decrypt(corrupted, VALID_KEY)).toThrow();
  });

  it('throws when decrypting truncated data', () => {
    const plaintext = 'secret data';
    const encrypted = encrypt(plaintext, VALID_KEY);
    // Truncate to just IV (24 hex chars = 12 bytes)
    const truncated = encrypted.slice(0, 24);
    expect(() => decrypt(truncated, VALID_KEY)).toThrow();
  });
});
