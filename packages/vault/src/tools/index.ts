import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BwStatus } from '../bw/sidecar.js';
import type { SiteListing, ResolvedCredential, TenantScope } from '../bw/client.js';
import type { GatewayClient } from '../gateway.js';
import type { LoginRunner } from '../browser/login.js';
import type { TenancyService } from '../tenancy.js';
import { NOT_PROVISIONED_ERROR, NotProvisionedError } from '../tenancy.js';
import { registrableDomain, isDomainApproved } from '../domain.js';
import { sanitizeError, assertNoSecrets } from '../utils/redact.js';
import { logger } from '../utils/logger.js';

/**
 * Vault MCP tools (DECISION-022 + tenant-scoping addendum).
 *
 * TENANT SCOPING: every credential-touching tool resolves the authenticated
 * caller's tenant org (gateway vault_tenants mapping) BEFORE any bw query and
 * REFUSES when unmapped. The lifecycle tools (provision_vault /
 * confirm_vault_membership / vault_status) are agent-safe because they only
 * ever act on the CALLER's own tenant — userId comes from the auth token,
 * never from an argument — and touch no credential material. Site approval
 * stays user-authority (approval-request → dashboard/phone grant), unchanged.
 *
 * REDACTION CONTRACT: no tool result ever contains usernames, passwords,
 * TOTP seeds, notes, or any other vault item content. Listings are name +
 * registrable domains; login returns status + final URL only. Errors are
 * sanitized before they cross the tool boundary.
 */

export interface ToolDependencies {
  bw: {
    listSites(scope: TenantScope): Promise<SiteListing[]>;
    resolveCredential(site: string, scope: TenantScope): Promise<
      | { ok: true; credential: ResolvedCredential }
      | { ok: false; reason: 'not_found' | 'ambiguous' | 'unusable'; candidates?: string[] }
    >;
  };
  gateway: GatewayClient;
  login: LoginRunner;
  sidecar: {
    status(): Promise<BwStatus>;
    sync(): Promise<void>;
  };
  tenancy: TenancyService;
}

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

/** Resolve the caller's tenant scope, or null when unmapped. Throws on a
 *  gateway failure — callers fail CLOSED (refuse; scope is never guessed). */
async function tenantScope(deps: ToolDependencies, userId: string): Promise<TenantScope | null> {
  const tenant = await deps.gateway.getTenant(userId);
  if (!tenant) return null;
  return { orgId: tenant.org_id, collectionId: tenant.collection_id };
}

