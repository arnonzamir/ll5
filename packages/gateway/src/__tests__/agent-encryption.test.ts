import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { encryptSecret, decryptSecret } from '../utils/encryption.js';

// 32-byte (256-bit) key, hex-encoded, as ENCRYPTION_KEY would be.
const KEY = crypto.randomBytes(32).toString('hex');

describe('agent secret encryption (AES-256-GCM)', () => {
  it('round-trips encrypt → decrypt', () => {
    const plaintext = 'sk-ant-api03-abcdef1234567890';
    const ct = encryptSecret(plaintext, KEY);
    expect(decryptSecret(ct, KEY)).toBe(plaintext);
  });

  it('ciphertext is not the plaintext and is self-describing (iv:tag:ct)', () => {
    const plaintext = 'sk-ant-secretvalue';
    const ct = encryptSecret(plaintext, KEY);
    expect(ct).not.toContain(plaintext);
    expect(ct.split(':')).toHaveLength(3);
  });

  it('produces a different ciphertext each call (random IV)', () => {
    const plaintext = 'sk-ant-same';
    expect(encryptSecret(plaintext, KEY)).not.toBe(encryptSecret(plaintext, KEY));
  });

  it('rejects a tampered ciphertext (auth tag)', () => {
    const ct = encryptSecret('sk-ant-tamper', KEY);
    const [iv, tag, body] = ct.split(':');
    const flipped = body.slice(0, -1) + (body.slice(-1) === 'a' ? 'b' : 'a');
    expect(() => decryptSecret(`${iv}:${tag}:${flipped}`, KEY)).toThrow();
  });
});
