import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encrypt, decrypt } from '../encryption.js';

describe('encryption helper (local copy)', () => {
  const key = randomBytes(32).toString('hex');

  it('round-trips a plaintext value', () => {
    const secret = 'sk-ant-api03-abc123-the-users-claude-key';
    const ct = encrypt(secret, key);
    expect(ct).not.toContain(secret);
    expect(ct.split(':')).toHaveLength(3);
    expect(decrypt(ct, key)).toBe(secret);
  });

  it('rejects a malformed ciphertext', () => {
    expect(() => decrypt('not-valid', key)).toThrow(/Invalid encrypted string format/);
  });

  it('fails to decrypt with the wrong key', () => {
    const ct = encrypt('hello', key);
    const wrong = randomBytes(32).toString('hex');
    expect(() => decrypt(ct, wrong)).toThrow();
  });
});
