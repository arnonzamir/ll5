/**
 * Client for the bw serve Vault Management API (localhost sidecar).
 *
 * TENANT SCOPING (DECISION-022 tenant addendum): the machine account behind
 * bw serve is Owner of EVERY tenant org, so the raw item list spans all
 * tenants. Every method here therefore takes an explicit TenantScope (the
 * caller's org, resolved from the gateway vault_tenants mapping) and is
 * incapable of returning another tenant's items BY CONSTRUCTION:
 *   - list/get calls are passed organizationId (+ collectionId) filters, and
 *   - every returned item is additionally asserted to carry the scope's org id
 *     before use (belt & braces against bw serve filter regressions).
 *
 * REDACTION: full items (username/password/totp) never leave this module
 * except through resolveCredential(), whose only consumer is the in-process
 * login runner. Tool-facing listings are name + domains only.
 */
import { itemDomains } from '../domain.js';
import { logger } from '../utils/logger.js';

/** The caller's resolved tenant org. collectionId may be null for legacy
 *  mappings (pre-tenancy seed row) — the "agent" collection is then resolved
 *  by name inside the org. */
export interface TenantScope {
  orgId: string;
  collectionId?: string | null;
}

export interface SiteListing {
  name: string;
  domains: string[];
}

/** Full credential — INTERNAL ONLY. Never serialize into a tool result or log. */
export interface ResolvedCredential {
  itemName: string;
  url: string;
  username: string;
  password: string;
}

interface BwUri { uri?: string | null }
interface BwItem {
  id: string;
  name: string;
  type: number; // 1 = login
  organizationId?: string | null;
  collectionIds?: string[];
  login?: {
    username?: string | null;
    password?: string | null;
    uris?: BwUri[] | null;
  } | null;
}

interface BwListResponse<T> {
  success: boolean;
  data?: { data?: T[] };
}

export class BwClient {
  /** orgId -> resolved "agent" collection id. */
  private readonly collectionCache = new Map<string, string>();

  constructor(
    private readonly baseUrl: string,
    private readonly collectionName: string,
  ) {}

  private async getJson<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`);
    if (!res.ok) {
      throw new Error(`bw serve ${path} -> HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }

  /**
   * Resolve the scope's collection id INSIDE its org: a mapped collection_id
   * is verified to actually belong to the org; otherwise the collection is
   * found by name. Either way the result can only ever be a collection of the
   * tenant's own org (the listing call is org-scoped).
   */
  private async resolveCollectionId(scope: TenantScope): Promise<string> {
    const cached = this.collectionCache.get(scope.orgId);
    if (cached) return cached;

    const cols = await this.getJson<BwListResponse<{ id: string; name: string }>>(
      `/list/object/org-collections?organizationId=${encodeURIComponent(scope.orgId)}`,
    );
    const list = cols.data?.data ?? [];

    let col: { id: string; name: string } | undefined;
    if (scope.collectionId) {
      col = list.find((c) => c.id === scope.collectionId);
      if (!col) {
        // Mapped collection not in the tenant org — refuse rather than widen.
        throw new Error(`mapped collection is not part of the tenant organization — refusing`);
      }
    } else {
      col = list.find((c) => c.name === this.collectionName);
      if (!col) {
        throw new Error(`vault collection "${this.collectionName}" not found in the tenant organization`);
      }
    }

    this.collectionCache.set(scope.orgId, col.id);
    return col.id;
  }

  private async listCollectionItems(scope: TenantScope): Promise<BwItem[]> {
    const collectionId = await this.resolveCollectionId(scope);
    const res = await this.getJson<BwListResponse<BwItem>>(
      `/list/object/items?organizationId=${encodeURIComponent(scope.orgId)}&collectionId=${encodeURIComponent(collectionId)}`,
    );
    // HARD ASSERTION (leak prevention by construction): only login items that
    // carry the tenant's own org id AND live in its agent collection survive,
    // regardless of what bw serve returned.
    const raw = res.data?.data ?? [];
    const scoped = raw.filter(
      (i) => i.type === 1 && i.organizationId === scope.orgId && (i.collectionIds ?? []).includes(collectionId),
    );
    if (scoped.length !== raw.length) {
      logger.warn('[BwClient][listCollectionItems] dropped out-of-scope items returned by bw serve', {
        returned: raw.length,
        kept: scoped.length,
      });
    }
    return scoped;
  }

  /** Name + bound domains ONLY — the tool-facing listing (tenant-scoped). */
  async listSites(scope: TenantScope): Promise<SiteListing[]> {
    const items = await this.listCollectionItems(scope);
    return items.map((i) => ({ name: i.name, domains: itemDomains(i.login?.uris) }));
  }

  /**
   * Resolve a vault item by name within the tenant's org (exact
   * case-insensitive first, then unique substring). Returns the credential
   * for IN-PROCESS use only.
   */
  async resolveCredential(site: string, scope: TenantScope): Promise<{ ok: true; credential: ResolvedCredential } | { ok: false; reason: 'not_found' | 'ambiguous' | 'unusable'; candidates?: string[] }> {
    const items = await this.listCollectionItems(scope);
    const needle = site.trim().toLowerCase();

    let matches = items.filter((i) => i.name.trim().toLowerCase() === needle);
    if (matches.length === 0) {
      matches = items.filter((i) => i.name.toLowerCase().includes(needle));
    }
    if (matches.length === 0) {
      return { ok: false, reason: 'not_found', candidates: items.map((i) => i.name) };
    }
    if (matches.length > 1) {
      return { ok: false, reason: 'ambiguous', candidates: matches.map((i) => i.name) };
    }

    const item = matches[0];
    // Final org-mismatch assertion before ANY use of the item — the filter
    // above already guarantees this; a failure here means a code regression,
    // and we refuse loudly rather than risk a cross-tenant fill.
    if (item.organizationId !== scope.orgId) {
      logger.error('[BwClient][resolveCredential] org-mismatch assertion tripped — refusing', { site: item.name });
      throw new Error('vault item does not belong to the tenant organization — refusing');
    }

    const url = (item.login?.uris ?? []).map((u) => u?.uri).find((u): u is string => !!u);
    const username = item.login?.username ?? '';
    const password = item.login?.password ?? '';
    if (!url || !password) {
      logger.warn('[BwClient][resolveCredential] item unusable (missing url or password)', { site: item.name });
      return { ok: false, reason: 'unusable' };
    }
    return { ok: true, credential: { itemName: item.name, url, username, password } };
  }
}
