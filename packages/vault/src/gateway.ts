/**
 * Internal gateway calls (allowlist + approval requests + tenant mapping).
 *
 * The gateway's /vault/* endpoints are chatAuth-gated (ll5.* tokens). This
 * service holds AUTH_SECRET, so it mints a short-lived token for the CURRENT
 * request's user id — allowlist and tenant mapping are per-user rows.
 *
 * TENANT MAPPING (vault_tenants in gateway PG — MCPs stay stateless):
 * getTenant() is called before EVERY bw query; a null result means the caller
 * has no vault tenant and the tools refuse. putTenant() registers/updates the
 * mapping during provisioning and is the ONLY write path — the gateway gates
 * it on a 'service'-role token that only AUTH_SECRET holders can mint (the
 * agent can't), so an agent can never remap itself onto another tenant's org.
 */
import { generateToken } from '@ll5/shared';
import { logger } from './utils/logger.js';
import { sanitizeError } from './utils/redact.js';

/** The caller's vault_tenants row (gateway PG). */
export interface VaultTenant {
  org_id: string;
  collection_id: string | null;
  status: 'provisioning' | 'invited' | 'active';
}

export interface GatewayClient {
  getApprovedSites(userId: string): Promise<string[]>;
  requestApproval(userId: string, domain: string, siteName: string): Promise<void>;
  /** Resolve the caller's tenant org mapping. null = not provisioned. Throws
   *  on gateway errors — callers must fail CLOSED (refuse, never widen). */
  getTenant(userId: string): Promise<VaultTenant | null>;
  /** Register/update the caller's tenant mapping (service-role token). */
  putTenant(userId: string, tenant: VaultTenant): Promise<void>;
}

export function createGatewayClient(gatewayUrl: string, authSecret: string): GatewayClient {
  const mintToken = (userId: string, role = 'user'): string => generateToken(userId, authSecret, 1, role);

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

    async getTenant(userId: string): Promise<VaultTenant | null> {
      const res = await fetch(`${gatewayUrl}/vault/tenant`, {
        headers: { Authorization: `Bearer ${mintToken(userId)}` },
      });
      if (!res.ok) {
        // Fail CLOSED: an unreachable mapping means NO scope, never a default.
        throw new Error(`gateway /vault/tenant -> HTTP ${res.status}`);
      }
      const body = (await res.json()) as { tenant?: unknown };
      const t = body.tenant as VaultTenant | null | undefined;
      if (!t || typeof t !== 'object' || typeof t.org_id !== 'string' || t.org_id === '') {
        return null;
      }
      return {
        org_id: t.org_id,
        collection_id: typeof t.collection_id === 'string' ? t.collection_id : null,
        status: t.status,
      };
    },

    async putTenant(userId: string, tenant: VaultTenant): Promise<void> {
      const res = await fetch(`${gatewayUrl}/vault/tenant`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          // 'service' role — the gateway refuses tenant writes from plain
          // user/agent tokens (see gateway vault.ts PUT /vault/tenant).
          Authorization: `Bearer ${mintToken(userId, 'service')}`,
        },
        body: JSON.stringify(tenant),
      });
      if (!res.ok) {
        throw new Error(`gateway PUT /vault/tenant -> HTTP ${res.status}`);
      }
    },
  };
}
