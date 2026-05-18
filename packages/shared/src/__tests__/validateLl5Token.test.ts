import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { generateToken, validateLl5Token } from '../auth/token.js';

const AUTH_SECRET = 'test-secret-for-validateLl5Token-abcdef1234567890';
const USER_ID = 'f08f46b3-0a9c-41ae-9e6a-294c697424e4';

// Helper: mint a raw ll5 token without the Bearer prefix, with arbitrary
// payload — so we can exercise edge cases that generateToken doesn't produce.
function mintRawToken(
  payload: Record<string, unknown>,
  secret: string = AUTH_SECRET,
): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', secret)
    .update(payloadB64)
    .digest('hex')
    .slice(0, 32);
  return `ll5.${payloadB64}.${sig}`;
}

describe('validateLl5Token', () => {
  // -------------------------------------------------------------------------
  // happy path
  // -------------------------------------------------------------------------

  it('accepts a freshly generated token and returns claims', () => {
    const token = generateToken(USER_ID, AUTH_SECRET, 7).split('Bearer ').pop()!;
    const result = validateLl5Token(token, AUTH_SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.uid).toBe(USER_ID);
      expect(result.claims.role).toBe('user');
      expect(typeof result.claims.iat).toBe('number');
      expect(typeof result.claims.exp).toBe('number');
    }
  });

  it('preserves admin role through round-trip', () => {
    const token = generateToken(USER_ID, AUTH_SECRET, 7, 'admin');
    const result = validateLl5Token(token, AUTH_SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.role).toBe('admin');
  });

  it('coerces unknown role strings to "user" (no role escalation)', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = mintRawToken({
      uid: USER_ID,
      role: 'superuser',
      iat: now,
      exp: now + 3600,
    });
    const result = validateLl5Token(token, AUTH_SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.role).toBe('user');
  });

  it('defaults missing role to "user"', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = mintRawToken({ uid: USER_ID, iat: now, exp: now + 3600 });
    const result = validateLl5Token(token, AUTH_SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.role).toBe('user');
  });

  // -------------------------------------------------------------------------
  // malformed
  // -------------------------------------------------------------------------

  it('rejects empty string as malformed', () => {
    const result = validateLl5Token('', AUTH_SECRET);
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects two-segment token as malformed', () => {
    const result = validateLl5Token('ll5.onlyonepart', AUTH_SECRET);
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects four-segment token as malformed', () => {
    const result = validateLl5Token('ll5.a.b.c', AUTH_SECRET);
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects payload that is not valid base64-json as malformed', () => {
    // Sign the literal "!!!" string so HMAC passes but JSON parse fails.
    const bad = '!!!';
    const sig = crypto
      .createHmac('sha256', AUTH_SECRET)
      .update(bad)
      .digest('hex')
      .slice(0, 32);
    const result = validateLl5Token(`ll5.${bad}.${sig}`, AUTH_SECRET);
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects payload missing uid as malformed', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = mintRawToken({ iat: now, exp: now + 3600 });
    const result = validateLl5Token(token, AUTH_SECRET);
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects payload with non-numeric exp as malformed', () => {
    const token = mintRawToken({ uid: USER_ID, iat: 0, exp: 'soon' });
    const result = validateLl5Token(token, AUTH_SECRET);
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  // -------------------------------------------------------------------------
  // wrong_prefix
  // -------------------------------------------------------------------------

  it('rejects non-ll5 prefix as wrong_prefix', () => {
    const result = validateLl5Token('jwt.payload.sig', AUTH_SECRET);
    expect(result).toEqual({ ok: false, reason: 'wrong_prefix' });
  });

  // -------------------------------------------------------------------------
  // bad_signature
  // -------------------------------------------------------------------------

  it('rejects token whose signature length matches but bytes differ', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = mintRawToken({ uid: USER_ID, iat: now, exp: now + 3600 });
    const parts = token.split('.');
    // Flip one hex char — preserves length, breaks signature
    const last = parts[2].slice(-1);
    parts[2] = parts[2].slice(0, -1) + (last === 'a' ? 'b' : 'a');
    const result = validateLl5Token(parts.join('.'), AUTH_SECRET);
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects token whose signature length differs (length-mismatch path)', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = mintRawToken({ uid: USER_ID, iat: now, exp: now + 3600 });
    const parts = token.split('.');
    parts[2] = 'tooshort';
    const result = validateLl5Token(parts.join('.'), AUTH_SECRET);
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects token signed with a different secret', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = mintRawToken(
      { uid: USER_ID, iat: now, exp: now + 3600 },
      'other-secret',
    );
    const result = validateLl5Token(token, AUTH_SECRET);
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects token with tampered payload (signature no longer matches)', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = mintRawToken({ uid: USER_ID, iat: now, exp: now + 3600 });
    const parts = token.split('.');
    // Re-encode a different payload but keep the original signature
    const evil = Buffer.from(
      JSON.stringify({ uid: 'evil', iat: now, exp: now + 3600 }),
    ).toString('base64url');
    parts[1] = evil;
    const result = validateLl5Token(parts.join('.'), AUTH_SECRET);
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects signature with non-hex characters (decodes to empty buffer)', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = mintRawToken({ uid: USER_ID, iat: now, exp: now + 3600 });
    const parts = token.split('.');
    parts[2] = '!'.repeat(32); // matches length, not valid hex
    const result = validateLl5Token(parts.join('.'), AUTH_SECRET);
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  // -------------------------------------------------------------------------
  // expired
  // -------------------------------------------------------------------------

  it('rejects expired token', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = mintRawToken({
      uid: USER_ID,
      iat: now - 7200,
      exp: now - 3600, // expired 1h ago
    });
    const result = validateLl5Token(token, AUTH_SECRET);
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('respects custom now (synthetic clock)', () => {
    const realNow = Math.floor(Date.now() / 1000);
    const token = mintRawToken({
      uid: USER_ID,
      iat: realNow,
      exp: realNow + 60,
    });
    // Pretend it is 10 minutes from now — token should be expired
    const result = validateLl5Token(token, AUTH_SECRET, { now: realNow + 600 });
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('grace period extends acceptance window', () => {
    const realNow = Math.floor(Date.now() / 1000);
    // Token that expired 5 minutes ago
    const token = mintRawToken({
      uid: USER_ID,
      iat: realNow - 1000,
      exp: realNow - 300,
    });
    // Without grace: expired
    expect(validateLl5Token(token, AUTH_SECRET).ok).toBe(false);
    // With 10-min grace: accepted
    const result = validateLl5Token(token, AUTH_SECRET, {
      gracePeriodSeconds: 600,
    });
    expect(result.ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // role assertion (callers must still check role themselves; this just
  // documents that the helper exposes role)
  // -------------------------------------------------------------------------

  it('exposes role for caller-side authorization checks', () => {
    const adminToken = generateToken(USER_ID, AUTH_SECRET, 7, 'admin');
    const userToken = generateToken(USER_ID, AUTH_SECRET, 7, 'user');

    const adminResult = validateLl5Token(adminToken, AUTH_SECRET);
    const userResult = validateLl5Token(userToken, AUTH_SECRET);

    expect(adminResult.ok && adminResult.claims.role).toBe('admin');
    expect(userResult.ok && userResult.claims.role).toBe('user');
  });
});
