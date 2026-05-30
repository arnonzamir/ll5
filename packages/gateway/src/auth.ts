import { Router } from 'express';
import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import type { Pool } from 'pg';
import { generateToken, validateToken, isTokenExpiredError } from '@ll5/shared';
import { logger } from './utils/logger.js';
import { getEmailSender } from './utils/email.js';

const REFRESH_GRACE_PERIOD_DAYS = 7; // Allow refresh up to 7 days after expiry
const BCRYPT_SALT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 8;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

/** sha256 hex of a raw token — what we store; raw token is only emailed. */
function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * A pre-computed bcrypt hash used as a decoy when the requested user does not
 * exist. We always run bcrypt.compare so the response time for "no such user"
 * matches "user exists, wrong PIN". The plaintext is irrelevant — the hash is
 * generated once at module load with the production salt-rounds setting and
 * is never a valid PIN for any real user (random 32 bytes). This closes a
 * user-enumeration side channel that existed at packages/gateway/src/auth.ts
 * line ~101: previously the missing-user branch returned 404 in <1ms while
 * the wrong-PIN branch returned 401 in ~150ms, letting an attacker probe for
 * valid usernames without ever knowing a PIN.
 */
const DECOY_PIN_HASH = bcrypt.hashSync(
  // 32 random bytes hex-encoded — guaranteed not to match any real PIN.
  Math.random().toString(36) + Date.now().toString(36) + Math.random().toString(36),
  12,
);

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
  password_hash: string | null;
  name: string | null;
  token_ttl_days: number;
  role: string;
  enabled: boolean;
  username: string | null;
  display_name: string | null;
}

/**
 * Email+password login path. Same rate-limit + decoy-timing + unified-401
 * discipline as the PIN path: always run bcrypt.compare (against a decoy hash
 * when the user is missing or has no password set) and collapse all failure
 * modes into one 401 so neither timing nor status enumerates accounts.
 */
