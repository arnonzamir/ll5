import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BwStatus } from '../bw/sidecar.js';
import type { SiteListing, ResolvedCredential } from '../bw/client.js';
import type { GatewayClient } from '../gateway.js';
import type { LoginRunner } from '../browser/login.js';
import { registrableDomain, isDomainApproved } from '../domain.js';
import { sanitizeError, assertNoSecrets } from '../utils/redact.js';
import { logger } from '../utils/logger.js';

/**
 * Vault MCP tools (DECISION-022).
 *
 * REDACTION CONTRACT: no tool result ever contains usernames, passwords,
 * TOTP seeds, notes, or any other vault item content. Listings are name +
 * registrable domains; login returns status + final URL only. Errors are
 * sanitized before they cross the tool boundary.
 */

export interface ToolDependencies {
  bw: {
    listSites(): Promise<SiteListing[]>;
    resolveCredential(site: string): Promise<
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
}

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

export function registerAllTools(
  server: McpServer,
  deps: ToolDependencies,
  getUserId: () => string,
): void {
  server.tool(
    'list_login_sites',
    'List the sites the agent can log into via the credential vault (the LL5 collection). Returns item names and their bound domains ONLY — never usernames, passwords, or notes. Use browser_login({site}) with one of these names to log in.',
    {},
    async () => {
      try {
        const status = await deps.sidecar.status();
        if (status !== 'unlocked') {
          return jsonResult({ error: `vault sidecar is ${status} — logins unavailable` });
        }
        await deps.sidecar.sync();
        const sites = await deps.bw.listSites();
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
        await deps.sidecar.sync();

        const resolved = await deps.bw.resolveCredential(site);
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
      try {
        const status = await deps.sidecar.status();
        if (status !== 'unlocked') {
          return jsonResult({ error: `vault sidecar is ${status}` });
        }
        const resolved = await deps.bw.resolveCredential(site);
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
}
