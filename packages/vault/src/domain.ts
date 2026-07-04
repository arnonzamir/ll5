/**
 * Domain-binding logic (DECISION-022 hard rule #1) — pure functions.
 *
 * A credential is allowed to fill ONLY on the exact registrable domain
 * (eTLD+1, via tldts / the public suffix list) of its vault entry's URL.
 * Page content, redirects, or prompt-injected navigation can therefore never
 * move a fill to another site: the comparison happens against the LIVE page
 * URL immediately before any field is touched.
 */
import { getDomain } from 'tldts';

/**
 * Registrable domain (eTLD+1) for a URL or bare hostname.
 * Returns null when no valid registrable domain exists (IPs, localhost,
 * malformed input) — callers must treat null as "refuse to fill".
 */
export function registrableDomain(urlOrHost: string): string | null {
  if (!urlOrHost || typeof urlOrHost !== 'string') return null;
  const domain = getDomain(urlOrHost.trim(), { allowPrivateDomains: false });
  return domain ? domain.toLowerCase() : null;
}

/**
 * True only when both inputs resolve to the SAME registrable domain.
 * Any unresolvable side fails closed.
 */
export function sameRegistrableDomain(a: string, b: string): boolean {
  const da = registrableDomain(a);
  const db = registrableDomain(b);
  if (!da || !db) return false;
  return da === db;
}

/**
 * Allowlist check (DECISION-022 hard rule #2). Entries in
 * user_settings.vault.approved_sites may be bare domains or full URLs; each
 * is normalized to its registrable domain before comparison. Fails closed on
 * anything unresolvable.
 */
export function isDomainApproved(domain: string, approvedSites: unknown): boolean {
  const target = registrableDomain(domain);
  if (!target) return false;
  if (!Array.isArray(approvedSites)) return false;
  for (const entry of approvedSites) {
    if (typeof entry !== 'string') continue;
    const approved = registrableDomain(entry);
    if (approved && approved === target) return true;
  }
  return false;
}

/** Unique registrable domains bound to a vault item's URI list (name-only listing). */
export function itemDomains(uris: Array<{ uri?: string | null }> | undefined | null): string[] {
  const out = new Set<string>();
  for (const u of uris ?? []) {
    if (!u?.uri) continue;
    const d = registrableDomain(u.uri);
    if (d) out.add(d);
  }
  return [...out];
}
