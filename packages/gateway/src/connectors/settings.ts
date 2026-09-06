/**
 * Per-user connector settings — `user_settings.settings.connectors`:
 *   { rules: { amount_threshold, duplicate_window_minutes },
 *     known_merchants: string[] }
 * Written by the dashboard's /settings/connectors page; read here with a 60 s
 * cache (same shape as utils/data-source-config.ts). Missing → defaults.
 */
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { DEFAULT_RULE_THRESHOLDS, merchantKey, normalizeThresholds, type RuleThresholds } from './rules.js';

export interface ConnectorRuleSettings {
  thresholds: RuleThresholds;
  /** Merchant keys (normalized) the user marked as known. */
  knownMerchantKeys: Set<string>;
}

const CACHE_TTL = 60_000;
const cache = new Map<string, { value: ConnectorRuleSettings; ts: number }>();

export function parseConnectorSettings(raw: unknown): ConnectorRuleSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const known = new Set<string>();
  if (Array.isArray(r.known_merchants)) {
    for (const m of r.known_merchants) {
      const key = typeof m === 'string' ? merchantKey(m) : null;
      if (key) known.add(key);
    }
  }
  return { thresholds: normalizeThresholds(r.rules), knownMerchantKeys: known };
}

export async function readConnectorRuleSettings(pool: Pool, userId: string): Promise<ConnectorRuleSettings> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.value;
  try {
    const r = await pool.query<{ c: unknown }>(
      `SELECT settings->'connectors' AS c FROM user_settings WHERE user_id = $1`,
      [userId],
    );
    const value = parseConnectorSettings(r.rows[0]?.c);
    cache.set(userId, { value, ts: Date.now() });
    return value;
  } catch (err) {
    logger.warn('[connectors][settings] Failed to read connector settings, using defaults', {
      userId, error: err instanceof Error ? err.message : String(err),
    });
    return { thresholds: { ...DEFAULT_RULE_THRESHOLDS }, knownMerchantKeys: new Set() };
  }
}

export function resetConnectorSettingsCache(): void { cache.clear(); }
