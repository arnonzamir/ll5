/**
 * Pure shapes + maths for /settings/delivery ("What works for you").
 * DECISION-034 Phase 4. No next/* imports so the helpers run in unit tests.
 *
 * Contract (gateway + awareness user model):
 *   GET /me/delivery-stats?days=14 → { days, buckets: [{ key, n, modalities: { <modality>: counts } }] }
 *   read_user_model section "delivery_policy" → { version, updated_at, exploration_rate, buckets: { key: { preferred, floor, n, score } } }
 *   bucket key = "<class>|<stakes>|<deadline_band>|<mode_at_send>"
 */

export const MODALITIES = ["chat", "push_silent", "push_notify", "push_alert", "push_alarm", "reach"] as const;
export type Modality = (typeof MODALITIES)[number];

export const MODALITY_LABEL: Record<Modality, string> = {
  chat: "chat only",
  push_silent: "silent push",
  push_notify: "notify",
  push_alert: "alert",
  push_alarm: "alarm",
  reach: "reach (WhatsApp)",
};

export interface ModalityCounts {
  sent: number;
  seen: number;
  acknowledged: number;
  done_by_deadline: number;
  dismissed: number;
  missed: number;
  too_much: number;
  not_enough: number;
}

export interface StatsBucket {
  key: string;
  n: number;
  modalities: Partial<Record<Modality, ModalityCounts>>;
}

export interface DeliveryStats {
  days: number;
  buckets: StatsBucket[];
}

export interface PolicyBucket {
  preferred: string;
  floor: string | null;
  n: number;
  score: number | null;
}

export interface DeliveryPolicy {
  version: number;
  updated_at: string | null;
  exploration_rate: number;
  buckets: Record<string, PolicyBucket>;
}

/** What "reset learning" writes back through write_user_model. */
export const RESET_POLICY = { version: 1, exploration_rate: 0.35, buckets: {} } as const;

export interface BucketKeyParts {
  cls: string;
  stakes: string;
  deadline_band: string;
  mode: string;
}

const CLASS_ORDER = ["do-by", "needs-you", "fyi"];
const STAKES_ORDER = ["high", "medium", "low"];
const BAND_ORDER = ["<1h", "1-4h", "4-24h", ">24h"];

/** Split "class|stakes|deadline_band|mode" — missing parts render as "-". */
export function parseBucketKey(key: string): BucketKeyParts {
  const [cls = "", stakes = "", deadline_band = "", mode = ""] = key.split("|");
  return {
    cls: cls || "-",
    stakes: stakes || "-",
    deadline_band: deadline_band || "-",
    mode: mode || "-",
  };
}

function rank(list: string[], v: string): number {
  const i = list.indexOf(v);
  return i === -1 ? list.length : i;
}

/** Stable display order: do-by before needs-you before fyi, high stakes first, nearest deadline first. */
export function compareBucketKeys(a: string, b: string): number {
  const pa = parseBucketKey(a);
  const pb = parseBucketKey(b);
  return (
    rank(CLASS_ORDER, pa.cls) - rank(CLASS_ORDER, pb.cls) ||
    rank(STAKES_ORDER, pa.stakes) - rank(STAKES_ORDER, pb.stakes) ||
    rank(BAND_ORDER, pa.deadline_band) - rank(BAND_ORDER, pb.deadline_band) ||
    pa.mode.localeCompare(pb.mode)
  );
}

/** A share of `sent`, clamped to [0, 1]; null when nothing was sent. */
export function share(part: number, sent: number): number | null {
  if (!Number.isFinite(sent) || sent <= 0) return null;
  return Math.min(1, Math.max(0, part / sent));
}

/** "Acted on" = acknowledged + done by deadline, over sent. */
export function actedOnRate(c: ModalityCounts): number | null {
  return share(c.acknowledged + c.done_by_deadline, c.sent);
}

export function pct(v: number | null): string {
  return v === null ? "-" : `${Math.round(v * 100)}%`;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function normaliseCounts(raw: unknown): ModalityCounts {
  const r = isRecord(raw) ? raw : {};
  return {
    sent: num(r.sent),
    seen: num(r.seen),
    acknowledged: num(r.acknowledged),
    done_by_deadline: num(r.done_by_deadline),
    dismissed: num(r.dismissed),
    missed: num(r.missed),
    too_much: num(r.too_much),
    not_enough: num(r.not_enough),
  };
}

/** Coerce the gateway payload into the typed shape; unknown modalities are dropped, malformed buckets skipped. */
export function normaliseStats(raw: unknown, fallbackDays = 14): DeliveryStats {
  const r = isRecord(raw) ? raw : {};
  const buckets: StatsBucket[] = [];
  for (const b of Array.isArray(r.buckets) ? r.buckets : []) {
    if (!isRecord(b) || typeof b.key !== "string") continue;
    const modalities: StatsBucket["modalities"] = {};
    const mods = isRecord(b.modalities) ? b.modalities : {};
    for (const m of MODALITIES) {
      if (m in mods) modalities[m] = normaliseCounts(mods[m]);
    }
    buckets.push({ key: b.key, n: num(b.n), modalities });
  }
  buckets.sort((a, b) => compareBucketKeys(a.key, b.key));
  return { days: num(r.days, fallbackDays), buckets };
}

/** Coerce the user-model section content into the typed policy. */
export function normalisePolicy(raw: unknown): DeliveryPolicy {
  const r = isRecord(raw) ? raw : {};
  const buckets: Record<string, PolicyBucket> = {};
  const rb = isRecord(r.buckets) ? r.buckets : {};
  for (const key of Object.keys(rb).sort(compareBucketKeys)) {
    const b = isRecord(rb[key]) ? rb[key] : {};
    buckets[key] = {
      preferred: typeof b.preferred === "string" ? b.preferred : "-",
      floor: typeof b.floor === "string" ? b.floor : null,
      n: num(b.n),
      score: typeof b.score === "number" && Number.isFinite(b.score) ? b.score : null,
    };
  }
  return {
    version: num(r.version, 1),
    updated_at: typeof r.updated_at === "string" ? r.updated_at : null,
    exploration_rate: num(r.exploration_rate, RESET_POLICY.exploration_rate),
    buckets,
  };
}
