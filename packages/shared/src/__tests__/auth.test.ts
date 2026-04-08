import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateToken, validateToken, isTokenExpiredError } from '../auth/token.js';
import type { TokenPayload, TokenExpiredError } from '../auth/token.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTH_SECRET = 'test-secret-for-auth-testing-abcdef1234567890';
const USER_ID = 'f08f46b3-0a9c-41ae-9e6a-294c697424e4';

// ---------------------------------------------------------------------------
// generateToken
// ---------------------------------------------------------------------------

describe('generateToken', () => {
  it('produces token with ll5.<base64>.<hex> format', () => {
    const token = generateToken(USER_ID, AUTH_SECRET, 7);
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('ll5');

    // Second part should be valid base64url
    expect(() => Buffer.from(parts[1], 'base64url')).not.toThrow();

    // Third part should be 32-char hex
    expect(parts[2]).toMatch(/^[0-9a-f]{32}$/);
  });

  it('embeds correct payload (uid, role, iat, exp)', () => {
    const before = Math.floor(Date.now() / 1000);
    const token = generateToken(USER_ID, AUTH_SECRET, 7);
    const after = Math.floor(Date.now() / 1000);

    const payloadB64 = token.split('.')[1];
    const payload: TokenPayload = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString(),
    );

    expect(payload.uid).toBe(USER_ID);
    expect(payload.role).toBe('user');
    expect(payload.iat).toBeGreaterThanOrEqual(before);
    expect(payload.iat).toBeLessThanOrEqual(after);
    expect(payload.exp).toBe(payload.iat + 7 * 86400);
  });

  it('respects custom role', () => {
    const token = generateToken(USER_ID, AUTH_SECRET, 7, 'admin');
    const payloadB64 = token.split('.')[1];
    const payload: TokenPayload = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString(),
    );
    expect(payload.role).toBe('admin');
  });

  it('uses default role of "user"', () => {
    const token = generateToken(USER_ID, AUTH_SECRET, 7);
    const payloadB64 = token.split('.')[1];
    const payload: TokenPayload = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString(),
    );
    expect(payload.role).toBe('user');
  });

  it('produces different tokens for different users', () => {
    const t1 = generateToken('user-aaa', AUTH_SECRET, 7);
    const t2 = generateToken('user-bbb', AUTH_SECRET, 7);
    expect(t1).not.toBe(t2);
  });

  it('produces different tokens for different secrets', () => {
    const t1 = generateToken(USER_ID, 'secret-1', 7);
    const t2 = generateToken(USER_ID, 'secret-2', 7);
    // Same payload but different signatures
    expect(t1.split('.')[2]).not.toBe(t2.split('.')[2]);
  });
});

// ---------------------------------------------------------------------------
// validateToken
// ---------------------------------------------------------------------------

