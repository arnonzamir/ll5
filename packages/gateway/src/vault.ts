import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { logAudit } from '@ll5/shared';
import { chatAuthMiddleware } from './chat.js';
import { raiseAlert, clearAlert } from './utils/alerting.js';
import { logger } from './utils/logger.js';

/**
 * Vault site-allowlist plane (DECISION-022 hard rule #2).
 *
 * AUTHORITY GATE — same residual-risk model as approvals.ts: these endpoints
 * are gated by the USER-token auth (chatAuthMiddleware), i.e. only
 * user-authenticated surfaces (dashboard/phone) — or anything holding a valid
 * ll5 user token — can change the allowlist. The vault MCP holds AUTH_SECRET
 * and could technically mint such a token, so the gate is a policy boundary,
 * not a cryptographic one (the agent itself never holds AUTH_SECRET; it can
 * only ASK via POST /vault/approval-request). Mirrors the
 * permission_change_requests authority model: agent files requests, humans
 * approve.
 *
 * Storage: user_settings.settings.vault.approved_sites — an array of
 * registrable domains (strings). The vault MCP normalizes both sides to
 * eTLD+1 before comparing, so entries may also be full URLs.
 */

interface VaultSettings {
  approved_sites?: unknown;
}

async function readApprovedSites(pool: Pool, userId: string): Promise<string[]> {
  const result = await pool.query<{ vault: VaultSettings | null }>(
    `SELECT settings->'vault' AS vault FROM user_settings WHERE user_id = $1`,
    [userId],
  );
  const sites = result.rows[0]?.vault?.approved_sites;
  return Array.isArray(sites) ? sites.filter((s): s is string => typeof s === 'string') : [];
}

export function createVaultRouter(pool: Pool, authSecret: string): Router {
  const router = Router();
  const authMw = chatAuthMiddleware(authSecret);

  // GET /vault/approved-sites — the caller's allowlist. Read by the vault MCP
  // (with a service-minted token for the request's user) before every fill.
  router.get('/vault/approved-sites', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    try {
      const approved = await readApprovedSites(pool, userId);
      res.json({ approved_sites: approved });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[vault][approvedSites][get] Failed', { userId, error: message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PUT /vault/approved-sites — replace the allowlist (user surfaces only;
  // there is no dashboard page yet, so this is the approval mechanism).
  // Auto-resolves any firing vault.approval.<domain> alert whose domain is
  // now approved.
  router.put('/vault/approved-sites', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    const { approved_sites: approvedSites } = (req.body ?? {}) as { approved_sites?: unknown };

    if (!Array.isArray(approvedSites) || approvedSites.some((s) => typeof s !== 'string' || s.trim() === '')) {
      res.status(400).json({ error: 'approved_sites must be an array of non-empty strings' });
      return;
    }
    const normalized = [...new Set((approvedSites as string[]).map((s) => s.trim().toLowerCase()))];

    try {
      await pool.query(
        `INSERT INTO user_settings (user_id, settings, updated_at)
         VALUES ($1, jsonb_build_object('vault', jsonb_build_object('approved_sites', $2::jsonb)), now())
         ON CONFLICT (user_id) DO UPDATE SET
           settings = jsonb_set(
             user_settings.settings,
             '{vault,approved_sites}',
             $2::jsonb,
             true
           ),
           updated_at = now()`,
        [userId, JSON.stringify(normalized)],
      );

      // Auto-resolve pending approval alerts for domains that are now approved.
      for (const domain of normalized) {
        await clearAlert(pool, userId, `vault.approval.${domain}`);
      }

      logAudit({
        user_id: userId,
        source: 'gateway',
        action: 'vault_approved_sites_updated',
        entity_type: 'user_settings',
        entity_id: 'vault.approved_sites',
        summary: `Vault approved-sites list updated (${normalized.length} entries)`,
        metadata: { approved_sites: normalized },
      });

      res.json({ updated: true, approved_sites: normalized });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[vault][approvedSites][put] Failed', { userId, error: message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /vault/approval-request — filed by the vault MCP when browser_login
  // hits an unapproved domain. Raises a warning-level alert: the user gets a
  // push, the agent sees [ALERT]. Idempotent per domain (raiseAlert upserts on
  // the stable key). If the domain is ALREADY approved (raced with a PUT),
  // resolve instead of alerting.
  router.post('/vault/approval-request', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    const { domain, site_name: siteName } = (req.body ?? {}) as { domain?: unknown; site_name?: unknown };

    if (typeof domain !== 'string' || domain.trim() === '') {
      res.status(400).json({ error: 'domain is required' });
      return;
    }
    const normalizedDomain = domain.trim().toLowerCase();
    const site = typeof siteName === 'string' && siteName.trim() !== '' ? siteName.trim() : normalizedDomain;
    const alertKey = `vault.approval.${normalizedDomain}`;

    try {
      const approved = await readApprovedSites(pool, userId);
      if (approved.map((s) => s.trim().toLowerCase()).includes(normalizedDomain)) {
        await clearAlert(pool, userId, alertKey);
        res.json({ status: 'already_approved', domain: normalizedDomain });
        return;
      }

      await raiseAlert(pool, {
        userId,
        key: alertKey,
        severity: 'warning',
        summary: `Vault login approval needed: ${site} (${normalizedDomain})`,
        value: 'not on approved-sites list',
        expected: 'user approval',
        suggestion: `Approve by adding "${normalizedDomain}" to the vault approved-sites list (PUT /vault/approved-sites from the dashboard/app)`,
      });

      logAudit({
        user_id: userId,
        source: 'gateway',
        action: 'vault_approval_requested',
        entity_type: 'vault_allowlist',
        entity_id: normalizedDomain,
        summary: `Vault login approval requested for ${site} (${normalizedDomain})`,
        metadata: { domain: normalizedDomain, site_name: site },
      });

      res.json({ status: 'pending', domain: normalizedDomain });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[vault][approvalRequest] Failed', { userId, error: message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