export function registerAllTools(
  server: McpServer,
  deps: ToolDependencies,
  getUserId: () => string,
): void {
  server.tool(
    'list_login_sites',
    'List the sites the agent can log into via the credential vault (the caller\'s own tenant collection). Returns item names and their bound domains ONLY — never usernames, passwords, or notes. Use browser_login({site}) with one of these names to log in. If the vault is not provisioned for this user yet, offer to set it up with provision_vault.',
    {},
    async () => {
      const userId = getUserId();
      try {
        const status = await deps.sidecar.status();
        if (status !== 'unlocked') {
          return jsonResult({ error: `vault sidecar is ${status} — logins unavailable` });
        }
        const scope = await tenantScope(deps, userId);
        if (!scope) {
          return jsonResult({ error: NOT_PROVISIONED_ERROR });
        }
        await deps.sidecar.sync();
        const sites = await deps.bw.listSites(scope);
        return jsonResult({ sites });
      } catch (err) {
        return jsonResult({ error: sanitizeError(err, []) });
      }
    },
  );

  server.tool(
    'browser_login',
    'Log into a site in the SHARED live browser using a credential from the vault — the secret is filled server-side and never returned. Hard rules: the fill happens only on the exact registrable domain bound to the vault item, and only for sites on the user-approved allowlist. If the site is not approved, this returns {status:"approval_required"} and files an approval request (the user gets a push); tell the user and wait — never work around it. Returns {status: success|failed|mfa_required|approval_required} plus the final URL. After success, your normal browser tools are inside the authenticated session.',
    {
      site: z.string().min(1).describe('Vault item name (as returned by list_login_sites)'),
    },
    async ({ site }) => {
      const userId = getUserId();
      try {
        const status = await deps.sidecar.status();
        if (status !== 'unlocked') {
          return jsonResult({ status: 'failed', reason: `vault sidecar is ${status}` });
        }

        // TENANT GATE — resolve the caller's org before ANY bw query; refuse
        // when unmapped. Fails CLOSED if the mapping can't be fetched.
        let scope: TenantScope | null;
        try {
          scope = await tenantScope(deps, userId);
        } catch (err) {
          logger.error('[tools][browser_login] tenant mapping fetch failed — refusing', {});
          return jsonResult({ status: 'failed', reason: 'tenant_mapping_unavailable', detail: sanitizeError(err, []) });
        }
        if (!scope) {
          return jsonResult({ status: 'failed', reason: 'not_provisioned', message: NOT_PROVISIONED_ERROR });
        }

        await deps.sidecar.sync();

        const resolved = await deps.bw.resolveCredential(site, scope);
        if (!resolved.ok) {
          return jsonResult({
            status: 'failed',
            reason: resolved.reason,
            // Names only — never item content.
            candidates: resolved.candidates?.slice(0, 20),
          });
        }
        const credential = resolved.credential;
        const domain = registrableDomain(credential.url);
        if (!domain) {
          return jsonResult({ status: 'failed', reason: 'item_url_has_no_registrable_domain' });
        }

        // HARD RULE #2 — allowlist gate. Fails CLOSED: if the gateway can't be
        // reached we refuse rather than fill.
        let approvedSites: string[];
        try {
          approvedSites = await deps.gateway.getApprovedSites(userId);
        } catch (err) {
          logger.error('[tools][browser_login] allowlist fetch failed — refusing', { site: credential.itemName });
          return jsonResult({ status: 'failed', reason: 'allowlist_unavailable', detail: sanitizeError(err, [credential.password, credential.username]) });
        }
        if (!isDomainApproved(domain, approvedSites)) {
          await deps.gateway.requestApproval(userId, domain, credential.itemName);
          logger.info('[tools][browser_login] approval required', { site: credential.itemName, domain });
          return jsonResult({
            status: 'approval_required',
            domain,
            site: credential.itemName,
            message: `"${domain}" is not on the approved-sites list. An approval request was sent to the user — do not retry until they approve it.`,
          });
        }

        // HARD RULE #1 — domain binding is enforced inside performLogin,
        // against the live page, immediately before any fill.
        const result = await deps.login.performLogin(credential);
        logger.info('[tools][browser_login] result', { site: credential.itemName, status: result.status });

        // Defense in depth: the result must not contain credential material.
        return jsonResult(assertNoSecrets(
          { ...result, site: credential.itemName },
          [credential.password, credential.username],
        ));
      } catch (err) {
        return jsonResult({ status: 'failed', reason: 'error', detail: sanitizeError(err, []) });
      }
    },
  );

  server.tool(
    'login_status',
    'Best-effort check of whether the shared browser appears to already be authenticated to a vault site (no credential is used). Opens the item\'s stored URL and reports whether a login form is presented.',
    {
      site: z.string().min(1).describe('Vault item name (as returned by list_login_sites)'),
    },
    async ({ site }) => {
      const userId = getUserId();
      try {
        const status = await deps.sidecar.status();
        if (status !== 'unlocked') {
          return jsonResult({ error: `vault sidecar is ${status}` });
        }
        const scope = await tenantScope(deps, userId);
        if (!scope) {
          return jsonResult({ error: NOT_PROVISIONED_ERROR });
        }
        const resolved = await deps.bw.resolveCredential(site, scope);
        if (!resolved.ok) {
          return jsonResult({ error: resolved.reason, candidates: resolved.candidates?.slice(0, 20) });
        }
        const check = await deps.login.checkLoginStatus(resolved.credential.url);
        return jsonResult(assertNoSecrets(
          { site: resolved.credential.itemName, ...check },
          [resolved.credential.password, resolved.credential.username],
        ));
      } catch (err) {
        return jsonResult({ error: sanitizeError(err, []) });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Tenant lifecycle tools — agent-driven onboarding. Self-scoped: they act on
  // the CALLER's tenant only (userId from the token, never an argument), touch
  // no credential material, and are idempotent. Site approval remains
  // user-authority and credential entry happens in the user's own vault UI.
  // ---------------------------------------------------------------------------

  server.tool(
    'provision_vault',
    'Set up the credential vault for THIS user (idempotent). Creates their private vault organization + "agent" collection and emails them an invite from the vault server. Use when vault tools report "not provisioned" and the user wants vault-backed logins. Flow: call this with the user\'s email → they open the invite email, create a vault master password, and accept → then call confirm_vault_membership. Never ask the user for any password — the invite email handles account setup.',
    {
      user_email: z.string().email().describe("The user's email address — the vault invite is sent there"),
    },
    async ({ user_email }) => {
      const userId = getUserId();
      try {
        const outcome = await deps.tenancy.provision(userId, user_email);
        return jsonResult(outcome);
      } catch (err) {
        return jsonResult({ error: sanitizeError(err, []) });
      }
    },
  );

  server.tool(
    'confirm_vault_membership',
    "Finish vault onboarding for THIS user: after they accepted the emailed vault invite, this runs the owner-confirm step that activates their membership. Returns {membership_status: confirmed|invited} — 'invited' means they have not accepted the email yet (ask them to, then retry). Once confirmed, the user adds login items to their org's \"agent\" collection (item URL matters — credentials only fill on that exact domain), and you request site approvals via browser_login.",
    {},
    async () => {
      const userId = getUserId();
      try {
        const outcome = await deps.tenancy.confirm(userId);
        return jsonResult(outcome);
      } catch (err) {
        if (err instanceof NotProvisionedError) {
          return jsonResult({ error: NOT_PROVISIONED_ERROR });
        }
        return jsonResult({ error: sanitizeError(err, []) });
      }
    },
  );

  server.tool(
    'vault_status',
    "This user's vault state: {provisioned, membership_status (provisioning|invited|active), sites_count, approved_sites}. Use it to pick the next onboarding step: not provisioned → provision_vault; invited → user must accept the emailed invite, then confirm_vault_membership; active with sites_count 0 → guide the user to add login items in their vault; sites not approved → browser_login files the approval request.",
    {},
    async () => {
      const userId = getUserId();
      try {
        const outcome = await deps.tenancy.status(userId);
        return jsonResult(outcome);
      } catch (err) {
        return jsonResult({ error: sanitizeError(err, []) });
      }
    },
  );
}
