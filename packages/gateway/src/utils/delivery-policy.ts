import { logger } from './logger.js';
import { callMcpTool, userBearer } from './mcp-call.js';
import { LEVEL_BY_STAKES, maxLevel, modalityForLevel } from './delivery-contract.js';
import type { DeliveryClass, Modality, Stakes } from './delivery-contract.js';
import type { NotificationLevel } from './fcm-sender.js';
import type { DeliveryMode } from './delivery-mode.js';
import { bucketKey, deadlineBand } from './delivery-stats.js';

/**
 * Policy-driven modality (DECISION-034 Phase 4).
 *
 * The agent's nightly pass writes a small `delivery_policy` section to the
 * user model (awareness MCP) from `GET /me/delivery-stats`; the gateway reads
 * it here at send time — so the learned choice applies even when the agent
 * forgets — and picks the modality for a classed message:
 *
 *   1. base = the bucket's `preferred` when the policy has the bucket,
 *      else the Phase 1 stakes map (low silent / medium notify / high alert /
 *      critical critical);
 *   2. never below the bucket's `floor`, never below the agent's own `level`
 *      (a floor, DECISION-034 §2), never above what delivery mode allows
 *      (sleep / quiet_hours: push_silent; driving / meeting: push_notify;
 *      critical stakes lift every ceiling);
 *   3. with probability `exploration_rate` (policy's, default 0.35) pick ONE
 *      rung STRONGER than the base when there is one under the ceiling —
 *      start assertive and dial back (Section 8 answer 6) — and mark the
 *      record `explored` so the stats keep exploration apart from policy.
 *
 * alarm and reach are ladder rungs, never send-time picks: the ceiling is
 * push_alert unless stakes are critical.
 */

/** Send-time modalities, weakest to strongest. */
export const SEND_MODALITIES: readonly Modality[] = ['chat', 'push_silent', 'push_notify', 'push_alert', 'push_alarm'];
const RANK: Record<Modality, number> = { chat: 0, push_silent: 1, push_notify: 2, push_alert: 3, push_alarm: 4, reach: 5 };

export const DEFAULT_EXPLORATION_RATE = 0.35;
export const POLICY_SECTION = 'delivery_policy';
export const POLICY_MAX_BYTES = 12 * 1024;
export const POLICY_CACHE_TTL_MS = 5 * 60_000;

export interface PolicyBucket {
  preferred: Modality;
  floor?: Modality;
  n?: number;
  score?: number;
}

export interface DeliveryPolicy {
  version: number;
  updated_at?: string;
  exploration_rate?: number;
  buckets: Record<string, PolicyBucket>;
}

const isModality = (v: unknown): v is Modality => typeof v === 'string' && v in RANK;

/** Pure: parse whatever the user model holds (string or object) into a policy, or null when unusable. */
export function parseDeliveryPolicy(raw: unknown): DeliveryPolicy | null {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.length > POLICY_MAX_BYTES) return null;
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const bucketsRaw = o.buckets;
  if (!bucketsRaw || typeof bucketsRaw !== 'object') return null;
  const buckets: Record<string, PolicyBucket> = {};
  for (const [k, v] of Object.entries(bucketsRaw as Record<string, unknown>)) {
    const b = v as Record<string, unknown> | null;
    if (!b || typeof b !== 'object' || !isModality(b.preferred)) continue;
    const pb: PolicyBucket = { preferred: b.preferred };
    if (isModality(b.floor)) pb.floor = b.floor;
    if (typeof b.n === 'number') pb.n = b.n;
    if (typeof b.score === 'number') pb.score = b.score;
    buckets[k] = pb;
  }
  const rate = typeof o.exploration_rate === 'number' && Number.isFinite(o.exploration_rate)
    ? Math.min(1, Math.max(0, o.exploration_rate)) : undefined;
  return {
    version: typeof o.version === 'number' ? o.version : 1,
    updated_at: typeof o.updated_at === 'string' ? o.updated_at : undefined,
    exploration_rate: rate,
    buckets,
  };
}

export function levelForModality(m: Modality): NotificationLevel | null {
  switch (m) {
    case 'push_silent': return 'silent';
    case 'push_notify': return 'notify';
    case 'push_alert': return 'alert';
    case 'push_alarm': return 'critical';
    case 'reach': return 'critical';
    default: return null;
  }
}

