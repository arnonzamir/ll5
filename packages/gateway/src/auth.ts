import { Router } from 'express';
import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import type { Pool } from 'pg';
import { generateToken } from '@ll5/shared';
import { logger } from './utils/logger.js';

interface AuthUser {
  user_id: string;
  pin_hash: string;
  name: string | null;
  token_ttl_days: number;
}

/**
 * Create the /auth router with token issuance endpoint.
 */
export function createAuthRouter(pool: Pool, authSecret: string): Router {
  const router = Router();

  router.post('/token', async (req: Request, res: Response) => {
    const { user_id, pin } = req.body as { user_id?: string; pin?: string };

    if (!user_id || !pin) {
      res.status(400).json({ error: 'Missing user_id or pin' });
      return;
    }

    try {
      const result = await pool.query<AuthUser>(
        'SELECT user_id, pin_hash, name, token_ttl_days FROM auth_users WHERE user_id = $1',
        [user_id],
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      const user = result.rows[0];

      const pinValid = await bcrypt.compare(pin, user.pin_hash);
      if (!pinValid) {
        logger.warn('Invalid PIN attempt', { userId: user_id });
        res.status(401).json({ error: 'Invalid PIN' });
        return;
      }

      const token = generateToken(user_id, authSecret, user.token_ttl_days);
      const expiresAt = new Date(
        Date.now() + user.token_ttl_days * 86400 * 1000,
      ).toISOString();

      logger.info('Token issued', { userId: user_id, ttlDays: user.token_ttl_days });

      res.json({
        token,
        user_id: user.user_id,
        expires_at: expiresAt,
      });
    } catch (err) {
      logger.error('Auth token error', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
