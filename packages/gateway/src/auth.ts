import { Router } from 'express';
import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import type { Pool } from 'pg';
import { generateToken, validateToken, isTokenExpiredError } from '@ll5/shared';
import { logger } from './utils/logger.js';

const REFRESH_GRACE_PERIOD_DAYS = 7; // Allow refresh up to 7 days after expiry

// --- In-memory rate limiter for login attempts ---
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

interface LoginAttempt {
  count: number;
  firstAttempt: number;
}

const loginAttempts = new Map<string, LoginAttempt>();

/** Prune expired entries periodically to prevent memory leak. */
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of loginAttempts) {
    if (now - entry.firstAttempt > LOGIN_WINDOW_MS) {
      loginAttempts.delete(key);
    }
  }
}, LOGIN_WINDOW_MS);

function recordFailedAttempt(loginId: string): void {
  const now = Date.now();
  const existing = loginAttempts.get(loginId);
  if (!existing || now - existing.firstAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.set(loginId, { count: 1, firstAttempt: now });
  } else {
    existing.count++;
  }
}

function isRateLimited(loginId: string): boolean {
  const entry = loginAttempts.get(loginId);
  if (!entry) return false;
  if (Date.now() - entry.firstAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(loginId);
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

function clearAttempts(loginId: string): void {
  loginAttempts.delete(loginId);
}

interface AuthUser {
  user_id: string;
  pin_hash: string;
  name: string | null;
  token_ttl_days: number;
  role: string;
  enabled: boolean;
  username: string | null;
  display_name: string | null;
}

/**
 * Create the /auth router with token issuance endpoint.
 */
export function createAuthRouter(pool: Pool, authSecret: string): Router {
  const router = Router();

  router.post('/token', async (req: Request, res: Response) => {
    const { user_id, username, pin } = req.body as { user_id?: string; username?: string; pin?: string };
    const loginId = user_id || username;

    if (!loginId || !pin) {
      res.status(400).json({ error: 'Missing user_id/username or pin' });
      return;
    }

    // Rate limit check
    if (isRateLimited(loginId)) {
      logger.warn('[auth][issueToken] Rate limited', { loginId });
      res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
      return;
    }

    try {
      const result = await pool.query<AuthUser>(
        'SELECT user_id, pin_hash, name, token_ttl_days, role, enabled, username, display_name FROM auth_users WHERE (user_id::text = $1 OR username = $1) AND enabled = true',
        [loginId],
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      const user = result.rows[0];

      const pinValid = await bcrypt.compare(pin, user.pin_hash);
      if (!pinValid) {
        recordFailedAttempt(loginId);
        logger.warn('[auth][issueToken] Invalid PIN attempt', { userId: loginId });
        res.status(401).json({ error: 'Invalid PIN' });
        return;
      }

      // Successful login — clear rate limit tracking
      clearAttempts(loginId);

      const token = generateToken(user.user_id, authSecret, user.token_ttl_days, user.role);
      const expiresAt = new Date(
        Date.now() + user.token_ttl_days * 86400 * 1000,
      ).toISOString();

      logger.info('[auth][issueToken] Token issued', { userId: user.user_id, username: user.username, ttlDays: user.token_ttl_days });

      res.json({
        token,
        user_id: user.user_id,
        expires_at: expiresAt,
      });
    } catch (err) {
      logger.error('[auth][issueToken] Auth token error', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /auth/refresh — issue a new token using a valid or recently-expired token (no PIN needed)
  router.post('/refresh', async (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      res.status(401).json({ error: 'Missing Authorization header' });
      return;
    }

    try {
      let payload;

      try {
        // Try as valid token first
        payload = validateToken(authHeader, authSecret);
      } catch (err) {
        // If expired, check if within grace period
        if (isTokenExpiredError(err)) {
          payload = err.payload;
          const expiredAt = payload.exp * 1000;
          const graceMs = REFRESH_GRACE_PERIOD_DAYS * 86400 * 1000;
          if (Date.now() - expiredAt > graceMs) {
            logger.warn('[auth][refresh] Token expired beyond grace period', { userId: payload.uid });
            res.status(401).json({ error: 'Token expired beyond grace period. Please login with PIN.' });
            return;
          }
        } else {
          throw err;
        }
      }

      if (!payload) {
        res.status(401).json({ error: 'Invalid token' });
        return;
      }

      // Look up user to get current TTL and role, verify still enabled
      const result = await pool.query<AuthUser>(
        'SELECT user_id, token_ttl_days, role, enabled, username, display_name FROM auth_users WHERE user_id = $1 AND enabled = true',
        [payload.uid],
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'User not found or disabled' });
        return;
      }

      const user = result.rows[0];
      const newToken = generateToken(user.user_id, authSecret, user.token_ttl_days, user.role);
      const expiresAt = new Date(Date.now() + user.token_ttl_days * 86400 * 1000).toISOString();

      logger.info('[auth][refresh] Token refreshed', { userId: user.user_id, ttlDays: user.token_ttl_days });

      res.json({
        token: newToken,
        user_id: user.user_id,
        expires_at: expiresAt,
      });
    } catch (err) {
      logger.error('[auth][refresh] Token refresh error', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
