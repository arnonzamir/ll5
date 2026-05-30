import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { requireSuperadmin } from './admin.js';
import { logger } from './utils/logger.js';

/**
 * Tenant-management API (superadmin-gated, read/enrichment only).
 *
 * These endpoints power the tenant console. They do NOT duplicate user CRUD —
 * create/enable/disable/role-change live on /admin/users and /admin/invites.
 * Here we only read auth_users and LEFT JOIN/EXISTS-aggregate the per-user
 * onboarding state and channel-connection signals into one console-shaped row.
 *
 * Never returns secrets/hashes: no pin_hash, no password_hash, no token, no
 * encrypted credential ciphertext — only booleans derived from row existence.
 *
 * Note on id types: auth_users.user_id is UUID; the channel tables
 * (google_oauth_tokens, messaging_whatsapp_accounts, health_source_credentials)
 * key on a VARCHAR user_id, so those EXISTS subqueries compare au.user_id::text.
 * chat_messages.user_id is UUID, so last_active_at joins on it directly.
 */

/** A single shared SELECT body so /tenants and /tenants/:id stay identical. */
const TENANT_SELECT = `
  SELECT
    au.user_id,
    au.email,
    au.username,
    au.display_name,
    au.role,
    au.enabled,
    au.created_at,
    COALESCE(us.settings->'onboarding', '{}'::jsonb) AS onboarding,
    EXISTS (
      SELECT 1 FROM google_oauth_tokens g WHERE g.user_id = au.user_id::text
    ) AS chan_google,
    EXISTS (
      SELECT 1 FROM messaging_whatsapp_accounts w
       WHERE w.user_id = au.user_id::text AND w.status = 'connected'
    ) AS chan_whatsapp,
    EXISTS (
      SELECT 1 FROM health_source_credentials h WHERE h.user_id = au.user_id::text
    ) AS chan_health,
    (
      SELECT MAX(cm.created_at) FROM chat_messages cm WHERE cm.user_id = au.user_id
    ) AS last_active_at
  FROM auth_users au
  LEFT JOIN user_settings us ON us.user_id = au.user_id
`;

/** Row as returned by the enrichment query. */
interface TenantRow {
  user_id: string;
  email: string | null;
  username: string | null;
  display_name: string | null;
  role: string;
  enabled: boolean;
  created_at: string;
  onboarding: { completed?: boolean; steps?: Record<string, unknown> } | null;
  chan_google: boolean;
  chan_whatsapp: boolean;
  chan_health: boolean;
  last_active_at: string | null;
}

/** Shape the console consumes. */
function toTenant(row: TenantRow) {
  const onboarding = row.onboarding ?? {};
  return {
    user_id: row.user_id,
    email: row.email,
    username: row.username,
    display_name: row.display_name,
    role: row.role,
    enabled: row.enabled,
    created_at: row.created_at,
    onboarding: {
      completed: onboarding.completed === true,
      steps: onboarding.steps ?? {},
    },
    channels: {
      google: row.chan_google,
      whatsapp: row.chan_whatsapp,
      health: row.chan_health,
    },
    last_active_at: row.last_active_at,
  };
}

/**
 * Create the /admin/tenants router (superadmin only).
 */
export function createTenantsRouter(pool: Pool, authSecret: string): Router {
  const router = Router();
  const superadmin = requireSuperadmin(authSecret);

  // ---------------------------------------------------------------------------
  // GET /admin/tenants — enriched list for the tenant console.
  // ---------------------------------------------------------------------------
  router.get('/admin/tenants', superadmin, async (_req: Request, res: Response) => {
    try {
      const result = await pool.query<TenantRow>(
        `${TENANT_SELECT} ORDER BY au.created_at ASC`,
      );
      res.json({ tenants: result.rows.map(toTenant) });
    } catch (err) {
      logger.error('[tenants][list] Failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /admin/tenants/:id — same enriched shape for one tenant (404 if absent).
  // ---------------------------------------------------------------------------
  router.get('/admin/tenants/:id', superadmin, async (req: Request, res: Response) => {
    try {
      const result = await pool.query<TenantRow>(
        `${TENANT_SELECT} WHERE au.user_id = $1`,
        [req.params.id],
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Tenant not found' });
        return;
      }
      res.json({ tenant: toTenant(result.rows[0]) });
    } catch (err) {
      logger.error('[tenants][get] Failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
