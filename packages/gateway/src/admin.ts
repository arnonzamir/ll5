import { Router } from 'express';
import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import type { Pool } from 'pg';
import { validateLl5Token } from '@ll5/shared';
import { logger } from './utils/logger.js';
import {
  defaultOrchestratorClient,
  OrchestratorNotConfiguredError,
  type OrchestratorClient,
} from './utils/orchestrator.js';
import { getHealthSnapshot } from './scheduler/mcp-health-monitor.js';
import { getAllWhatsAppFlowSnapshots } from './scheduler/whatsapp-flow-monitor.js';
import { getAllPhoneLivenessSnapshots } from './scheduler/phone-liveness-monitor.js';
import { getAllAgentOutputSnapshots } from './scheduler/agent-output-monitor.js';
import { getSystemMessageFailureStats } from './utils/system-message.js';
import { getSchedulerHealthSnapshot } from './utils/scheduler-health.js';
import { getFcmStats } from './utils/fcm-sender.js';
import { getChatSearchIndexerStats } from './scheduler/chat-search-indexer.js';
import { getWebhookStats } from './utils/webhook-stats.js';

const BCRYPT_SALT_ROUNDS = 12;
const MIN_PIN_LENGTH = 6;

/** Roles only a superadmin may grant. */
const PRIVILEGED_ROLES = new Set(['admin', 'superadmin']);

/** Common weak PINs that should be rejected. */
const WEAK_PIN_BLOCKLIST = new Set([
  '1234', '0000', '1111', '2222', '3333', '4444',
  '5555', '6666', '7777', '8888', '9999',
  '123456', '654321', '111111', '000000',
]);

/**
 * Validate PIN strength beyond minimum length.
 * Returns an error message if the PIN is too weak, or null if acceptable.
 */
function validatePinStrength(pin: string): string | null {
  if (pin.length < MIN_PIN_LENGTH) {
    return `PIN must be at least ${MIN_PIN_LENGTH} characters`;
  }
  if (WEAK_PIN_BLOCKLIST.has(pin)) {
    return 'PIN is too common and easily guessed. Choose a less predictable PIN.';
  }
  return null;
}

interface AdminRequest extends Request {
  adminUserId: string;
  /** Effective role of the authenticated caller: 'admin' or 'superadmin'. */
  adminRole: 'admin' | 'superadmin';
}

/**
 * Read the real role string from a *signature-verified* ll5 token payload.
 *
 * `validateLl5Token` (in @ll5/shared) narrows its `claims.role` to the historic
 * `'admin' | 'user'` set and collapses anything else (e.g. 'superadmin') to
 * 'user'. Superadmin must be distinguishable here, so after the shared
 * validator has confirmed the HMAC we re-read the role field off the already
 * base64url-decoded payload. The signature is verified at this point, so the
 * payload is trusted; we only widen the role enum the gateway recognizes.
 */
function effectiveRoleFromToken(rawToken: string): string {
  const parts = rawToken.split('.');
  if (parts.length !== 3) return 'user';
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      role?: unknown;
    };
    return typeof payload.role === 'string' ? payload.role : 'user';
  } catch {
    return 'user';
  }
}

/** Roles, lowest → highest. A role satisfies any gate at or below its level. */
const ROLE_RANK: Record<string, number> = {
  user: 0,
  child: 0,
  admin: 1,
  superadmin: 2,
};

/**
 * Shared token-gate builder. Validates the ll5 token, then enforces a minimum
 * effective role. On success sets req.adminUserId + req.adminRole.
 *
 * @param minRole the lowest role allowed through ('admin' or 'superadmin').
 */
