import { Router } from 'express';
import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { generateToken } from '@ll5/shared';
import { requireAdmin } from './admin.js';
import { logger } from './utils/logger.js';
import { getEmailSender } from './utils/email.js';

const BCRYPT_SALT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 8;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_TOKEN_TTL_DAYS = 7;
const VALID_ROLES = ['user', 'admin', 'child'];

interface AdminRequest extends Request {
  adminUserId: string;
}

/** sha256 hex of a raw token — what we store; raw token is only emailed. */
function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Create the invites router. Admin routes (/admin/invites*) are gated by
 * requireAdmin; the validate/accept routes are public (token-gated).
 *
 * NOTE: this router is mounted at the app root so it owns both `/admin/invites`
 * and `/invites/*` paths.
 */
export function createInvitesRouter(pool: Pool, authSecret: string, dashboardUrl: string): Router {
  const router = Router();
  const admin = requireAdmin(authSecret);
  const emailSender = getEmailSender();

  // ---------------------------------------------------------------------------
  // POST /admin/invites — create an invite (admin only)
  // ---------------------------------------------------------------------------
  router.post('/admin/invites', admin, async (req: Request, res: Response) => {
    const { email, role } = req.body as { email?: string; role?: string };

    if (!email || typeof email !== 'string') {
      res.status(400).json({ error: 'email is required' });
      return;
    }

    const inviteRole = role ?? 'user';
    if (!VALID_ROLES.includes(inviteRole)) {
      res.status(400).json({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}` });
      return;
    }

    try {
      const invitedBy = (req as AdminRequest).adminUserId;
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashToken(rawToken);
      const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

      const result = await pool.query<{
        id: string;
        email: string;
        role: string;
        expires_at: string;
      }>(
        `INSERT INTO invites (email, token_hash, invited_by, role, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, email, role, expires_at`,
        [email, tokenHash, invitedBy, inviteRole, expiresAt],
      );

      const invite = result.rows[0];
      const acceptUrl = `${dashboardUrl}/accept-invite?token=${rawToken}`;

      logger.info('[invites][create] Invite created', {
        inviteId: invite.id,
        invitedBy,
        role: inviteRole,
      });

      await emailSender.send({
        to: email,
        subject: "You're invited to LL5",
        text: `You've been invited to LL5. Accept your invite and set a password here (valid for 7 days):\n\n${acceptUrl}`,
      });

      res.status(201).json({
        invite: {
          id: invite.id,
          email: invite.email,
          role: invite.role,
          expires_at: invite.expires_at,
        },
        accept_url: acceptUrl,
      });
    } catch (err) {
      logger.error('[invites][create] Failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /admin/invites — list invites (admin only). Never returns token_hash.
  // Pending = not accepted & not expired; plus recent accepted (last 30 days).
  // ---------------------------------------------------------------------------
  router.get('/admin/invites', admin, async (_req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `SELECT id, email, role, invited_by, expires_at, accepted_at, created_at,
                (accepted_at IS NULL AND expires_at > now()) AS pending
         FROM invites
         WHERE (accepted_at IS NULL AND expires_at > now())
            OR accepted_at > now() - interval '30 days'
         ORDER BY created_at DESC`,
      );
      res.json({ invites: result.rows });
    } catch (err) {
      logger.error('[invites][list] Failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ---------------------------------------------------------------------------
  // DELETE /admin/invites/:id — revoke an invite (admin only)
  // ---------------------------------------------------------------------------
  router.delete('/admin/invites/:id', admin, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        'DELETE FROM invites WHERE id = $1 RETURNING id',
        [req.params.id],
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Invite not found' });
        return;
      }

      logger.info('[invites][revoke] Invite revoked', { inviteId: req.params.id });
      res.json({ deleted: true });
    } catch (err) {
      logger.error('[invites][revoke] Failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /invites/validate?token=... — PUBLIC. Check an invite token.
  // Returns { valid, email? } — valid only if not accepted & not expired.
  // ---------------------------------------------------------------------------
  router.get('/invites/validate', async (req: Request, res: Response) => {
    const token = req.query.token;
    if (!token || typeof token !== 'string') {
      res.status(400).json({ error: 'token is required' });
      return;
    }

    try {
      const tokenHash = hashToken(token);
      const result = await pool.query<{ email: string }>(
        `SELECT email FROM invites
         WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now()`,
        [tokenHash],
      );

      if (result.rows.length === 0) {
        res.json({ valid: false });
        return;
      }

      res.json({ valid: true, email: result.rows[0].email });
    } catch (err) {
      logger.error('[invites][validate] Failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /invites/accept — PUBLIC (token-gated). Create the user from an invite.
  // Wrapped in a transaction so a failed user-create does not consume the invite.
  // ---------------------------------------------------------------------------
  router.post('/invites/accept', async (req: Request, res: Response) => {
    const { token, password, display_name, username } = req.body as {
      token?: string;
      password?: string;
      display_name?: string;
      username?: string;
    };

    if (!token || !password) {
      res.status(400).json({ error: 'token and password are required' });
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      return;
    }

    const tokenHash = hashToken(token);
    let client: PoolClient | undefined;

    try {
      client = await pool.connect();
      await client.query('BEGIN');

      // Lock the invite row so two concurrent accepts can't both consume it.
      const inviteResult = await client.query<{
        id: string;
        email: string;
        role: string;
      }>(
        `SELECT id, email, role FROM invites
         WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now()
         FOR UPDATE`,
        [tokenHash],
      );

      if (inviteResult.rows.length === 0) {
        await client.query('ROLLBACK');
        logger.warn('[invites][accept] Invalid, expired, or already-accepted invite');
        res.status(400).json({ error: 'Invalid or expired invite' });
        return;
      }

      const invite = inviteResult.rows[0];

      // Reject duplicate username up front (clear 409 vs. opaque 500).
      if (username) {
        const dup = await client.query('SELECT user_id FROM auth_users WHERE username = $1', [username]);
        if (dup.rows.length > 0) {
          await client.query('ROLLBACK');
          res.status(409).json({ error: 'Username already taken' });
          return;
        }
      }

      const userId = crypto.randomUUID();
      const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
      // pin_hash is NOT NULL; users created via invite have no PIN, so store a
      // decoy bcrypt hash that can never match a real PIN (random 32 bytes).
      const decoyPin = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), BCRYPT_SALT_ROUNDS);

      const userResult = await client.query<{ token_ttl_days: number }>(
        `INSERT INTO auth_users
           (user_id, username, display_name, email, password_hash, email_verified, pin_hash, role, enabled)
         VALUES ($1, $2, $3, $4, $5, true, $6, $7, true)
         RETURNING token_ttl_days`,
        [
          userId,
          username ?? null,
          display_name ?? null,
          invite.email,
          passwordHash,
          decoyPin,
          invite.role,
        ],
      );

      const ttlDays = userResult.rows[0]?.token_ttl_days ?? DEFAULT_TOKEN_TTL_DAYS;

      // Seed onboarding state (mirror admin.ts createUser).
      await client.query(
        `INSERT INTO user_settings (user_id, settings, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (user_id) DO UPDATE SET
           settings = user_settings.settings || $2::jsonb,
           updated_at = now()`,
        [userId, JSON.stringify({ onboarding: { completed: false, steps: {} } })],
      );

      // Consume the invite.
      await client.query(
        'UPDATE invites SET accepted_at = now() WHERE id = $1',
        [invite.id],
      );

      await client.query('COMMIT');

      const sessionToken = generateToken(userId, authSecret, ttlDays, invite.role);

      logger.info('[invites][accept] Invite accepted, user created', {
        inviteId: invite.id,
        userId,
        role: invite.role,
      });

      res.status(201).json({ token: sessionToken, user_id: userId });
    } catch (err) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* ignore rollback error */
        }
      }
      // Unique-violation on lower(email) index → email already registered.
      if (err instanceof Error && /idx_auth_users_lower_email|auth_users.*email/i.test(err.message)) {
        res.status(409).json({ error: 'Email already registered' });
        return;
      }
      if (err instanceof Error && /idx_auth_users_username|username/i.test(err.message)) {
        res.status(409).json({ error: 'Username already taken' });
        return;
      }
      logger.error('[invites][accept] Failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      if (client) client.release();
    }
  });

  return router;
}
