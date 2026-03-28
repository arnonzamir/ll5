import type { Request, Response, NextFunction } from 'express';
import { validateToken, isTokenExpiredError } from './token.js';
import type { AuthConfig } from './types.js';

export interface TokenAuthConfig {
  /** HMAC secret for token validation (at least 32 chars) */
  authSecret: string;
  /** Legacy API key auth for backwards compatibility (optional) */
  legacy?: AuthConfig;
}

/**
 * Express middleware that authenticates requests using LL5 tokens.
 * Falls back to legacy API_KEY auth if configured.
 *
 * Sets `req.userId` on success, returns 401 on failure.
 */
export function tokenAuthMiddleware(config: TokenAuthConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      res.status(401).json({ error: 'Missing Authorization header' });
      return;
    }

    // Try token auth first
    if (authHeader.startsWith('Bearer ll5.')) {
      try {
        const payload = validateToken(authHeader, config.authSecret);
        if (payload) {
          (req as AuthenticatedRequest).userId = payload.uid;
          next();
          return;
        }
      } catch (err) {
        if (isTokenExpiredError(err)) {
          res.status(401).json({ error: 'token_expired' });
          return;
        }
      }
      // Token started with ll5. but was invalid
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    // Fall back to legacy API_KEY auth
    if (config.legacy) {
      const key = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (key && key === config.legacy.apiKey) {
        (req as AuthenticatedRequest).userId = config.legacy.userId;
        next();
        return;
      }
    }

    res.status(401).json({ error: 'Invalid credentials' });
  };
}

export interface AuthenticatedRequest extends Request {
  userId: string;
}