function requireRole(authSecret: string, minRole: 'admin' | 'superadmin') {
  const minRank = ROLE_RANK[minRole];
  const tag = minRole === 'superadmin' ? 'requireSuperadmin' : 'requireAdmin';
  return (req: Request, res: Response, next: () => void): void => {
    const authHeader = req.headers.authorization;
    const queryToken = req.query.token as string | undefined;
    const rawToken = authHeader?.startsWith('Bearer ll5.')
      ? authHeader.slice(7)
      : queryToken?.startsWith('ll5.') ? queryToken : null;

    if (!rawToken) {
      res.status(401).json({ error: 'Missing or invalid authorization' });
      return;
    }

    const result = validateLl5Token(rawToken, authSecret);
    if (!result.ok) {
      if (result.reason === 'expired') {
        res.status(401).json({ error: 'token_expired' });
        return;
      }
      if (result.reason === 'malformed' || result.reason === 'wrong_prefix') {
        res.status(401).json({ error: 'Invalid token format' });
        return;
      }
      logger.warn(`[admin][${tag}] Token validation error`, { reason: result.reason });
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    // Signature verified → trust the raw payload role (widens the shared
    // validator's 'admin'|'user' narrowing to include 'superadmin').
    const role = effectiveRoleFromToken(rawToken);
    const rank = ROLE_RANK[role] ?? 0;

    if (rank < minRank) {
      logger.warn(`[admin][${tag}] access_denied`, {
        actor_user_id: result.claims.uid,
        actor_role: role,
        required_role: minRole,
      });
      res.status(403).json({
        error: minRole === 'superadmin' ? 'Superadmin access required' : 'Admin access required',
      });
      return;
    }

    const adminReq = req as AdminRequest;
    adminReq.adminUserId = result.claims.uid;
    adminReq.adminRole = rank >= ROLE_RANK.superadmin ? 'superadmin' : 'admin';
    next();
  };
}

/**
 * Middleware that validates the token and requires the admin role.
 * Superadmin ⊇ admin: a superadmin passes this gate too.
 * Sets req.adminUserId + req.adminRole on success.
 */
export function requireAdmin(authSecret: string) {
  return requireRole(authSecret, 'admin');
}

/**
 * Middleware that validates the token and requires the superadmin role.
 * Sets req.adminUserId + req.adminRole on success.
 */
export function requireSuperadmin(authSecret: string) {
  return requireRole(authSecret, 'superadmin');
}

/** Fields safe to return for a user (never pin_hash). */
const USER_SELECT_FIELDS = 'user_id, username, display_name, role, enabled, created_at, updated_at';

/**
 * Create the /admin router with user and family management endpoints.
 */
export function createAdminRouter(
  pool: Pool,
  authSecret: string,
  orchestrator: OrchestratorClient = defaultOrchestratorClient,
): Router {
  const router = Router();
  const admin = requireAdmin(authSecret);

  /**
   * P5 lifecycle: when a user is disabled, best-effort stop their agent
   * container and mark the runtime stopped. Never throws — a runtime hiccup
   * must not block the disable.
   */
  async function teardownRuntimeOnDisable(targetUserId: string, reason: string): Promise<void> {
    try {
      await orchestrator.stop(targetUserId);
    } catch (err) {
      if (err instanceof OrchestratorNotConfiguredError) {
        logger.info('[admin][lifecycle] runtime stop skipped (orchestrator not configured)', { target_user_id: targetUserId, reason });
      } else {
        logger.warn('[admin][lifecycle] orchestrator stop failed (non-fatal)', {
          target_user_id: targetUserId,
          reason,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Reflect stopped state regardless of orchestrator outcome (best-effort).
    try {
      await pool.query(
        `UPDATE agent_runtimes SET status = 'stopped', updated_at = now() WHERE user_id = $1`,
        [targetUserId],
      );
    } catch (err) {
      logger.warn('[admin][lifecycle] runtime status update failed (non-fatal)', {
        target_user_id: targetUserId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    logger.info('[admin][lifecycle] runtime_stopped', { target_user_id: targetUserId, reason, status: 'stopped' });
  }

  // ---------------------------------------------------------------------------
  // GET /admin/health — aggregate health of all MCPs, gateway, DBs, agent flow
  // Returns the cached snapshot from the failsafe monitors so there's no
  // fan-out penalty per request. Falls back to live DB pings on empty cache.
  // ---------------------------------------------------------------------------
  router.get('/health', admin, async (_req: Request, res: Response) => {
    try {
      const services = getHealthSnapshot();
      const whatsapp = getAllWhatsAppFlowSnapshots();
      const phones = getAllPhoneLivenessSnapshots();
      const agentOutput = getAllAgentOutputSnapshots();

      // Live DB pings on every call — cheap and authoritative
      let pgHealthy = false;
      let pgError: string | null = null;
      try {
        await pool.query('SELECT 1');
        pgHealthy = true;
      } catch (err) {
        pgError = err instanceof Error ? err.message : String(err);
      }

      const systemMessages = getSystemMessageFailureStats();
      const schedulers = getSchedulerHealthSnapshot();
      const schedulersUnhealthy = schedulers.filter(
        (s) => s.consecutive_failures >= 3,
      ).length;
      const fcm = getFcmStats();
      const chatIndexer = getChatSearchIndexerStats();
      const webhook = getWebhookStats();

      res.json({
        services,
        whatsapp,
        phones,
        agent_output: agentOutput,
        system_messages: systemMessages,
        schedulers,
        fcm,
        chat_indexer: chatIndexer,
        webhook,
        databases: {
          postgres: { healthy: pgHealthy, error: pgError },
        },
        summary: {
          services_total: services.length,
          services_unhealthy: services.filter((s) => !s.healthy).length,
          whatsapp_stale: whatsapp.filter((w) => w.stale).length,
          phones_stale: phones.filter((p) => p.stale).length,
          agent_output_stale: agentOutput.filter((a) => a.stale).length,
          system_message_failures: systemMessages.total_failures,
          schedulers_unhealthy: schedulersUnhealthy,
          fcm_failures: fcm.total_failures,
          webhook_failures: webhook.total_failures,
        },
        checked_at: new Date().toISOString(),
      });
    } catch (err) {
      logger.error('[admin][health] Failed', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /admin/users — list all users
  // ---------------------------------------------------------------------------
  router.get('/users', admin, async (_req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `SELECT ${USER_SELECT_FIELDS} FROM auth_users ORDER BY created_at ASC`,
      );
      res.json({ users: result.rows });
    } catch (err) {
      logger.error('[admin][listUsers] Failed', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /admin/users/:id — get single user with family memberships
  // ---------------------------------------------------------------------------
  router.get('/users/:id', admin, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `SELECT ${USER_SELECT_FIELDS} FROM auth_users WHERE user_id = $1`,
        [req.params.id],
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      const user = result.rows[0];

      // Fetch family memberships
      const families = await pool.query(
        `SELECT f.id AS family_id, f.name AS family_name, fm.role, fm.created_at AS joined_at
         FROM family_members fm
         JOIN families f ON f.id = fm.family_id
         WHERE fm.user_id = $1
         ORDER BY fm.created_at ASC`,
        [req.params.id],
      );

      res.json({ ...user, families: families.rows });
    } catch (err) {
      logger.error('[admin][getUser] Failed', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /admin/users — create user
  // ---------------------------------------------------------------------------
  router.post('/users', admin, async (req: Request, res: Response) => {
    const { username, display_name, pin, role, timezone } = req.body as {
      username?: string;
      display_name?: string;
      pin?: string;
      role?: string;
      timezone?: string;
    };

    if (!username || !display_name || !pin) {
      res.status(400).json({ error: 'username, display_name, and pin are required' });
      return;
    }

    const pinError = validatePinStrength(pin);
    if (pinError) {
      res.status(400).json({ error: pinError });
      return;
    }

    const validRoles = ['user', 'admin', 'child', 'superadmin'];
    const userRole = role || 'user';
    if (!validRoles.includes(userRole)) {
      res.status(400).json({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}` });
      return;
    }
    // Only a superadmin may grant elevated roles.
    if (PRIVILEGED_ROLES.has(userRole) && (req as AdminRequest).adminRole !== 'superadmin') {
      logger.warn('[admin][createUser] privileged_role_denied', {
        actor_user_id: (req as AdminRequest).adminUserId,
        actor_role: (req as AdminRequest).adminRole,
        attempted_role: userRole,
      });
      res.status(403).json({ error: 'Only a superadmin may assign the admin or superadmin role' });
      return;
    }

    try {
      // Check for duplicate username
      const existing = await pool.query(
        'SELECT user_id FROM auth_users WHERE username = $1',
        [username],
      );
      if (existing.rows.length > 0) {
        res.status(409).json({ error: 'Username already taken' });
        return;
      }

      const userId = crypto.randomUUID();
      const pinHash = await bcrypt.hash(pin, BCRYPT_SALT_ROUNDS);

      const result = await pool.query(
        `INSERT INTO auth_users (user_id, username, display_name, pin_hash, role, enabled)
         VALUES ($1, $2, $3, $4, $5, true)
         RETURNING ${USER_SELECT_FIELDS}`,
        [userId, username, display_name, pinHash, userRole],
      );

      // Initialize user_settings with onboarding state (and timezone if provided)
      const initialSettings: Record<string, unknown> = {
        onboarding: { completed: false, steps: {} },
      };
      if (timezone) {
        initialSettings.timezone = timezone;
      }
      await pool.query(
        `INSERT INTO user_settings (user_id, settings, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (user_id) DO UPDATE SET
           settings = user_settings.settings || $2::jsonb,
           updated_at = now()`,
        [userId, JSON.stringify(initialSettings)],
      );

      logger.info('[admin][createUser] User created', { userId, username, role: userRole });
      if (PRIVILEGED_ROLES.has(userRole)) {
        logger.info('[admin][createUser] role_granted', {
          actor_user_id: (req as AdminRequest).adminUserId,
          actor_role: (req as AdminRequest).adminRole,
          target_user_id: userId,
          granted_role: userRole,
        });
      }
      res.status(201).json(result.rows[0]);
    } catch (err) {
      logger.error('[admin][createUser] Failed', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ---------------------------------------------------------------------------
  // PATCH /admin/users/:id — update user
  // ---------------------------------------------------------------------------
  router.patch('/users/:id', admin, async (req: Request, res: Response) => {
    const { username, display_name, role, enabled, timezone } = req.body as {
      username?: string;
      display_name?: string;
      role?: string;
      enabled?: boolean;
      timezone?: string;
    };

    const updates: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (username !== undefined) {
      updates.push(`username = $${paramIdx++}`);
      params.push(username);
    }
    if (display_name !== undefined) {
      updates.push(`display_name = $${paramIdx++}`);
      params.push(display_name);
    }
    if (role !== undefined) {
      const validRoles = ['user', 'admin', 'child', 'superadmin'];
      if (!validRoles.includes(role)) {
        res.status(400).json({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}` });
        return;
      }
      // Only a superadmin may grant elevated roles.
      if (PRIVILEGED_ROLES.has(role) && (req as AdminRequest).adminRole !== 'superadmin') {
        logger.warn('[admin][updateUser] privileged_role_denied', {
          actor_user_id: (req as AdminRequest).adminUserId,
          actor_role: (req as AdminRequest).adminRole,
          target_user_id: req.params.id,
          attempted_role: role,
        });
        res.status(403).json({ error: 'Only a superadmin may assign the admin or superadmin role' });
        return;
      }
      updates.push(`role = $${paramIdx++}`);
      params.push(role);
    }
    if (enabled !== undefined) {
      updates.push(`enabled = $${paramIdx++}`);
      params.push(enabled);
    }

    if (updates.length === 0 && timezone === undefined) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    try {
      if (updates.length > 0) {
        updates.push(`updated_at = now()`);
        params.push(req.params.id);

        const result = await pool.query(
          `UPDATE auth_users SET ${updates.join(', ')} WHERE user_id = $${paramIdx}
           RETURNING ${USER_SELECT_FIELDS}`,
          params,
        );

        if (result.rows.length === 0) {
          res.status(404).json({ error: 'User not found' });
          return;
        }

        // If timezone provided, also update user_settings
        if (timezone !== undefined) {
          await pool.query(
            `INSERT INTO user_settings (user_id, settings, updated_at)
             VALUES ($1, $2, now())
             ON CONFLICT (user_id) DO UPDATE SET
               settings = user_settings.settings || $2::jsonb,
               updated_at = now()`,
            [req.params.id, JSON.stringify({ timezone })],
          );
        }

        logger.info('[admin][updateUser] User updated', { userId: req.params.id, fields: Object.keys(req.body) });
        if (role !== undefined) {
          logger.info('[admin][updateUser] role_changed', {
            actor_user_id: (req as AdminRequest).adminUserId,
            actor_role: (req as AdminRequest).adminRole,
            target_user_id: req.params.id,
            new_role: role,
          });
        }
        // P5 lifecycle: disabling a user tears down their agent container.
        if (enabled === false) {
          await teardownRuntimeOnDisable(String(req.params.id), 'user_disabled');
        }
        res.json(result.rows[0]);
      } else {
        // Only timezone update — verify user exists first
        const userCheck = await pool.query(
          `SELECT ${USER_SELECT_FIELDS} FROM auth_users WHERE user_id = $1`,
          [req.params.id],
        );
        if (userCheck.rows.length === 0) {
          res.status(404).json({ error: 'User not found' });
          return;
        }

        await pool.query(
          `INSERT INTO user_settings (user_id, settings, updated_at)
           VALUES ($1, $2, now())
           ON CONFLICT (user_id) DO UPDATE SET
             settings = user_settings.settings || $2::jsonb,
             updated_at = now()`,
          [req.params.id, JSON.stringify({ timezone })],
        );

        logger.info('[admin][updateUser] User timezone updated', { userId: req.params.id, timezone });
        res.json(userCheck.rows[0]);
      }
    } catch (err) {
      // Handle unique constraint violation on username
      if (err instanceof Error && err.message.includes('idx_auth_users_username')) {
        res.status(409).json({ error: 'Username already taken' });
        return;
      }
      logger.error('[admin][updateUser] Failed', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /admin/users/:id/pin — reset PIN
  // ---------------------------------------------------------------------------
  router.post('/users/:id/pin', admin, async (req: Request, res: Response) => {
    const { pin } = req.body as { pin?: string };

    if (!pin) {
      res.status(400).json({ error: 'pin is required' });
      return;
    }

    const pinError = validatePinStrength(pin);
    if (pinError) {
      res.status(400).json({ error: pinError });
      return;
    }

    try {
      const pinHash = await bcrypt.hash(pin, BCRYPT_SALT_ROUNDS);

      const result = await pool.query(
        `UPDATE auth_users SET pin_hash = $1, updated_at = now() WHERE user_id = $2
         RETURNING user_id`,
        [pinHash, req.params.id],
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      logger.info('[admin][resetPin] PIN reset', { userId: req.params.id });
      res.json({ updated: true });
    } catch (err) {
      logger.error('[admin][resetPin] Failed', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ---------------------------------------------------------------------------
  // DELETE /admin/users/:id — soft delete (set enabled = false)
  // ---------------------------------------------------------------------------
  router.delete('/users/:id', admin, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        `UPDATE auth_users SET enabled = false, updated_at = now() WHERE user_id = $1
         RETURNING user_id`,
        [req.params.id],
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      logger.info('[admin][deleteUser] User soft-deleted', { userId: req.params.id });
      res.json({ deleted: true });
    } catch (err) {
      logger.error('[admin][deleteUser] Failed', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /admin/families — list all families with members
  // ---------------------------------------------------------------------------
  router.get('/families', admin, async (_req: Request, res: Response) => {
    try {
      const familiesResult = await pool.query(
        'SELECT id, name, created_at, updated_at FROM families ORDER BY created_at ASC',
      );

      // Fetch all members in one query, join with auth_users for display info
      const membersResult = await pool.query(
        `SELECT fm.family_id, fm.user_id, fm.role, fm.created_at AS joined_at,
                au.username, au.display_name
         FROM family_members fm
         JOIN auth_users au ON au.user_id = fm.user_id
         ORDER BY fm.created_at ASC`,
      );

      // Group members by family_id
      const membersByFamily = new Map<string, typeof membersResult.rows>();
      for (const member of membersResult.rows) {
        const existing = membersByFamily.get(member.family_id) || [];
        existing.push(member);
        membersByFamily.set(member.family_id, existing);
      }

      const families = familiesResult.rows.map((f) => ({
        ...f,
        members: membersByFamily.get(f.id) || [],
      }));

      res.json({ families });
    } catch (err) {
      logger.error('[admin][listFamilies] Failed', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /admin/families — create family
  // ---------------------------------------------------------------------------
  router.post('/families', admin, async (req: Request, res: Response) => {
    const { name } = req.body as { name?: string };

    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    try {
      const result = await pool.query(
        'INSERT INTO families (name) VALUES ($1) RETURNING id, name, created_at, updated_at',
        [name],
      );

      logger.info('[admin][createFamily] Family created', { familyId: result.rows[0].id, name });
      res.status(201).json(result.rows[0]);
    } catch (err) {
      logger.error('[admin][createFamily] Failed', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /admin/families/:id/members — add member to family
  // ---------------------------------------------------------------------------
  router.post('/families/:id/members', admin, async (req: Request, res: Response) => {
    const { user_id, role } = req.body as { user_id?: string; role?: string };

    if (!user_id || !role) {
      res.status(400).json({ error: 'user_id and role are required' });
      return;
    }

    const validRoles = ['parent', 'child', 'member'];
    if (!validRoles.includes(role)) {
      res.status(400).json({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}` });
      return;
    }

    try {
      // Verify family exists
      const familyCheck = await pool.query(
        'SELECT id FROM families WHERE id = $1',
        [req.params.id],
      );
      if (familyCheck.rows.length === 0) {
        res.status(404).json({ error: 'Family not found' });
        return;
      }

      // Verify user exists
      const userCheck = await pool.query(
        'SELECT user_id FROM auth_users WHERE user_id = $1',
        [user_id],
      );
      if (userCheck.rows.length === 0) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      await pool.query(
        `INSERT INTO family_members (family_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (family_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [req.params.id, user_id, role],
      );

      logger.info('[admin][addFamilyMember] Member added', { familyId: req.params.id, userId: user_id, role });
      res.status(201).json({ family_id: req.params.id, user_id, role });
    } catch (err) {
      logger.error('[admin][addFamilyMember] Failed', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ---------------------------------------------------------------------------
  // DELETE /admin/families/:id/members/:userId — remove member from family
  // ---------------------------------------------------------------------------
  router.delete('/families/:id/members/:userId', admin, async (req: Request, res: Response) => {
    try {
      const result = await pool.query(
        'DELETE FROM family_members WHERE family_id = $1 AND user_id = $2 RETURNING user_id',
        [req.params.id, req.params.userId],
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Family member not found' });
        return;
      }

      logger.info('[admin][removeFamilyMember] Member removed', { familyId: req.params.id, userId: req.params.userId });
      res.json({ deleted: true });
    } catch (err) {
      logger.error('[admin][removeFamilyMember] Failed', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
