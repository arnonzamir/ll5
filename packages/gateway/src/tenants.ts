import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { requireSuperadmin } from './admin.js';
import { logger } from './utils/logger.js';
import { mintAgentToken, upsertRuntimeRow } from './agent.js';
import {
  defaultOrchestratorClient,
  OrchestratorNotConfiguredError,
  type OrchestratorClient,
} from './utils/orchestrator.js';

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
    ) AS last_active_at,
    ar.status        AS runtime_status,
    ar.last_seen_at  AS runtime_last_seen_at
  FROM auth_users au
  LEFT JOIN user_settings us ON us.user_id = au.user_id
  LEFT JOIN agent_runtimes ar ON ar.user_id = au.user_id
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
  runtime_status: string | null;
  runtime_last_seen_at: string | null;
}

/**
 * Run the enrichment SELECT for a single user_id and return the raw row
 * (or null if the user does not exist). Shared by /admin/tenants/:id and the
 * self-scoped /me/onboarding so both derive channel/onboarding flags identically.
 */
export async function enrichUser(pool: Pool, userId: string): Promise<TenantRow | null> {
  const result = await pool.query<TenantRow>(
    `${TENANT_SELECT} WHERE au.user_id = $1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

/** Derive the {completed, steps} onboarding shape from a raw row. */
export function deriveOnboarding(row: Pick<TenantRow, 'onboarding'>): {
  completed: boolean;
  steps: Record<string, unknown>;
} {
  const onboarding = row.onboarding ?? {};
  return {
    completed: onboarding.completed === true,
    steps: onboarding.steps ?? {},
  };
}

/** Derive the {google, whatsapp, health} channel flags from a raw row. */
export function deriveChannels(
  row: Pick<TenantRow, 'chan_google' | 'chan_whatsapp' | 'chan_health'>,
): { google: boolean; whatsapp: boolean; health: boolean } {
  return {
    google: row.chan_google,
    whatsapp: row.chan_whatsapp,
    health: row.chan_health,
  };
}

/** Derive the {status, last_seen_at} agent runtime view from a raw row. */
export function deriveAgentRuntime(
  row: Pick<TenantRow, 'runtime_status' | 'runtime_last_seen_at'>,
): { status: string; last_seen_at: string | null } {
  return {
    status: row.runtime_status ?? 'none',
    last_seen_at: row.runtime_last_seen_at ?? null,
  };
}

/** Shape the console consumes. */
function toTenant(row: TenantRow) {
  return {
    user_id: row.user_id,
    email: row.email,
    username: row.username,
    display_name: row.display_name,
    role: row.role,
    enabled: row.enabled,
    created_at: row.created_at,
    onboarding: deriveOnboarding(row),
    channels: deriveChannels(row),
    agent_runtime: deriveAgentRuntime(row),
    last_active_at: row.last_active_at,
  };
}

/**
 * Create the /admin/tenants router (superadmin only).
 */
export function createTenantsRouter(
  pool: Pool,
  authSecret: string,
  orchestrator: OrchestratorClient = defaultOrchestratorClient,
): Router {
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
      const row = await enrichUser(pool, String(req.params.id));
      if (!row) {
        res.status(404).json({ error: 'Tenant not found' });
        return;
      }
      res.json({ tenant: toTenant(row) });
    } catch (err) {
      logger.error('[tenants][get] Failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /admin/tenants/:id/agent/provision — provision any tenant's agent
  // container (superadmin). Mints an agent token bound to the tenant's role,
  // asks the orchestrator to launch, records the runtime state.
  // ---------------------------------------------------------------------------
  router.post('/admin/tenants/:id/agent/provision', superadmin, async (req: Request, res: Response) => {
    const targetUserId = String(req.params.id);
    try {
      const userRow = await pool.query<{ role: string }>(
        'SELECT role FROM auth_users WHERE user_id = $1',
        [targetUserId],
      );
      if (userRow.rows.length === 0) {
        res.status(404).json({ error: 'Tenant not found' });
        return;
      }
      const cred = await pool.query(
        'SELECT 1 FROM agent_llm_credentials WHERE user_id = $1',
        [targetUserId],
      );
      if (cred.rows.length === 0) {
        res.status(400).json({ error: 'tenant must connect a Claude API key first' });
        return;
      }

      const { token } = await mintAgentToken(pool, authSecret, targetUserId, userRow.rows[0].role);
      const runtime = await orchestrator.provision(targetUserId, token);
      const view = await upsertRuntimeRow(pool, targetUserId, runtime);
      logger.info('[tenants][agentProvision]', {
        actor_user_id: (req as Request & { adminUserId?: string }).adminUserId,
        target_user_id: targetUserId,
        status: view.status,
      });
      res.json({ runtime: view });
    } catch (err) {
      if (err instanceof OrchestratorNotConfiguredError) {
        logger.warn('[tenants][agentProvision] orchestrator not configured', { target_user_id: targetUserId });
        res.status(503).json({ error: 'Agent runtime is not configured yet' });
        return;
      }
      logger.error('[tenants][agentProvision] Failed', {
        target_user_id: targetUserId,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /admin/tenants/:id/agent/stop — stop any tenant's agent (superadmin).
  // ---------------------------------------------------------------------------
  router.post('/admin/tenants/:id/agent/stop', superadmin, async (req: Request, res: Response) => {
    const targetUserId = String(req.params.id);
    try {
      const runtime = await orchestrator.stop(targetUserId);
      const view = await upsertRuntimeRow(pool, targetUserId, runtime);
      logger.info('[tenants][agentStop]', {
        actor_user_id: (req as Request & { adminUserId?: string }).adminUserId,
        target_user_id: targetUserId,
        status: view.status,
      });
      res.json({ runtime: view });
    } catch (err) {
      if (err instanceof OrchestratorNotConfiguredError) {
        logger.warn('[tenants][agentStop] orchestrator not configured', { target_user_id: targetUserId });
        res.status(503).json({ error: 'Agent runtime is not configured yet' });
        return;
      }
      logger.error('[tenants][agentStop] Failed', {
        target_user_id: targetUserId,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
