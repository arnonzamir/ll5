import { describe, it, expect } from "vitest";
import {
  roleBadgeVariant,
  onboardingProgress,
  relativeTime,
} from "./tenants-types";

describe("roleBadgeVariant", () => {
  it("styles superadmin distinctly", () => {
    expect(roleBadgeVariant("superadmin")).toBe("destructive");
    expect(roleBadgeVariant("admin")).toBe("default");
    expect(roleBadgeVariant("user")).toBe("secondary");
    expect(roleBadgeVariant("anything-else")).toBe("secondary");
  });
});

describe("onboardingProgress", () => {
  it("reports complete when completed=true regardless of steps", () => {
    const p = onboardingProgress({ completed: true, steps: { a: false } });
    expect(p.complete).toBe(true);
    expect(p.percent).toBe(100);
  });

  it("computes percent from steps", () => {
    const p = onboardingProgress({
      completed: false,
      steps: { a: true, b: true, c: false, d: false },
    });
    expect(p.done).toBe(2);
    expect(p.total).toBe(4);
    expect(p.percent).toBe(50);
    expect(p.complete).toBe(false);
  });

  it("treats all-true steps as 100% complete even if completed flag is false", () => {
    const p = onboardingProgress({
      completed: false,
      steps: { a: true, b: true },
    });
    expect(p.percent).toBe(100);
    expect(p.complete).toBe(true);
  });

  it("returns 0% for no steps and not completed", () => {
    expect(onboardingProgress({ completed: false, steps: {} })).toMatchObject({
      percent: 0,
      complete: false,
      total: 0,
    });
    expect(onboardingProgress(null)).toMatchObject({ percent: 0, total: 0 });
    expect(onboardingProgress(undefined)).toMatchObject({ percent: 0 });
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-05-30T12:00:00Z");

  it("returns 'never' for null/empty/invalid", () => {
    expect(relativeTime(null, now)).toBe("never");
    expect(relativeTime(undefined, now)).toBe("never");
    expect(relativeTime("", now)).toBe("never");
    expect(relativeTime("not-a-date", now)).toBe("never");
  });

  it("formats recent and older timestamps", () => {
    expect(relativeTime("2026-05-30T11:59:30Z", now)).toBe("just now");
    expect(relativeTime("2026-05-30T11:30:00Z", now)).toBe("30m ago");
    expect(relativeTime("2026-05-30T09:00:00Z", now)).toBe("3h ago");
    expect(relativeTime("2026-05-28T12:00:00Z", now)).toBe("2d ago");
    expect(relativeTime("2026-04-15T12:00:00Z", now)).toBe("2mo ago");
    expect(relativeTime("2024-05-30T12:00:00Z", now)).toBe("2y ago");
  });

  it("clamps future timestamps to 'just now'", () => {
    expect(relativeTime("2026-05-30T12:05:00Z", now)).toBe("just now");
  });
});
