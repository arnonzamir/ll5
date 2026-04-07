import type { Pool } from 'pg';
import { logger } from './logger.js';

interface CacheEntry {
  sources: Record<string, { enabled: boolean }>;
  ts: number;
}

const CACHE_TTL = 60_000; // 60 seconds
const cache = new Map<string, CacheEntry>();

/**
 * Check if a data source is enabled for a user.
 * Reads from user_settings JSONB, caches for 60s.
 * Returns true if not configured (backward-compatible default = all enabled).
 */
export async function isSourceEnabled(pool: Pool, userId: string, source: string): Promise<boolean> {
  const cached = cache.get(userId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.sources[source]?.enabled ?? true;
  }

  try {
    const result = await pool.query(
      "SELECT settings->'data_sources' as ds FROM user_settings WHERE user_id = $1",
      [userId],
    );
    const ds = result.rows[0]?.ds as Record<string, { enabled: boolean }> | null;
    const sources = ds ?? {};
    cache.set(userId, { sources, ts: Date.now() });
    return sources[source]?.enabled ?? true;
  } catch (err) {
    logger.warn('[isSourceEnabled] Failed to read settings, defaulting to enabled', {
      userId, source, error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}
