import type { UserContext } from '../types/user.js';
import type { AuthConfig } from './types.js';
import { AuthError } from '../utils/errors.js';

/**
 * Extract user context from an API key.
 * V1: simple comparison against a configured key.
 */
export function extractUserContext(
  authHeader: string | undefined,
  config: AuthConfig,
): UserContext {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new AuthError('Missing or malformed Authorization header');
  }

  const key = authHeader.slice(7);

  if (key !== config.apiKey) {
    throw new AuthError('Invalid API key');
  }

  return {
    userId: config.userId,
  };
}
