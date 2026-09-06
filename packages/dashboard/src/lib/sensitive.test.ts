import { describe, it, expect } from "vitest";
import {
  SENSITIVE_PATHS,
  STEP_UP_TTL_SECONDS,
  isSensitivePath,
  isStepUpValid,
  safeNextPath,
  signStepUp,
  userIdFromPayload,
} from "./sensitive";

const SECRET = "unit-test-secret";
const NOW = 1_800_000_000;

describe("step-up cookie", () => {
  it("accepts a fresh cookie signed for the same user", async () => {
    const exp = NOW + STEP_UP_TTL_SECONDS;
    const cookie = await signStepUp("user-1", exp, SECRET);
    expect(cookie.startsWith(`${exp}.`)).toBe(true);
    expect(await isStepUpValid(cookie, "user-1", SECRET, NOW)).toBe(true);
    // Still valid one second before expiry, not at expiry.
    expect(await isStepUpValid(cookie, "user-1", SECRET, exp - 1)).toBe(true);
    expect(await isStepUpValid(cookie, "user-1", SECRET, exp)).toBe(false);
  });

  it("rejects an expired cookie", async () => {
    const cookie = await signStepUp("user-1", NOW - 1, SECRET);
    expect(await isStepUpValid(cookie, "user-1", SECRET, NOW)).toBe(false);
  });

  it("rejects a tampered signature or expiry", async () => {
    const exp = NOW + 60;
    const cookie = await signStepUp("user-1", exp, SECRET);
    const [expStr, sig] = cookie.split(".");
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    expect(await isStepUpValid(`${expStr}.${flipped}`, "user-1", SECRET, NOW)).toBe(false);
    // Extending the expiry without re-signing must fail.
    expect(await isStepUpValid(`${exp + 3600}.${sig}`, "user-1", SECRET, NOW)).toBe(false);
    // A different secret must fail.
    expect(await isStepUpValid(cookie, "user-1", "other-secret", NOW)).toBe(false);
  });

  it("rejects a cookie minted for another user", async () => {
    const cookie = await signStepUp("user-1", NOW + 60, SECRET);
    expect(await isStepUpValid(cookie, "user-2", SECRET, NOW)).toBe(false);
  });

  it("rejects malformed values and missing inputs without throwing", async () => {
    for (const v of ["", ".", "abc", "123", "123.", ".sig", "12x.sig", "99999999999999.sig"]) {
      expect(await isStepUpValid(v, "user-1", SECRET, NOW)).toBe(false);
    }
    const cookie = await signStepUp("user-1", NOW + 60, SECRET);
    expect(await isStepUpValid(cookie, null, SECRET, NOW)).toBe(false);
    expect(await isStepUpValid(cookie, "user-1", "", NOW)).toBe(false);
    expect(await isStepUpValid(null, "user-1", SECRET, NOW)).toBe(false);
  });
});

describe("sensitive catalog", () => {
  it("lists finance and connectors settings", () => {
    expect(SENSITIVE_PATHS).toContain("/finance");
    expect(SENSITIVE_PATHS).toContain("/settings/connectors");
  });

  it("prefix-matches on path segments only", () => {
    expect(isSensitivePath("/finance")).toBe(true);
    expect(isSensitivePath("/finance/ledger")).toBe(true);
    expect(isSensitivePath("/financed")).toBe(false);
    expect(isSensitivePath("/settings/connectors")).toBe(true);
    expect(isSensitivePath("/settings/connectors-old")).toBe(false);
    expect(isSensitivePath("/settings")).toBe(false);
    expect(isSensitivePath("/verify")).toBe(false);
  });
});

describe("helpers", () => {
  it("reads uid (or sub) from the token payload", () => {
    expect(userIdFromPayload({ uid: "u1" })).toBe("u1");
    expect(userIdFromPayload({ sub: "u2" })).toBe("u2");
    expect(userIdFromPayload({ uid: "" })).toBeNull();
    expect(userIdFromPayload(null)).toBeNull();
  });

  it("only allows same-origin relative next paths", () => {
    expect(safeNextPath("/finance?period=7")).toBe("/finance?period=7");
    expect(safeNextPath(null)).toBe("/dashboard");
    expect(safeNextPath("//evil.example")).toBe("/dashboard");
    expect(safeNextPath("https://evil.example/x")).toBe("/dashboard");
    expect(safeNextPath("/http://evil.example")).toBe("/dashboard");
    expect(safeNextPath("/\\evil.example")).toBe("/dashboard");
    expect(safeNextPath("/verify?next=/finance")).toBe("/dashboard");
  });
});
