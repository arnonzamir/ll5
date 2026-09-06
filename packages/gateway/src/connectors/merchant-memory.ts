/**
 * MerchantMemory — per-user LRU of merchant keys this gateway has seen, so the
 * `unknown_merchant` rule has something to compare against without a round
 * trip. Known = seen at least `minSeen` times inside `windowMs` (90 days).
 * In-memory by design: a restart forgets everything (documented limitation in
 * rules.ts); `settings.connectors.known_merchants` is the durable complement.
 */
export interface MerchantMemoryOptions {
  maxKeysPerUser?: number;
  windowMs?: number;
  minSeen?: number;
}

interface Seen { count: number; lastSeen: number; }

export class MerchantMemory {
  private readonly users = new Map<string, Map<string, Seen>>();
  private readonly maxKeys: number;
  private readonly windowMs: number;
  private readonly minSeen: number;

  constructor(opts: MerchantMemoryOptions = {}) {
    this.maxKeys = Math.max(1, opts.maxKeysPerUser ?? 500);
    this.windowMs = opts.windowMs ?? 90 * 86_400_000;
    this.minSeen = Math.max(1, opts.minSeen ?? 2);
  }

  private bucket(userId: string): Map<string, Seen> {
    let b = this.users.get(userId);
    if (!b) { b = new Map(); this.users.set(userId, b); }
    return b;
  }

  /** Record one sighting. Re-inserting moves the key to the LRU tail. */
  note(userId: string, key: string | null, now = Date.now()): void {
    if (!key) return;
    const b = this.bucket(userId);
    const prev = b.get(key);
    const stale = prev && now - prev.lastSeen > this.windowMs;
    const next: Seen = { count: prev && !stale ? prev.count + 1 : 1, lastSeen: now };
    b.delete(key);
    b.set(key, next);
    while (b.size > this.maxKeys) {
      const oldest = b.keys().next().value;
      if (oldest === undefined) break;
      b.delete(oldest);
    }
  }

  isKnown(userId: string, key: string | null, now = Date.now()): boolean {
    if (!key) return false;
    const s = this.users.get(userId)?.get(key);
    return !!s && s.count >= this.minSeen && now - s.lastSeen <= this.windowMs;
  }

  /** All keys currently known for the user (for the rules ctx). */
  knownKeys(userId: string, now = Date.now()): Set<string> {
    const out = new Set<string>();
    const b = this.users.get(userId);
    if (!b) return out;
    for (const [k, s] of b) if (s.count >= this.minSeen && now - s.lastSeen <= this.windowMs) out.add(k);
    return out;
  }

  size(userId: string): number { return this.users.get(userId)?.size ?? 0; }

  reset(): void { this.users.clear(); }
}
