/**
 * Connector rules engine — pure (docs/design/connectors.md, Section 6).
 *
 * `evaluate(event, ctx)` returns the rules a stored event trips. The gateway
 * acts on the hits (trigger ladder in processors/connector-event.ts); the
 * connectors MCP only records them (`rule_hits`).
 *
 * Rules (charges only — refunds, bills, notices, OTPs and unknowns never trip):
 *   amount_threshold  amount >= thresholds.amount_threshold (ILS-equivalent not
 *                     attempted: foreign amounts compare as-is; `foreign` covers them)
 *   unknown_merchant  the merchant key has not been seen >= 2 times
 *   foreign           non-ILS currency or a "חו"ל" wording
 *   duplicate         same amount + currency + merchant key within
 *                     thresholds.duplicate_window_minutes of an earlier event
 *   asleep_at_home    delivery mode is `sleep` and the user is at home — a card
 *                     used while its owner sleeps is the one case that pushes
 *                     at high priority
 *
 * Thresholds live in user_settings.settings.connectors.rules
 * (connectors/settings.ts); known merchants come from the in-memory
 * MerchantMemory plus settings.connectors.known_merchants. Limitation: the
 * memory is per gateway process, so after a restart every merchant is
 * "unknown" again until it has been seen twice, unless it is listed in
 * settings. Asking the connectors MCP (query_events) would be the durable
 * source; deliberately not done in Phase 1 to keep the gateway's per-event
 * path to one HTTP call.
 */
import type { ConnectorEventInput } from '@ll5/shared';

export type RuleId = 'amount_threshold' | 'unknown_merchant' | 'foreign' | 'duplicate' | 'asleep_at_home';

export interface RuleHit {
  rule: RuleId;
  /** Short human phrase for the system message, e.g. "unknown merchant". */
  detail: string;
}

export interface RuleThresholds {
  amount_threshold: number;
  duplicate_window_minutes: number;
}

export const DEFAULT_RULE_THRESHOLDS: RuleThresholds = {
  amount_threshold: 500,
  duplicate_window_minutes: 10,
};

export interface RecentEvent {
  merchantKey: string | null;
  amount: number | null;
  currency: string | null;
  /** ISO-8601. */
  occurred_at: string;
}

export interface RuleContext {
  thresholds: RuleThresholds;
  knownMerchantKeys: Set<string>;
  /** Earlier events for the same user (any connector), newest last. Must NOT include `event` itself. */
  recentEvents: RecentEvent[];
  deliveryMode: string;
  atHome: boolean;
}

/** Normalize a merchant string to a comparison key: lowercase, letters/digits only, single spaces. */
export function merchantKey(merchant: string | null | undefined): string | null {
  if (!merchant) return null;
  const key = merchant
    .toLowerCase()
    .replace(/\*temporary hold/gi, '')
    .replace(/[^a-z0-9א-ת]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  return key || null;
}

/** Coerce a settings blob into thresholds, ignoring bad values. */
export function normalizeThresholds(raw: unknown): RuleThresholds {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);
  return {
    amount_threshold: num(r.amount_threshold, DEFAULT_RULE_THRESHOLDS.amount_threshold),
    duplicate_window_minutes: num(r.duplicate_window_minutes, DEFAULT_RULE_THRESHOLDS.duplicate_window_minutes),
  };
}

export function evaluate(event: ConnectorEventInput, ctx: RuleContext): RuleHit[] {
  if (event.kind !== 'charge') return [];
  const hits: RuleHit[] = [];
  const amount = typeof event.amount === 'number' ? event.amount : null;
  const key = merchantKey(event.merchant);

  if (amount !== null && amount >= ctx.thresholds.amount_threshold) {
    hits.push({ rule: 'amount_threshold', detail: `over ${ctx.thresholds.amount_threshold}` });
  }
  if (key && !ctx.knownMerchantKeys.has(key)) {
    hits.push({ rule: 'unknown_merchant', detail: 'unknown merchant' });
  }
  if (event.foreign) {
    hits.push({ rule: 'foreign', detail: 'foreign' });
  }
  if (amount !== null && key) {
    const windowMs = ctx.thresholds.duplicate_window_minutes * 60_000;
    const t = Date.parse(event.occurred_at);
    const dup = ctx.recentEvents.find((r) => {
      if (r.amount !== amount || r.merchantKey !== key) return false;
      if ((r.currency ?? 'ILS') !== (event.currency ?? 'ILS')) return false;
      const rt = Date.parse(r.occurred_at);
      return Number.isFinite(t) && Number.isFinite(rt) && Math.abs(t - rt) <= windowMs;
    });
    if (dup) hits.push({ rule: 'duplicate', detail: `duplicate within ${ctx.thresholds.duplicate_window_minutes} min` });
  }
  if (ctx.deliveryMode === 'sleep' && ctx.atHome) {
    hits.push({ rule: 'asleep_at_home', detail: 'card used while you are asleep at home' });
  }
  return hits;
}
