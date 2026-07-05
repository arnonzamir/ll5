import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { logAudit, generateToken } from '@ll5/shared';
import { chatAuthMiddleware } from './chat.js';
import { raiseAlert, clearAlert } from './utils/alerting.js';
import { insertSystemMessage, createSchedulerEvent } from './utils/system-message.js';
import { logger } from './utils/logger.js';

/**
 * Vault plane (DECISION-022 + tenant-scoping addendum):
 *   1. site allowlist (hard rule #2) — approved-sites GET/PUT + approval
 *      requests filed by the vault MCP;
 *   2. tenant mapping (vault_tenants) — userId → Vaultwarden org, served to
 *      the vault MCP which resolves it before EVERY bw query;
 *   3. /me/vault/* self-service wrappers — the dashboard's contract over the
 *      vault MCP's internal tenant-lifecycle routes (the agent drives the
 *      same lifecycle via MCP tools; both paths share one implementation).
 *
 * AUTHORITY GATE — same residual-risk model as approvals.ts: these endpoints
 * are gated by the USER-token auth (chatAuthMiddleware), i.e. only
 * user-authenticated surfaces (dashboard/phone) — or anything holding a valid
 * ll5 user token — can change the allowlist. The vault MCP holds AUTH_SECRET
 * and could technically mint such a token, so the gate is a policy boundary,
 * not a cryptographic one (the agent itself never holds AUTH_SECRET; it can
 * only ASK via POST /vault/approval-request). Mirrors the
 * permission_change_requests authority model: agent files requests, humans
 * approve. Tenant PROVISIONING is deliberately different: it is agent-safe
 * (self-scoped, no credential material), so the agent gets lifecycle tools —
 * but tenant-mapping WRITES (PUT /vault/tenant) additionally require a
 * 'service'-role token so an agent can never remap itself onto another
 * tenant's org.
 *
 * Storage: user_settings.settings.vault.approved_sites — an array of
 * registrable domains (strings). The vault MCP normalizes both sides to
 * eTLD+1 before comparing, so entries may also be full URLs.
 * vault_tenants (migration 035) holds the tenant mapping.
 */

interface VaultSettings {
  approved_sites?: unknown;
}

interface VaultTenantRow {
  org_id: string;
  collection_id: string | null;
  status: string;
}

const TENANT_STATUSES = ['provisioning', 'invited', 'active'] as const;

export interface VaultRouterOptions {
  /** Internal URL of the vault MCP (tenant-lifecycle routes). */
  vaultMcpUrl?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Read the real role string off a *signature-verified* ll5 token payload —
 * same pattern (and rationale) as admin.ts effectiveRoleFromToken: the shared
 * validateLl5Token narrows roles to 'admin' | 'user' | 'superadmin' and
 * collapses 'service' to 'user', so the service gate re-reads the raw claim
 * after chatAuthMiddleware has confirmed the HMAC.
 */
function rawRoleFromRequest(req: Request): string {
  const authHeader = req.headers.authorization;
  const queryToken = req.query.token as string | undefined;
  const rawToken = authHeader?.startsWith('Bearer ll5.')
    ? authHeader.slice(7)
    : queryToken?.startsWith('ll5.') ? queryToken : null;
  if (!rawToken) return 'user';
  const parts = rawToken.split('.');
  if (parts.length !== 3) return 'user';
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { role?: unknown };
    return typeof payload.role === 'string' ? payload.role : 'user';
  } catch {
    return 'user';
  }
}

async function readTenant(pool: Pool, userId: string): Promise<VaultTenantRow | null> {
  const result = await pool.query<VaultTenantRow>(
    'SELECT org_id, collection_id, status FROM vault_tenants WHERE user_id = $1',
    [userId],
  );
  return result.rows[0] ?? null;
}

async function readApprovedSites(pool: Pool, userId: string): Promise<string[]> {
  const result = await pool.query<{ vault: VaultSettings | null }>(
    `SELECT settings->'vault' AS vault FROM user_settings WHERE user_id = $1`,
    [userId],
  );
  const sites = result.rows[0]?.vault?.approved_sites;
  return Array.isArray(sites) ? sites.filter((s): s is string => typeof s === 'string') : [];
}

/**
 * Persist the caller's approved-sites allowlist (normalized, deduped) and
 * auto-resolve any firing vault.approval.<domain> alert now covered by it.
 * Shared by PUT /vault/approved-sites (full replace) and
 * POST /me/vault/approve-site (single-domain approve from the tray) — one
 * implementation so the two surfaces can never drift.
 */
async function writeApprovedSites(pool: Pool, userId: string, normalized: string[]): Promise<void> {
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
}