/** Pure: the strongest send-time modality the delivery mode permits. */
export function modeCeiling(mode: DeliveryMode | string | null | undefined, stakes: Stakes | null): Modality {
  if (stakes === 'critical') return 'push_alarm';
  if (mode === 'sleep' || mode === 'quiet_hours') return 'push_silent';
  if (mode === 'driving' || mode === 'meeting') return 'push_notify';
  return 'push_alert';
}

const stronger = (a: Modality, b: Modality): Modality => (RANK[a] >= RANK[b] ? a : b);
const weaker = (a: Modality, b: Modality): Modality => (RANK[a] <= RANK[b] ? a : b);

export interface PickInput {
  cls: DeliveryClass;
  stakes: Stakes | null;
  due_at: string | Date | null;
  now: Date;
  mode: DeliveryMode | string | null;
  /** The agent's own notification_level — a floor. */
  agent_level: NotificationLevel | null;
  policy: DeliveryPolicy | null;
  /** [0, 1) — injected so tests can seed it. */
  rng: () => number;
}

export interface PickResult {
  modality: Modality;
  level: NotificationLevel | null;
  explored: boolean;
  bucket: string;
  source: 'policy' | 'default';
}

/** Pure: the send-time modality for a needs-you / do-by (see the module comment). */
export function pickModality(input: PickInput): PickResult {
  const stakes = input.stakes ?? 'medium';
  const bucket = bucketKey(input.cls, input.stakes, deadlineBand(input.due_at, input.now), input.mode);
  const pb = input.policy?.buckets[bucket];

  const phase1: Modality = modalityForLevel(LEVEL_BY_STAKES[stakes]);
  let base: Modality = pb ? pb.preferred : phase1;
  if (pb?.floor) base = stronger(base, pb.floor);
  const ceiling = modeCeiling(input.mode, input.stakes);
  base = weaker(base, ceiling);
  // The agent's level is a floor that survives the mode ceiling — it asked.
  if (input.agent_level) base = stronger(base, modalityForLevel(maxLevel(input.agent_level, null)));

  let modality = base;
  let explored = false;
  const rate = input.policy?.exploration_rate ?? DEFAULT_EXPLORATION_RATE;
  const next = SEND_MODALITIES[RANK[base] + 1];
  if (next && RANK[next] <= RANK[ceiling] && input.rng() < rate) {
    modality = next;
    explored = true;
  }
  return { modality, level: levelForModality(modality), explored, bucket, source: pb ? 'policy' : 'default' };
}

// ---------------------------------------------------------------------------
// Reader (awareness MCP `read_user_model`, 5-minute cache per user)
// ---------------------------------------------------------------------------

export interface PolicyReaderConfig {
  awarenessMcpUrl: string | undefined;
  authSecret: string;
}

export type SectionFetcher = (userId: string) => Promise<unknown>;

interface CacheEntry { policy: DeliveryPolicy | null; at: number }
const CACHE = new Map<string, CacheEntry>();

/** Test hook. */
export function resetDeliveryPolicyCache(): void { CACHE.clear(); }

function mcpFetcher(cfg: PolicyReaderConfig): SectionFetcher {
  return async (userId) => {
    if (!cfg.awarenessMcpUrl) return null;
    const out = await callMcpTool(cfg.awarenessMcpUrl, userBearer(userId, cfg.authSecret), 'read_user_model', { section: POLICY_SECTION });
    return out && typeof out === 'object' ? (out as { content?: unknown }).content ?? null : null;
  };
}

/**
 * The user's delivery policy, or null (no section yet / MCP down). Cached 5
 * minutes either way so a send never waits on a slow MCP twice. A failure is
 * logged and behaves like "no policy" — the Phase 1 map applies.
 */
export async function readDeliveryPolicy(cfg: PolicyReaderConfig, userId: string, fetcher: SectionFetcher = mcpFetcher(cfg), now = Date.now()): Promise<DeliveryPolicy | null> {
  const hit = CACHE.get(userId);
  if (hit && now - hit.at < POLICY_CACHE_TTL_MS) return hit.policy;
  let policy: DeliveryPolicy | null = null;
  try {
    policy = parseDeliveryPolicy(await fetcher(userId));
  } catch (err) {
    logger.warn('[deliveryPolicy][read] read_user_model failed — Phase 1 map applies', { userId, error: err instanceof Error ? err.message : String(err) });
  }
  CACHE.set(userId, { policy, at: now });
  return policy;
}
