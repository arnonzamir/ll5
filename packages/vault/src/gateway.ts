/**
 * Internal gateway calls (allowlist + approval requests).
 *
 * The gateway's /vault/* endpoints are chatAuth-gated (ll5.* tokens). This
 * service holds AUTH_SECRET, so it mints a short-lived token for the CURRENT
 * request's user id — the allowlist is per-user (user_settings JSONB).
 */
import { generateToken } from '@ll5/shared';
import { logger } from './utils/logger.js';
import { sanitizeError } from './utils/redact.js';

export interface GatewayClient {
  getApprovedSites(userId: string): Promise<string[]>;
  requestApproval(userId: string, domain: string, siteName: string): Promise<void>;
}

export function createGatewayClient(gatewayUrl: string, authSecret: string): GatewayClient {
  const mintToken = (userId: string): string => generateToken(userId, authSecret, 1, 'user');

  return {
    async getApprovedSites(userId: string): Promise<string[]> {
      const res = await fetch(`${gatewayUrl}/vault/approved-sites`, {
        headers: { Authorization: `Bearer ${mintToken(userId)}` },
      });
      if (!res.ok) {
        throw new Error(`gateway /vault/approved-sites -> HTTP ${res.status}`);
      }
      const body = (await res.json()) as { approved_sites?: unknown };
      return Array.isArray(body.approved_sites)
        ? body.approved_sites.filter((s): s is string => typeof s === 'string')
        : [];
    },

    async requestApproval(userId: string, domain: string, siteName: string): Promise<void> {
      try {
        const res = await fetch(`${gatewayUrl}/vault/approval-request`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${mintToken(userId)}`,
          },
          body: JSON.stringify({ domain, site_name: siteName }),
        });
        if (!res.ok) {
          logger.warn('[gateway][requestApproval] non-OK response', { status: res.status, domain });
        }
      } catch (err) {
        // Best-effort: the tool result already says approval_required.
        logger.error('[gateway][requestApproval] failed', { domain, error: sanitizeError(err, []) });
      }
    },
  };
}
