import type { Pool } from 'pg';
import { logger } from './logger.js';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  userId: string;
  expiresAt: number;
}

/** In-memory cache: instance_name → user_id with TTL. */
const instanceUserCache = new Map<string, CacheEntry>();

/**
 * Resolve the user_id for a WhatsApp webhook by looking up the Evolution API
 * instance name in messaging_whatsapp_accounts.
 *
 * Uses a 5-minute TTL cache to avoid a DB hit on every webhook.
 * Falls back to the provided fallbackUserId if no mapping is found.
 */
export async function resolveWhatsAppUserId(
  pool: Pool,
  instanceName: string,
  fallbackUserId: string | undefined,
): Promise<string | undefined> {
  // Check cache first
  const cached = instanceUserCache.get(instanceName);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.userId;
  }

  // Cache miss or expired — query DB
  try {
    const result = await pool.query(
      'SELECT user_id FROM messaging_whatsapp_accounts WHERE instance_name = $1 LIMIT 1',
      [instanceName],
    );

    if (result.rows.length > 0) {
      const userId = result.rows[0].user_id as string;
      instanceUserCache.set(instanceName, {
        userId,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
      logger.debug('[resolveWhatsAppUserId] Resolved instance to user', { instanceName, userId });
      return userId;
    }

    logger.debug('[resolveWhatsAppUserId] No account found for instance, using fallback', {
      instanceName,
      fallbackUserId,
    });
  } catch (err) {
    logger.warn('[resolveWhatsAppUserId] DB lookup failed, using fallback', {
      instanceName,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return fallbackUserId;
}