export function createVaultRouter(pool: Pool, authSecret: string, options: VaultRouterOptions = {}): Router {
  const router = Router();
  const authMw = chatAuthMiddleware(authSecret);
  const fetchImpl = options.fetchImpl ?? fetch;
  const vaultMcpUrl = (options.vaultMcpUrl ?? '').replace(/\/+$/, '');

  /** Call a vault MCP internal tenant route AS the acting user (minted
   *  short-TTL token — the vault MCP self-scopes on the token claim). */
  const callVaultMcp = async (
    method: 'GET' | 'POST',
    path: string,
    userId: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    if (!vaultMcpUrl) {
      return { status: 503, body: { error: 'vault MCP is not configured (VAULT_MCP_URL)' } };
    }
    const res = await fetchImpl(`${vaultMcpUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${generateToken(userId, authSecret, 1, 'user')}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body: json };
  };

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
      await writeApprovedSites(pool, userId, normalized);

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

  // ---------------------------------------------------------------------------
  // Tenant mapping (vault_tenants, migration 035) — the multi-tenancy boundary.
  // ---------------------------------------------------------------------------

  // GET /vault/tenant — the CALLER's userId → org mapping. Read by the vault
  // MCP (with a token minted for the request's user) before EVERY bw query;
  // {tenant: null} means "not provisioned" and the vault MCP refuses.
  router.get('/vault/tenant', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    try {
      const tenant = await readTenant(pool, userId);
      res.json({ tenant });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[vault][tenant][get] Failed', { userId, error: message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PUT /vault/tenant — register/update the CALLER's mapping. SERVICE-ROLE
  // ONLY: the org/collection ids come from the vault MCP's provisioning flow,
  // never from a user surface. Without this gate, any agent token could remap
  // its own row onto another tenant's org id and read their credentials —
  // the exact leak tenant scoping exists to prevent. Only AUTH_SECRET holders
  // (the vault MCP) can mint role='service' tokens; the agent cannot.
  router.put('/vault/tenant', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    const role = rawRoleFromRequest(req);
    if (role !== 'service') {
      res.status(403).json({ error: 'tenant mapping writes require a service token' });
      return;
    }

    const { org_id: orgId, collection_id: collectionId, status } = (req.body ?? {}) as {
      org_id?: unknown; collection_id?: unknown; status?: unknown;
    };
    if (typeof orgId !== 'string' || orgId.trim() === '') {
      res.status(400).json({ error: 'org_id is required' });
      return;
    }
    if (!TENANT_STATUSES.includes(status as typeof TENANT_STATUSES[number])) {
      res.status(400).json({ error: `status must be one of: ${TENANT_STATUSES.join(', ')}` });
      return;
    }
    if (collectionId !== null && collectionId !== undefined && typeof collectionId !== 'string') {
      res.status(400).json({ error: 'collection_id must be a string or null' });
      return;
    }

    try {
      await pool.query(
        `INSERT INTO vault_tenants (user_id, org_id, collection_id, status, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (user_id) DO UPDATE SET
           org_id = EXCLUDED.org_id,
           collection_id = EXCLUDED.collection_id,
           status = EXCLUDED.status,
           updated_at = now()`,
        [userId, orgId.trim(), typeof collectionId === 'string' ? collectionId : null, status],
      );

      logAudit({
        user_id: userId,
        source: 'gateway',
        action: 'vault_tenant_upserted',
        entity_type: 'vault_tenants',
        entity_id: orgId.trim(),
        summary: `Vault tenant mapping upserted (status=${String(status)})`,
        metadata: { org_id: orgId.trim(), status },
      });

      res.json({ updated: true, tenant: { org_id: orgId.trim(), collection_id: typeof collectionId === 'string' ? collectionId : null, status } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[vault][tenant][put] Failed', { userId, error: message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ---------------------------------------------------------------------------
  // /me/vault/* — self-service lifecycle wrappers (the dashboard's contract;
  // there is no dashboard page yet). Thin proxies over the vault MCP's
  // internal tenant routes — the SAME implementation the agent's lifecycle
  // tools use, self-scoped to the caller either way.
  // ---------------------------------------------------------------------------

  // POST /me/vault/provision — idempotent tenant setup for the caller. Uses
  // the account's own email (auth_users) unless the body supplies one.
  router.post('/me/vault/provision', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    const { email: bodyEmail } = (req.body ?? {}) as { email?: unknown };
    try {
      let email = typeof bodyEmail === 'string' && bodyEmail.trim() !== '' ? bodyEmail.trim() : null;
      if (!email) {
        const result = await pool.query<{ email: string | null }>(
          'SELECT email FROM auth_users WHERE user_id = $1',
          [userId],
        );
        email = result.rows[0]?.email ?? null;
      }
      if (!email) {
        res.status(400).json({ error: 'no email on the account — supply {email} in the body' });
        return;
      }

      const proxied = await callVaultMcp('POST', '/internal/tenant/provision', userId, { user_email: email });
      res.status(proxied.status === 200 ? 200 : proxied.status >= 500 ? 502 : proxied.status).json(proxied.body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[vault][meProvision] Failed', { userId, error: message });
      res.status(502).json({ error: 'vault MCP unreachable' });
    }
  });

  // POST /me/vault/confirm — owner-confirm after the user accepted the
  // emailed org invite.
  router.post('/me/vault/confirm', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    try {
      const proxied = await callVaultMcp('POST', '/internal/tenant/confirm', userId);
      res.status(proxied.status === 200 ? 200 : proxied.status >= 500 ? 502 : proxied.status).json(proxied.body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[vault][meConfirm] Failed', { userId, error: message });
      res.status(502).json({ error: 'vault MCP unreachable' });
    }
  });

  // POST /me/vault/approve-site — one-tap tray answer to a pending
  // vault.approval.<domain> request (Needs You tray, android-companion-ui
  // Phase 1). Approve = add the domain to the allowlist (same shared write
  // path as PUT /vault/approved-sites, which also resolves the alert);
  // deny = resolve the alert and leave the allowlist untouched — the site
  // simply stays blocked — plus an agent notice so it doesn't re-request.
  router.post('/me/vault/approve-site', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    const { domain, decision } = (req.body ?? {}) as { domain?: unknown; decision?: unknown };

    if (typeof domain !== 'string' || domain.trim() === '') {
      res.status(400).json({ error: 'domain is required' });
      return;
    }
    if (decision !== 'approve' && decision !== 'deny') {
      res.status(400).json({ error: "decision must be 'approve' or 'deny'" });
      return;
    }
    const normalizedDomain = domain.trim().toLowerCase();
    const alertKey = `vault.approval.${normalizedDomain}`;

    try {
      if (decision === 'approve') {
        const current = await readApprovedSites(pool, userId);
        const normalized = [...new Set([...current.map((s) => s.trim().toLowerCase()), normalizedDomain])];
        await writeApprovedSites(pool, userId, normalized);

        logAudit({
          user_id: userId,
          source: 'gateway',
          action: 'vault_site_approved',
          entity_type: 'vault_allowlist',
          entity_id: normalizedDomain,
          summary: `Vault site approved from tray: ${normalizedDomain}`,
          metadata: { domain: normalizedDomain, approved_sites: normalized },
        });

        res.json({ status: 'approved', domain: normalizedDomain });
        return;
      }

      // deny — resolve the alert (stops re-notify churn); the allowlist is
      // unchanged so the vault MCP keeps refusing the domain.
      await clearAlert(pool, userId, alertKey);
      await insertSystemMessage(
        pool, userId,
        `[Vault] user denied site ${normalizedDomain} — do not re-request today.`,
        undefined, createSchedulerEvent('vault_approval'),
      );

      logAudit({
        user_id: userId,
        source: 'gateway',
        action: 'vault_site_denied',
        entity_type: 'vault_allowlist',
        entity_id: normalizedDomain,
        summary: `Vault site denied from tray: ${normalizedDomain}`,
        metadata: { domain: normalizedDomain },
      });

      res.json({ status: 'denied', domain: normalizedDomain });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[vault][approveSite] Failed', { userId, domain: normalizedDomain, error: message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /me/vault/status — {status, org_id, sites_count, approved_sites}.
  // status/org_id come from the local mapping; sites_count from the vault MCP
  // (best-effort — null when unreachable); approved_sites from user_settings.
  router.get('/me/vault/status', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    try {
      const [tenant, approvedSites] = await Promise.all([
        readTenant(pool, userId),
        readApprovedSites(pool, userId),
      ]);
      if (!tenant) {
        res.json({ status: 'unprovisioned', org_id: null, sites_count: null, approved_sites: approvedSites });
        return;
      }

      let sitesCount: number | null = null;
      try {
        const proxied = await callVaultMcp('GET', '/internal/tenant/status', userId);
        if (proxied.status === 200 && typeof proxied.body.sites_count === 'number') {
          sitesCount = proxied.body.sites_count;
        }
      } catch {
        // best-effort — sites_count stays null
      }

      res.json({
        status: tenant.status,
        org_id: tenant.org_id,
        sites_count: sitesCount,
        approved_sites: approvedSites,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[vault][meStatus] Failed', { userId, error: message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
