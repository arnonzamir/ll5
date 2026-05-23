import type { Pool } from 'pg';
import { logger } from './logger.js';

interface CacheEntry {
  names: string[];
  ts: number;
}

const CACHE_TTL = 60_000; // 60 seconds
const cache = new Map<string, CacheEntry>();

/**
 * The user's own display name(s) for outbound detection, from
 * `user_settings.settings->'self_names'` (a JSON array of strings). Used to flag
 * `from_me` on phone-mirrored messages the device can't self-attribute — chiefly
 * Slack channel posts read off-screen, where the author is the user themselves.
 * Lower-cased + trimmed; cached 60s. Empty when unset (no self-attribution).
 */
export async function getSelfNames(pool: Pool, userId: string): Promise<string[]> {
  const cached = cache.get(userId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.names;

  try {
    const result = await pool.query(
      "SELECT settings->'self_names' as sn FROM user_settings WHERE user_id = $1",
      [userId],
    );
    const raw = result.rows[0]?.sn;
    const names = Array.isArray(raw)
      ? raw.filter((x): x is string => typeof x === 'string').map((s) => s.trim().toLowerCase()).filter(Boolean)
      : [];
    cache.set(userId, { names, ts: Date.now() });
    return names;
  } catch (err) {
    logger.warn('[getSelfNames] Failed to read settings, treating as none', {
      userId, error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** True if [name] matches one of the user's own display names (case-insensitive). */
export function isSelfAuthor(name: string | null | undefined, selfNames: string[]): boolean {
  if (!name || selfNames.length === 0) return false;
  return selfNames.includes(name.trim().toLowerCase());
}
