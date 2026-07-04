/**
 * Internal tenant-lifecycle HTTP surface (NOT MCP tools).
 *
 * These routes exist for the gateway's /me/vault/* dashboard wrappers —
 * service-to-service calls authenticated with ll5.* tokens (same shared
 * middleware as /mcp; the gateway mints a token for the acting user). They
 * are the SAME code path as the agent-facing lifecycle tools (src/tenancy.ts)
 * and, like them, are strictly self-scoped: the acting user comes from the
 * token claim, never from a body field, so a caller can only ever provision,
 * confirm, or inspect its OWN tenant.
 *
 * AUTHORITY NOTE (mirrors gateway approvals.ts / vault.ts): nothing here
 * touches credential material or the approved-sites allowlist — site approval
 * stays a user-authority action on user-authenticated surfaces.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { tokenAuthMiddleware, type AuthenticatedRequest } from '@ll5/shared';
import type { TenancyService } from './tenancy.js';
import { NotProvisionedError } from './tenancy.js';
import { sanitizeError } from './utils/redact.js';
import { logger } from './utils/logger.js';

export interface InternalRouterConfig {
  authSecret: string;
  /** Legacy API-key fallback (same convention as the /mcp endpoint). */
  apiKey: string;
  userId: string;
  tenancy: TenancyService;
}

export function createInternalRouter(config: InternalRouterConfig): Router {
  const router = Router();
  const authMw = tokenAuthMiddleware({
    authSecret: config.authSecret,
    legacy: { apiKey: config.apiKey, userId: config.userId },
  });

  // POST /internal/tenant/provision {user_email} — idempotent tenant setup
  // (org + collection + owner invite email) for the AUTHENTICATED user.
  router.post('/internal/tenant/provision', authMw, async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const { user_email: userEmail } = (req.body ?? {}) as { user_email?: unknown };
    if (typeof userEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userEmail.trim())) {
      res.status(400).json({ error: 'user_email must be a valid email address' });
      return;
    }
    try {
      const outcome = await config.tenancy.provision(userId, userEmail.trim());
      res.json(outcome);
    } catch (err) {
      const message = sanitizeError(err, []);
      logger.error('[internal][provision] failed', { error: message });
      res.status(502).json({ error: message });
    }
  });

  // POST /internal/tenant/confirm — owner-confirm for the authenticated
  // user's tenant (after they accepted the emailed invite).
  router.post('/internal/tenant/confirm', authMw, async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    try {
      const outcome = await config.tenancy.confirm(userId);
      res.json(outcome);
    } catch (err) {
      if (err instanceof NotProvisionedError) {
        res.status(409).json({ error: err.message });
        return;
      }
      const message = sanitizeError(err, []);
      logger.error('[internal][confirm] failed', { error: message });
      res.status(502).json({ error: message });
    }
  });

  // GET /internal/tenant/status — lifecycle + usage snapshot for the
  // authenticated user's tenant (used by GET /me/vault/status for sites_count).
  router.get('/internal/tenant/status', authMw, async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    try {
      const outcome = await config.tenancy.status(userId);
      res.json(outcome);
    } catch (err) {
      const message = sanitizeError(err, []);
      logger.error('[internal][status] failed', { error: message });
      res.status(502).json({ error: message });
    }
  });

  return router;
}
