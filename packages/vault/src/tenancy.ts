/**
 * Tenant lifecycle service (DECISION-022 tenant addendum) — the ONE
 * implementation behind both surfaces:
 *   - the agent-facing MCP tools (provision_vault / confirm_vault_membership /
 *     vault_status), self-scoped to the authenticated caller's userId, and
 *   - the vault MCP's internal HTTP routes (src/admin.ts) that the gateway's
 *     /me/vault/* dashboard wrappers call.
 *
 * Safe as agent tools because the lifecycle only ever touches the CALLER's
 * own tenant (userId comes from the auth token, never an argument) and no
 * credential material is involved. What remains user-authority is unchanged:
 * site approval (PUT /vault/approved-sites) and the credentials themselves.
 *
 * State lives in gateway PG (vault_tenants) — this MCP stays stateless; all
 * reads/writes go through the gateway client.
 */
import type { GatewayClient } from './gateway.js';
import type { TenantScope } from './bw/client.js';
import type { MemberConfirmResult, TenantOrgResult } from './provision.js';
import { logger } from './utils/logger.js';
import { sanitizeError } from './utils/redact.js';

/** Stable refusal text — the persona keys off "not provisioned". */
export const NOT_PROVISIONED_ERROR =
  'vault not provisioned for this user — set it up with provision_vault({user_email}) (the user receives an email invite from the vault).';

export class NotProvisionedError extends Error {
  constructor() {
    super(NOT_PROVISIONED_ERROR);
    this.name = 'NotProvisionedError';
  }
}

export interface ProvisionOutcome {
  status: 'invited' | 'active' | 'provisioning';
  org_id: string;
  already_provisioned: boolean;
  invite_email_sent: boolean;
  message: string;
}

export interface ConfirmOutcome {
  membership_status: 'confirmed' | 'invited';
  message: string;
}

export interface StatusOutcome {
  provisioned: boolean;
  membership_status: 'provisioning' | 'invited' | 'active' | null;
  sites_count: number | null;
  approved_sites: string[];
}

export interface TenancyDeps {
  gateway: GatewayClient;
  provisioner: {
    readonly configured: boolean;
    createTenantOrg(userId: string, userEmail: string): Promise<TenantOrgResult>;
    confirmMember(orgId: string): Promise<MemberConfirmResult>;
  };
  bw: { listSites(scope: TenantScope): Promise<Array<{ name: string }>> };
  sidecar: { status(): Promise<string>; sync(): Promise<void> };
}

export interface TenancyService {
  /** Idempotent: org + collection + invite for the CALLER's tenant. */
  provision(userId: string, userEmail: string): Promise<ProvisionOutcome>;
  /** Owner-confirm after the user accepted the emailed invite. */
  confirm(userId: string): Promise<ConfirmOutcome>;
  /** Lifecycle + usage snapshot for the caller's tenant. */
  status(userId: string): Promise<StatusOutcome>;
}

export function createTenancyService(deps: TenancyDeps): TenancyService {
  return {
    async provision(userId: string, userEmail: string): Promise<ProvisionOutcome> {
      // Idempotency: an existing mapping wins — never create a second org.
      const existing = await deps.gateway.getTenant(userId);
      if (existing) {
        return {
          status: existing.status,
          org_id: existing.org_id,
          already_provisioned: true,
          invite_email_sent: false,
          message: existing.status === 'active'
            ? 'Vault already provisioned and confirmed for this user.'
            : 'Vault already provisioned — the user still needs to accept the emailed invite, then run confirm_vault_membership.',
        };
      }

      if (!deps.provisioner.configured) {
        throw new Error('vault provisioning is not configured on this deployment (machine-account BW_EMAIL / BW_PASSWORD missing)');
      }

      const result = await deps.provisioner.createTenantOrg(userId, userEmail);
      await deps.gateway.putTenant(userId, {
        org_id: result.orgId,
        collection_id: result.collectionId,
        status: 'invited',
      });
      // Make the new org visible to the bw sidecar without a restart.
      await deps.sidecar.sync();

      logger.info('[tenancy][provision] tenant provisioned', {
        org_created: result.orgCreated,
        invited: result.invited,
      });
      return {
        status: 'invited',
        org_id: result.orgId,
        already_provisioned: false,
        invite_email_sent: result.invited,
        message: result.invited
          ? `Vault tenant created. An invite email was sent to ${userEmail.trim().toLowerCase()} — the user must open it, create their vault master password, and accept. Then run confirm_vault_membership.`
          : 'Vault tenant created; the user was already a member of the org — run confirm_vault_membership if not yet confirmed.',
      };
    },

    async confirm(userId: string): Promise<ConfirmOutcome> {
      const tenant = await deps.gateway.getTenant(userId);
      if (!tenant) throw new NotProvisionedError();

      const result = await deps.provisioner.confirmMember(tenant.org_id);
      if (result.status === 'not_accepted_yet') {
        return {
          membership_status: 'invited',
          message: 'The user has not accepted the emailed vault invite yet — ask them to open the invite email and accept, then retry.',
        };
      }

      if (tenant.status !== 'active') {
        await deps.gateway.putTenant(userId, { ...tenant, status: 'active' });
      }
      return {
        membership_status: 'confirmed',
        message: result.status === 'already_confirmed'
          ? 'Membership was already confirmed — the vault is active.'
          : 'Membership confirmed — the vault is active. The user can now add login items to their org\'s "agent" collection (the item URL matters: credentials only ever fill on that domain).',
      };
    },

    async status(userId: string): Promise<StatusOutcome> {
      const tenant = await deps.gateway.getTenant(userId);
      if (!tenant) {
        return { provisioned: false, membership_status: null, sites_count: null, approved_sites: [] };
      }

      // Both are best-effort snapshots — a sidecar/gateway hiccup must not
      // make status() fail (it never widens access; nulls are honest).
      let sitesCount: number | null = null;
      try {
        if ((await deps.sidecar.status()) === 'unlocked') {
          await deps.sidecar.sync();
          sitesCount = (await deps.bw.listSites({ orgId: tenant.org_id, collectionId: tenant.collection_id })).length;
        }
      } catch (err) {
        logger.warn('[tenancy][status] sites_count unavailable', { error: sanitizeError(err, []) });
      }

      let approvedSites: string[] = [];
      try {
        approvedSites = await deps.gateway.getApprovedSites(userId);
      } catch (err) {
        logger.warn('[tenancy][status] approved_sites unavailable', { error: sanitizeError(err, []) });
      }

      return {
        provisioned: true,
        membership_status: tenant.status,
        sites_count: sitesCount,
        approved_sites: approvedSites,
      };
    },
  };
}
