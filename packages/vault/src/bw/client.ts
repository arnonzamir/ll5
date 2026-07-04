/**
 * Client for the bw serve Vault Management API (localhost sidecar).
 *
 * Scoping (DECISION-022 §1): only items inside the configured organization's
 * collection ("LL5" / "agent") are ever visible through this client. The
 * machine account is a member of that collection alone, so even a bug here
 * cannot reach the user's personal vault — but we still filter explicitly.
 *
 * REDACTION: full items (username/password/totp) never leave this module
 * except through resolveCredential(), whose only consumer is the in-process
 * login runner. Tool-facing listings are name + domains only.
 */
import { itemDomains } from '../domain.js';
import { logger } from '../utils/logger.js';

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
  private cachedOrgId: string | null = null;
  private cachedCollectionId: string | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly orgName: string,
    private readonly collectionName: string,
  ) {}

  private async getJson<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`);
    if (!res.ok) {
      throw new Error(`bw serve ${path} -> HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }

  /** Resolve (and cache) the LL5 org + agent collection ids. */
  private async resolveScope(): Promise<{ orgId: string; collectionId: string }> {
    if (this.cachedOrgId && this.cachedCollectionId) {
      return { orgId: this.cachedOrgId, collectionId: this.cachedCollectionId };
    }
    const orgs = await this.getJson<BwListResponse<{ id: string; name: string }>>('/list/object/organizations');
    const org = (orgs.data?.data ?? []).find((o) => o.name === this.orgName);
    if (!org) throw new Error(`vault organization "${this.orgName}" not found (run the bootstrap script)`);

    const cols = await this.getJson<BwListResponse<{ id: string; name: string; organizationId?: string }>>(
      `/list/object/org-collections?organizationId=${encodeURIComponent(org.id)}`,
    );
    const col = (cols.data?.data ?? []).find((c) => c.name === this.collectionName);
    if (!col) throw new Error(`vault collection "${this.collectionName}" not found in org "${this.orgName}"`);

    this.cachedOrgId = org.id;
    this.cachedCollectionId = col.id;
    return { orgId: org.id, collectionId: col.id };
  }

  private async listCollectionItems(): Promise<BwItem[]> {
    const { collectionId } = await this.resolveScope();
    const res = await this.getJson<BwListResponse<BwItem>>(
      `/list/object/items?collectionId=${encodeURIComponent(collectionId)}`,
    );
    // Belt & braces: filter to login items actually in the collection.
    return (res.data?.data ?? []).filter(
      (i) => i.type === 1 && (i.collectionIds ?? []).includes(collectionId),
    );
  }

  /** Name + bound domains ONLY — the tool-facing listing. */
  async listSites(): Promise<SiteListing[]> {
    const items = await this.listCollectionItems();
    return items.map((i) => ({ name: i.name, domains: itemDomains(i.login?.uris) }));
  }

  /**
   * Resolve a vault item by name (exact case-insensitive first, then unique
   * substring). Returns the credential for IN-PROCESS use only.
   */
  async resolveCredential(site: string): Promise<{ ok: true; credential: ResolvedCredential } | { ok: false; reason: 'not_found' | 'ambiguous' | 'unusable'; candidates?: string[] }> {
    const items = await this.listCollectionItems();
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