describe('validateToken', () => {
  it('accepts a valid token and returns payload', () => {
    const token = generateToken(USER_ID, AUTH_SECRET, 7);
    const payload = validateToken(`Bearer ${token}`, AUTH_SECRET);

    expect(payload).not.toBeNull();
    expect(payload!.uid).toBe(USER_ID);
    expect(payload!.role).toBe('user');
    expect(typeof payload!.iat).toBe('number');
    expect(typeof payload!.exp).toBe('number');
  });

  it('rejects token without Bearer prefix', () => {
    const token = generateToken(USER_ID, AUTH_SECRET, 7);
    const result = validateToken(token, AUTH_SECRET);
    expect(result).toBeNull();
  });

  it('rejects non-ll5 Bearer token', () => {
    const result = validateToken('Bearer jwt.some.token', AUTH_SECRET);
    expect(result).toBeNull();
  });

  it('rejects token with wrong number of parts', () => {
    const result = validateToken('Bearer ll5.onlyonepart', AUTH_SECRET);
    expect(result).toBeNull();
  });

  it('rejects token with wrong signature length', () => {
    const token = generateToken(USER_ID, AUTH_SECRET, 7);
    const parts = token.split('.');
    const result = validateToken(`Bearer ll5.${parts[1]}.tooshort`, AUTH_SECRET);
    expect(result).toBeNull();
  });

  it('throws TOKEN_EXPIRED for expired tokens', () => {
    // Generate a token that expired in the past
    const now = Math.floor(Date.now() / 1000);
    const expiredPayload = {
      uid: USER_ID,
      role: 'user',
      iat: now - 86400 * 30,
      exp: now - 86400, // expired 1 day ago
    };

    const payloadB64 = Buffer.from(JSON.stringify(expiredPayload)).toString('base64url');
    const crypto = require('node:crypto');
    const signature = crypto
      .createHmac('sha256', AUTH_SECRET)
      .update(payloadB64)
      .digest('hex')
      .slice(0, 32);

    const expiredToken = `ll5.${payloadB64}.${signature}`;

    expect(() => validateToken(`Bearer ${expiredToken}`, AUTH_SECRET)).toThrow('Token expired');

    try {
      validateToken(`Bearer ${expiredToken}`, AUTH_SECRET);
    } catch (err) {
      expect(isTokenExpiredError(err)).toBe(true);
      expect((err as TokenExpiredError).code).toBe('TOKEN_EXPIRED');
      expect((err as TokenExpiredError).payload.uid).toBe(USER_ID);
    }
  });

  it('rejects tampered signature', () => {
    const token = generateToken(USER_ID, AUTH_SECRET, 7);
    const parts = token.split('.');
    // Flip one hex char in the signature
    const lastChar = parts[2].slice(-1);
    parts[2] = parts[2].slice(0, -1) + (lastChar === 'a' ? 'b' : 'a');
    const tampered = parts.join('.');

    const result = validateToken(`Bearer ${tampered}`, AUTH_SECRET);
    expect(result).toBeNull();
  });

  it('rejects tampered payload', () => {
    const token = generateToken(USER_ID, AUTH_SECRET, 7);
    const parts = token.split('.');
    // Decode payload, change user, re-encode (signature won't match)
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    payload.uid = 'evil-user-id';
    parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const tampered = parts.join('.');

    const result = validateToken(`Bearer ${tampered}`, AUTH_SECRET);
    expect(result).toBeNull();
  });

  it('rejects token with wrong secret', () => {
    const token = generateToken(USER_ID, 'correct-secret', 7);
    const result = validateToken(`Bearer ${token}`, 'wrong-secret');
    expect(result).toBeNull();
  });

  it('rejects malformed base64 payload', () => {
    // Create a token with invalid base64 in payload position but valid-looking structure
    const crypto = require('node:crypto');
    const badPayload = '!!!not-valid-base64!!!';
    const sig = crypto
      .createHmac('sha256', AUTH_SECRET)
      .update(badPayload)
      .digest('hex')
      .slice(0, 32);
    const result = validateToken(`Bearer ll5.${badPayload}.${sig}`, AUTH_SECRET);
    expect(result).toBeNull();
  });

  it('defaults role to "user" for tokens without role field', () => {
    // Generate a token manually without the role field
    const crypto = require('node:crypto');
    const now = Math.floor(Date.now() / 1000);
    const payload = { uid: USER_ID, iat: now, exp: now + 86400 };
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto
      .createHmac('sha256', AUTH_SECRET)
      .update(payloadB64)
      .digest('hex')
      .slice(0, 32);

    const result = validateToken(`Bearer ll5.${payloadB64}.${sig}`, AUTH_SECRET);
    expect(result).not.toBeNull();
    expect(result!.role).toBe('user');
  });

  it('rejects payload missing uid', () => {
    const crypto = require('node:crypto');
    const now = Math.floor(Date.now() / 1000);
    const payload = { role: 'user', iat: now, exp: now + 86400 }; // no uid
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto
      .createHmac('sha256', AUTH_SECRET)
      .update(payloadB64)
      .digest('hex')
      .slice(0, 32);

    const result = validateToken(`Bearer ll5.${payloadB64}.${sig}`, AUTH_SECRET);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isTokenExpiredError
// ---------------------------------------------------------------------------

describe('isTokenExpiredError', () => {
  it('returns true for TOKEN_EXPIRED errors', () => {
    const err = new Error('Token expired') as TokenExpiredError;
    err.code = 'TOKEN_EXPIRED';
    err.payload = { uid: USER_ID, role: 'user', iat: 0, exp: 0 };
    expect(isTokenExpiredError(err)).toBe(true);
  });

  it('returns false for regular errors', () => {
    expect(isTokenExpiredError(new Error('some error'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isTokenExpiredError('string')).toBe(false);
    expect(isTokenExpiredError(null)).toBe(false);
    expect(isTokenExpiredError(undefined)).toBe(false);
    expect(isTokenExpiredError(42)).toBe(false);
  });
});
