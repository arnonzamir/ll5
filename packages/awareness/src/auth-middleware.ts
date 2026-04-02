import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { logger } from './utils/logger.js';

export interface AuthenticatedRequest extends Request {
  userId: string;
}

interface TokenPayload {
  uid: string;
  iat: number;
  exp: number;
}

function validateToken(bearer: string, authSecret: string): TokenPayload | null {
  const token = bearer.startsWith('Bearer ') ? bearer.slice(7) : bearer;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'll5') return null;

  const [, payloadB64, signature] = parts;

  const expected = crypto.createHmac('sha256', authSecret)
    .update(payloadB64).digest('hex').slice(0, 32);

  if (signature.length !== 32) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) {
    return null;
  }

  const payload: TokenPayload = JSON.parse(
    Buffer.from(payloadB64, 'base64url').toString()
  );

  if (payload.exp < Date.now() / 1000) return null;

  return payload;
}

export function tokenAuthMiddleware(config: {
  authSecret?: string;
  legacyApiKey?: string;
  legacyUserId?: string;
}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing authorization' });
      return;
    }

    // Try token auth
    if (config.authSecret && authHeader.startsWith('Bearer ll5.')) {
      const payload = validateToken(authHeader, config.authSecret);
      if (payload) {
        (req as AuthenticatedRequest).userId = payload.uid;
        next();
        return;
      }
      // Check if token is expired (valid signature but past exp)
      try {
        const token = authHeader.slice(7);
        const payloadB64 = token.split('.')[1];
        const p = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
        if (p.exp < Date.now() / 1000) {
          res.status(401).json({ error: 'token_expired' });
          return;
        }
      } catch (err) {
        logger.debug('[awareness][auth] Token decode failed', { error: err instanceof Error ? err.message : String(err) });
      }
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    // Legacy API key fallback
    if (config.legacyApiKey && config.legacyUserId) {
      const key = authHeader.slice(7);
      if (key === config.legacyApiKey) {
        (req as AuthenticatedRequest).userId = config.legacyUserId;
        next();
        return;
      }
    }

    res.status(401).json({ error: 'Invalid credentials' });
  };
}
