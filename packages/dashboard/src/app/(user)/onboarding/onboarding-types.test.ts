import { describe, it, expect } from "vitest";
import {
  WIZARD_STEPS,
  ALL_STEP_KEYS,
  isStepComplete,
  firstIncompleteStepIndex,
  stepProgress,
  type OnboardingStepMap,
} from "./onboarding-types";

describe("ALL_STEP_KEYS", () => {
  it("flattens every tracked step key in panel order", () => {
    expect(ALL_STEP_KEYS).toEqual([
      "profile_set",
      "notifications_set",
      "google_connected",
      "whatsapp_connected",
      "health_connected",
      "phone_linked",
      "agent_connected",
    ]);
  });

  it("excludes the terminal done panel (it carries no key)", () => {
    const done = WIZARD_STEPS.find((s) => s.id === "done");
    expect(done?.keys).toEqual([]);
  });
});

describe("isStepComplete", () => {
  const profile = WIZARD_STEPS[0];
  const channels = WIZARD_STEPS.find((s) => s.id === "channels")!;
  const done = WIZARD_STEPS.find((s) => s.id === "done")!;

  it("is complete only when all of a panel's keys are done", () => {
    expect(isStepComplete(profile, { profile_set: true }, false)).toBe(true);
    expect(isStepComplete(profile, {}, false)).toBe(false);
  });

  it("requires every bundled key for multi-key panels (channels)", () => {
    expect(isStepComplete(channels, { whatsapp_connected: true }, false)).toBe(false);
    expect(
      isStepComplete(channels, { whatsapp_connected: true, health_connected: true }, false),
    ).toBe(true);
  });

  it("treats the done panel as complete only when completed=true", () => {
    expect(isStepComplete(done, {}, false)).toBe(false);
    expect(isStepComplete(done, {}, true)).toBe(true);
  });
});

describe("firstIncompleteStepIndex", () => {
  it("returns 0 when nothing is done", () => {
    expect(firstIncompleteStepIndex({})).toBe(0);
  });

  it("skips completed panels and stops at the first incomplete one", () => {
    const steps: OnboardingStepMap = { profile_set: true, notifications_set: true };
    // google is index 2
    expect(firstIncompleteStepIndex(steps)).toBe(2);
  });

  it("requires both channel keys before advancing past channels", () => {
    const steps: OnboardingStepMap = {
      profile_set: true,
      notifications_set: true,
      google_connected: true,
      whatsapp_connected: true,
      // health_connected missing
    };
    const channelsIdx = WIZARD_STEPS.findIndex((s) => s.id === "channels");
    expect(firstIncompleteStepIndex(steps)).toBe(channelsIdx);
  });

  it("lands on the done panel when every tracked key is done", () => {
    const all: OnboardingStepMap = Object.fromEntries(
      ALL_STEP_KEYS.map((k) => [k, true]),
    );
    const doneIdx = WIZARD_STEPS.findIndex((s) => s.id === "done");
    expect(firstIncompleteStepIndex(all)).toBe(doneIdx);
  });
});

describe("stepProgress", () => {
  it("reports 0% for an empty step map", () => {
    expect(stepProgress({}, false)).toEqual({ done: 0, total: ALL_STEP_KEYS.length, percent: 0 });
  });

  it("computes percent from done keys", () => {
    const steps: OnboardingStepMap = { profile_set: true, notifications_set: true };
    const p = stepProgress(steps, false);
    expect(p.done).toBe(2);
    expect(p.total).toBe(ALL_STEP_KEYS.length);
    expect(p.percent).toBe(Math.round((2 / ALL_STEP_KEYS.length) * 100));
  });

  it("forces 100% when completed=true", () => {
    expect(stepProgress({}, true)).toEqual({
      done: ALL_STEP_KEYS.length,
      total: ALL_STEP_KEYS.length,
      percent: 100,
    });
  });
});
