import { describe, it, expect } from "vitest";
import {
  decideTokenAction,
  REFRESH_WINDOW_SECONDS,
  REFRESH_GRACE_SECONDS,
} from "./auth-decision";

describe("decideTokenAction", () => {
  it("passes a comfortably-valid token (well beyond the refresh window)", () => {
    expect(decideTokenAction(REFRESH_WINDOW_SECONDS + 60, true)).toBe("pass");
  });

  it("passes a token exactly at the refresh boundary (>= window)", () => {
    expect(decideTokenAction(REFRESH_WINDOW_SECONDS, true)).toBe("pass");
  });

  it("refreshes a near-expiry token (inside the refresh window, not yet expired)", () => {
    expect(decideTokenAction(REFRESH_WINDOW_SECONDS - 60, true)).toBe("refresh");
    expect(decideTokenAction(60, true)).toBe("refresh");
  });

  it("refreshes a just-expired token (within the gateway grace window)", () => {
    // secondsLeft <= 0 but inside grace must still attempt refresh, not reauth.
    expect(decideTokenAction(0, true)).toBe("refresh");
    expect(decideTokenAction(-60, true)).toBe("refresh");
    expect(decideTokenAction(-(REFRESH_GRACE_SECONDS - 60), true)).toBe(
      "refresh",
    );
  });

  it("reauths a token expired beyond the grace window", () => {
    expect(decideTokenAction(-REFRESH_GRACE_SECONDS, true)).toBe("reauth");
    expect(decideTokenAction(-(REFRESH_GRACE_SECONDS + 60), true)).toBe(
      "reauth",
    );
  });

  it("reauths a token with no exp claim instead of refresh-spamming", () => {
    // Missing exp decodes to a hugely-negative secondsLeft; must NOT refresh.
    expect(decideTokenAction(-1_700_000_000, false)).toBe("reauth");
    // Even a numerically 'fine' secondsLeft is reauth when exp was absent.
    expect(decideTokenAction(REFRESH_WINDOW_SECONDS + 999, false)).toBe(
      "reauth",
    );
  });
});
