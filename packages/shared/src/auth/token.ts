import crypto from 'node:crypto';

export interface TokenPayload {
  uid: string;
  role: string;
  iat: number;
  exp: number;
}

/**
 * Generate a signed LL5 token.
 * Format: ll5.<base64url_payload>.<32char_hex_signature>
 */
export function generateToken(userId: string, authSecret: string, ttlDays: number, role: string = 'user'): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: TokenPayload = {
    uid: userId,
    role,
    iat: now,
    exp: now + ttlDays * 86400,
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', authSecret)
    .update(payloadB64)
    .digest('hex')
    .slice(0, 32);

  return `ll5.${payloadB64}.${signature}`;
}

/**
 * Validate an LL5 token from an Authorization header value.
 * Returns the decoded payload, or null if invalid.
 *
 * For expired tokens that have a valid signature, throws an
 * ExpiredTokenError so callers can distinguish expired from invalid.
 */
export function validateToken(authHeader: string, authSecret: string): TokenPayload | null {
  if (!authHeader.startsWith('Bearer ll5.')) return null;

  const token = authHeader.slice(7); // remove "Bearer "
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'll5') return null;

  const [, payloadB64, signature] = parts;

  if (!payloadB64 || !signature || signature.length !== 32) return null;

  // Verify signature with timing-safe comparison
  const expected = crypto
    .createHmac('sha256', authSecret)
    .update(payloadB64)
    .digest('hex')
    .slice(0, 32);

  let signatureBuffer: Buffer;
  let expectedBuffer: Buffer;
  try {
    signatureBuffer = Buffer.from(signature, 'hex');
    expectedBuffer = Buffer.from(expected, 'hex');
  } catch (err) {
    console.debug('[validateToken] Failed to decode signature hex:', (err as Error).message);
    return null;
  }

  if (signatureBuffer.length !== expectedBuffer.length) return null;
  if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) return null;

  // Decode payload
  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()) as TokenPayload;
  } catch (err) {
    console.debug('[validateToken] Failed to decode token payload:', (err as Error).message);
    return null;
  }

  // Default role for tokens generated before role was added
  if (!payload.role) payload.role = 'user';
  if (!payload.uid || typeof payload.exp !== 'number' || typeof payload.iat !== 'number') {
    return null;
  }

  // Check expiry — signature is valid but token expired
  if (payload.exp < Date.now() / 1000) {
    const err = new Error('Token expired');
    (err as TokenExpiredError).code = 'TOKEN_EXPIRED';
    (err as TokenExpiredError).payload = payload;
    throw err;
  }

  return payload;
}

export interface TokenExpiredError extends Error {
  code: 'TOKEN_EXPIRED';
  payload: TokenPayload;
}

export function isTokenExpiredError(err: unknown): err is TokenExpiredError {
  return err instanceof Error && (err as TokenExpiredError).code === 'TOKEN_EXPIRED';
}

// ---------------------------------------------------------------------------
// validateLl5Token — the single source of truth for ll5.* token validation.
//
// The four call sites in the gateway (chat auth middleware, admin middleware,
// webhook path-token handler, webhook Bearer handler) all used to inline the
// same parse-and-verify logic with slight drift between copies. They now all
// delegate here. Pure, no I/O, easy to unit-test. Constant-time HMAC compare
// via crypto.timingSafeEqual after a length-equality guard so the compare
// never throws on length mismatch.
// ---------------------------------------------------------------------------

export interface TokenClaims {
  uid: string;
  role: 'admin' | 'user';
  iat: number;
  exp: number;
}

export type ValidationResult =
  | { ok: true; claims: TokenClaims }
  | {
      ok: false;
      reason: 'malformed' | 'bad_signature' | 'expired' | 'wrong_prefix';
    };

export interface ValidateLl5TokenOptions {
  /** Current time in seconds since epoch. Defaults to `Date.now() / 1000`. */
  now?: number;
  /** Extra seconds of slack allowed past `exp`. Defaults to 0. */
  gracePeriodSeconds?: number;
}

/**
 * Validate a raw `ll5.<payloadB64>.<32-hex hmac>` token.
 *
 * Pass the bare token, not an `Authorization` header. The caller decides how
 * the token was conveyed (Bearer header, ?token=, or path segment) and
 * extracts it before calling here.
 *
 * Returns a discriminated union — never throws.
 */
export function validateLl5Token(
  token: string,
  authSecret: string,
  opts: ValidateLl5TokenOptions = {},
): ValidationResult {
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: 'malformed' };
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return { ok: false, reason: 'malformed' };
  }
  if (parts[0] !== 'll5') {
    return { ok: false, reason: 'wrong_prefix' };
  }

  const [, payloadB64, signature] = parts;
  if (!payloadB64 || !signature) {
    return { ok: false, reason: 'malformed' };
  }

  // Compute expected signature first so the length compare below operates on a
  // known-good buffer. The HMAC is always 32 hex chars (16 bytes of sha256
  // truncated). A mismatched length is treated as bad_signature, not
  // malformed, so we don't leak structural details about the token format.
  const expectedHex = crypto
    .createHmac('sha256', authSecret)
    .update(payloadB64)
    .digest('hex')
    .slice(0, 32);

  // Length-equality guard — required so timingSafeEqual doesn't throw on
  // mismatched buffer sizes. This is the one branch that depends on input
  // length, but it's a fixed expected length so no secret leaks.
  if (signature.length !== expectedHex.length) {
    return { ok: false, reason: 'bad_signature' };
  }

  let sigBuf: Buffer;
  let expBuf: Buffer;
  try {
    sigBuf = Buffer.from(signature, 'hex');
    expBuf = Buffer.from(expectedHex, 'hex');
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
  // Buffer.from with invalid hex silently truncates rather than throws, so
  // double-check that the decoded length matches what 32 hex chars should
  // yield (16 bytes). Anything else means the signature wasn't valid hex.
  if (sigBuf.length !== expBuf.length || sigBuf.length === 0) {
    return { ok: false, reason: 'bad_signature' };
  }

  if (!crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'malformed' };
  }

  const obj = raw as Record<string, unknown>;
  const uid = obj.uid;
  const iat = obj.iat;
  const exp = obj.exp;
  const roleRaw = obj.role;

  if (typeof uid !== 'string' || uid.length === 0) {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof iat !== 'number' || typeof exp !== 'number') {
    return { ok: false, reason: 'malformed' };
  }

  // Tokens minted before the role field existed default to 'user'.
  const role: 'admin' | 'user' =
    roleRaw === 'admin' ? 'admin' : 'user';

  const now = opts.now ?? Date.now() / 1000;
  const grace = opts.gracePeriodSeconds ?? 0;
  if (exp + grace < now) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, claims: { uid, role, iat, exp } };
}
