import crypto from 'node:crypto';
import type { UserContext } from '../types/user.js';
import type { AuthConfig } from './types.js';
import { AuthError } from '../utils/errors.js';

/**
 * Constant-time string equality. A plain `===` on a secret leaks the length of
 * the matching prefix via timing, so the API key compare mirrors the token
 * path: length-guard first (timingSafeEqual throws on unequal buffer lengths,
 * and the guard itself only leaks length, never content), then a constant-time
 * byte compare.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Extract user context from an API key.
 * V1: constant-time comparison against a configured key.
 */
export function extractUserContext(
  authHeader: string | undefined,
  config: AuthConfig,
): UserContext {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new AuthError('Missing or malformed Authorization header');
  }

  const key = authHeader.slice(7);

  if (!timingSafeEqualStr(key, config.apiKey)) {
    throw new AuthError('Invalid API key');
  }

  return {
    userId: config.userId,
  };
}
