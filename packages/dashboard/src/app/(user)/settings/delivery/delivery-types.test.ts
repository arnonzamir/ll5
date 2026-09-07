import { describe, expect, it } from "vitest";
import {
  RESET_POLICY,
  actedOnRate,
  compareBucketKeys,
  normaliseCounts,
  normalisePolicy,
  normaliseStats,
  parseBucketKey,
  share,
} from "./delivery-types";

describe("parseBucketKey", () => {
  it("splits class | stakes | deadline band | mode", () => {
    expect(parseBucketKey("do-by|high|<1h|normal")).toEqual({
      cls: "do-by",
      stakes: "high",
      deadline_band: "<1h",
      mode: "normal",
    });
  });
  it("renders missing parts as a dash", () => {
    expect(parseBucketKey("fyi")).toEqual({ cls: "fyi", stakes: "-", deadline_band: "-", mode: "-" });
    expect(parseBucketKey("needs-you||>24h|")).toEqual({ cls: "needs-you", stakes: "-", deadline_band: ">24h", mode: "-" });
  });
});

describe("compareBucketKeys", () => {
  it("orders do-by first, then stakes high→low, then nearest deadline", () => {
    const keys = ["fyi|low|>24h|normal", "do-by|low|<1h|normal", "do-by|high|4-24h|normal", "needs-you|medium|1-4h|quiet"];
    expect([...keys].sort(compareBucketKeys)).toEqual([
      "do-by|high|4-24h|normal",
      "do-by|low|<1h|normal",
      "needs-you|medium|1-4h|quiet",
      "fyi|low|>24h|normal",
    ]);
  });
});

describe("rates", () => {
  it("acted-on = acknowledged + done_by_deadline over sent", () => {
    expect(actedOnRate(normaliseCounts({ sent: 10, acknowledged: 3, done_by_deadline: 4 }))).toBe(0.7);
  });
  it("is null when nothing was sent and clamps to 1", () => {
    expect(actedOnRate(normaliseCounts({ sent: 0, acknowledged: 2 }))).toBeNull();
    expect(share(12, 10)).toBe(1);
  });
});

describe("normaliseStats", () => {
  it("keeps known modalities, coerces counts, drops malformed buckets, sorts keys", () => {
    const s = normaliseStats({
      days: 14,
      buckets: [
        { key: "fyi|low|>24h|normal", n: 2, modalities: { chat: { sent: 2, seen: "x" }, sms: { sent: 9 } } },
        { key: "do-by|high|<1h|normal", n: 5, modalities: { push_alert: { sent: 5, done_by_deadline: 4 } } },
        { nope: true },
      ],
    });
    expect(s.days).toBe(14);
    expect(s.buckets.map((b) => b.key)).toEqual(["do-by|high|<1h|normal", "fyi|low|>24h|normal"]);
    expect(s.buckets[1].modalities.chat?.seen).toBe(0);
    expect("sms" in s.buckets[1].modalities).toBe(false);
  });
  it("survives garbage", () => {
    expect(normaliseStats(null)).toEqual({ days: 14, buckets: [] });
    expect(normaliseStats("nope")).toEqual({ days: 14, buckets: [] });
  });
});

describe("normalisePolicy", () => {
  it("coerces the section content and defaults the exploration rate", () => {
    const p = normalisePolicy({ version: 3, buckets: { "needs-you|low|>24h|normal": { preferred: "push_silent", n: 7, score: 0.4 } } });
    expect(p.version).toBe(3);
    expect(p.exploration_rate).toBe(RESET_POLICY.exploration_rate);
    expect(p.buckets["needs-you|low|>24h|normal"]).toEqual({ preferred: "push_silent", floor: null, n: 7, score: 0.4 });
  });
  it("reset shape is exactly what the design specifies", () => {
    expect(RESET_POLICY).toEqual({ version: 1, exploration_rate: 0.35, buckets: {} });
  });
});
