import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, deriveSubKey } from '../encryption.js';

const KEY = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

describe('shared encryption (AES-256-GCM, iv:tag:ciphertext)', () => {
  it('round-trips unicode plaintext and produces a fresh iv per call', () => {
    const plain = 'סופר פארם 214.90 ILS — {"json":true}';
    const a = encrypt(plain, KEY);
    const b = encrypt(plain, KEY);
    expect(a).not.toBe(b);
    expect(a.split(':')).toHaveLength(3);
    expect(decrypt(a, KEY)).toBe(plain);
    expect(decrypt(b, KEY)).toBe(plain);
  });

  it('round-trips the empty string', () => {
    expect(decrypt(encrypt('', KEY), KEY)).toBe('');
  });

  it('rejects a wrong key, a tampered ciphertext and a malformed string', () => {
    const enc = encrypt('secret', KEY);
    expect(() => decrypt(enc, OTHER)).toThrow();
    const [iv, tag, ct] = enc.split(':');
    const flipped = (parseInt(ct.slice(0, 1), 16) ^ 1).toString(16) + ct.slice(1);
    expect(() => decrypt(`${iv}:${tag}:${flipped}`, KEY)).toThrow();
    expect(() => decrypt('not-encrypted', KEY)).toThrow('Invalid encrypted string format');
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => encrypt('x', 'abcd')).toThrow(/32 bytes/);
  });

  it('derives stable, label-separated sub-keys', () => {
    const k1 = deriveSubKey(KEY, 'merchant-key');
    expect(k1).toBe(deriveSubKey(KEY, 'merchant-key'));
    expect(k1).toHaveLength(64);
    expect(k1).not.toBe(deriveSubKey(KEY, 'other-label'));
    expect(k1).not.toBe(deriveSubKey(OTHER, 'merchant-key'));
  });
});
