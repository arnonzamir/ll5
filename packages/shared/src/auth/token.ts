import crypto from 'node:crypto';

export interface TokenPayload {
  uid: string;
  iat: number;
  exp: number;
}

/**
 * Generate a signed LL5 token.
 * Format: ll5.<base64url_payload>.<32char_hex_signature>
 */
export function generateToken(userId: string, authSecret: string, ttlDays: number): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: TokenPayload = {
    uid: userId,
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
  } catch {
    return null;
  }

  if (signatureBuffer.length !== expectedBuffer.length) return null;
  if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) return null;

  // Decode payload
  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()) as TokenPayload;
  } catch {
    return null;
  }

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