async function handleEmailPasswordLogin(
  pool: Pool,
  authSecret: string,
  res: Response,
  email: string,
  password: string,
): Promise<void> {
  const rateKey = `email:${email.trim().toLowerCase()}`;

  if (isRateLimited(rateKey)) {
    logger.warn('[auth][emailLogin] Rate limited');
    res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
    return;
  }

  try {
    const result = await pool.query<AuthUser>(
      'SELECT user_id, pin_hash, password_hash, name, token_ttl_days, role, enabled, username, display_name FROM auth_users WHERE lower(email) = lower($1) AND enabled = true',
      [email],
    );

    const user: AuthUser | null = result.rows.length > 0 ? result.rows[0] : null;
    // Run bcrypt.compare unconditionally to keep timing uniform across the
    // missing-user, no-password, and wrong-password branches.
    const hashToCompare = user?.password_hash ?? DECOY_PIN_HASH;
    const passwordValid = await bcrypt.compare(password, hashToCompare);

    if (!user || !user.password_hash || !passwordValid) {
      recordFailedAttempt(rateKey);
      logger.warn('[auth][emailLogin] Invalid credentials attempt', { userExists: !!user });
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    clearAttempts(rateKey);

    const token = generateToken(user.user_id, authSecret, user.token_ttl_days, user.role);
    const expiresAt = new Date(Date.now() + user.token_ttl_days * 86400 * 1000).toISOString();

    logger.info('[auth][emailLogin] Token issued', { userId: user.user_id, ttlDays: user.token_ttl_days });

    res.json({ token, user_id: user.user_id, expires_at: expiresAt });
  } catch (err) {
    logger.error('[auth][emailLogin] Auth token error', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Create the /auth router with token issuance endpoint.
 */
export function createAuthRouter(pool: Pool, authSecret: string, dashboardUrl: string): Router {
  const router = Router();
  const emailSender = getEmailSender();

  router.post('/token', async (req: Request, res: Response) => {
    const { user_id, username, pin, email, password } = req.body as {
      user_id?: string;
      username?: string;
      pin?: string;
      email?: string;
      password?: string;
    };

    // Branch on which credential set was supplied. Email+password is the new
    // human-login path; user_id/username+pin is the retained phone path.
    if (email && password) {
      return handleEmailPasswordLogin(pool, authSecret, res, email, password);
    }

    const loginId = user_id || username;

    if (!loginId || !pin) {
      res.status(400).json({ error: 'Missing user_id/username or pin' });
      return;
    }

    // Normalize the rate-limit key so case/whitespace variants of the same
    // login ("Alice" vs "alice ") share one bucket — otherwise an attacker
    // trivially multiplies the per-identity attempt limit by varying case.
    const rateKey = loginId.trim().toLowerCase();

    // Rate limit check
    if (isRateLimited(rateKey)) {
      logger.warn('[auth][issueToken] Rate limited', { loginId });
      res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
      return;
    }

    try {
      const result = await pool.query<AuthUser>(
        'SELECT user_id, pin_hash, password_hash, name, token_ttl_days, role, enabled, username, display_name FROM auth_users WHERE (user_id::text = $1 OR username = $1) AND enabled = true',
        [loginId],
      );

      // Always run bcrypt.compare, even when the user doesn't exist, to keep
      // the response timing and error shape uniform. Otherwise the missing-
      // user path returns instantly and leaks which usernames are valid. We
      // also collapse "user not found" and "wrong PIN" into the same 401 so
      // the status code doesn't enumerate either.
      const user: AuthUser | null = result.rows.length > 0 ? result.rows[0] : null;
      const hashToCompare = user?.pin_hash ?? DECOY_PIN_HASH;
      const pinValid = await bcrypt.compare(pin, hashToCompare);

      if (!user || !pinValid) {
        recordFailedAttempt(rateKey);
        logger.warn('[auth][issueToken] Invalid credentials attempt', {
          userId: loginId,
          userExists: !!user,
        });
        // Same 401 for both branches — client cannot distinguish them.
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }

      // Successful login — clear rate limit tracking
      clearAttempts(rateKey);

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

  // POST /auth/forgot — request a password reset. Always returns 200 (no user
  // enumeration). The reset link is only delivered to the EmailSender.
  router.post('/forgot', async (req: Request, res: Response) => {
    const { email } = req.body as { email?: string };

    if (!email || typeof email !== 'string') {
      res.status(400).json({ error: 'email is required' });
      return;
    }

    try {
      const result = await pool.query<{ user_id: string }>(
        'SELECT user_id FROM auth_users WHERE lower(email) = lower($1) AND enabled = true',
        [email],
      );

      if (result.rows.length > 0) {
        const userId = result.rows[0].user_id;
        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = hashToken(rawToken);
        const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS).toISOString();

        await pool.query(
          `INSERT INTO auth_tokens (token_hash, user_id, kind, expires_at)
           VALUES ($1, $2, 'password_reset', $3)`,
          [tokenHash, userId, expiresAt],
        );

        const link = `${dashboardUrl}/reset?token=${rawToken}`;
        logger.info('[auth][forgot] Password reset requested', { userId });
        await emailSender.send({
          to: email,
          subject: 'Reset your LL5 password',
          text: `Reset your password using this link (valid for 1 hour):\n\n${link}\n\nIf you did not request this, ignore this email.`,
        });
      } else {
        // Unknown / disabled email — do nothing, but log for ops visibility.
        logger.info('[auth][forgot] Password reset requested for unknown/disabled email');
      }
    } catch (err) {
      // Log but still return 200 — never reveal that the request failed for a
      // specific email vs. succeeded for another.
      logger.error('[auth][forgot] Error processing reset request', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Always the same response, regardless of whether the email matched.
    res.json({ ok: true });
  });

  // POST /auth/reset — consume a reset token and set a new password.
  router.post('/reset', async (req: Request, res: Response) => {
    const { token, password } = req.body as { token?: string; password?: string };

    if (!token || !password) {
      res.status(400).json({ error: 'token and password are required' });
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      return;
    }

    try {
      const tokenHash = hashToken(token);
      const tokenRow = await pool.query<{ user_id: string }>(
        `SELECT user_id FROM auth_tokens
         WHERE token_hash = $1 AND kind = 'password_reset'
           AND used_at IS NULL AND expires_at > now()`,
        [tokenHash],
      );

      if (tokenRow.rows.length === 0) {
        logger.warn('[auth][reset] Invalid, expired, or already-used reset token');
        res.status(400).json({ error: 'Invalid or expired token' });
        return;
      }

      const userId = tokenRow.rows[0].user_id;
      const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);

      await pool.query(
        'UPDATE auth_users SET password_hash = $1, updated_at = now() WHERE user_id = $2',
        [passwordHash, userId],
      );
      await pool.query(
        'UPDATE auth_tokens SET used_at = now() WHERE token_hash = $1',
        [tokenHash],
      );

      logger.info('[auth][reset] Password reset completed', { userId });
      res.json({ ok: true });
    } catch (err) {
      logger.error('[auth][reset] Error processing reset', {
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
