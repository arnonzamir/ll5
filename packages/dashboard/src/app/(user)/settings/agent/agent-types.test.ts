import { describe, it, expect } from "vitest";
import {
  ANTHROPIC_API_KEY_PREFIX,
  isLikelyAnthropicApiKey,
  maskedKeyDisplay,
  llmStatusLabel,
  formatMcpConfig,
  runtimeStatusBadge,
  canProvision,
  canStop,
  isTransientRuntime,
  normalizeRuntimeStatus,
  parseRuntime,
} from "./agent-types";

describe("isLikelyAnthropicApiKey", () => {
  it("accepts a well-formed sk-ant- key", () => {
    expect(isLikelyAnthropicApiKey("sk-ant-api03-abcdef")).toBe(true);
  });

  it("trims surrounding whitespace before checking", () => {
    expect(isLikelyAnthropicApiKey("  sk-ant-xyz  ")).toBe(true);
  });

  it("rejects a key without the prefix", () => {
    expect(isLikelyAnthropicApiKey("sk-abc123")).toBe(false);
    expect(isLikelyAnthropicApiKey("nope")).toBe(false);
    expect(isLikelyAnthropicApiKey("")).toBe(false);
  });

  it("rejects the bare prefix with nothing after it", () => {
    expect(isLikelyAnthropicApiKey(ANTHROPIC_API_KEY_PREFIX)).toBe(false);
  });
});

describe("maskedKeyDisplay", () => {
  it("shows bullets + last 4 chars", () => {
    expect(maskedKeyDisplay("wxyz")).toBe("••••wxyz");
  });

  it("uses only the trailing 4 chars when given more", () => {
    expect(maskedKeyDisplay("abcdwxyz")).toBe("••••wxyz");
  });

  it("never throws on undefined", () => {
    expect(maskedKeyDisplay(undefined)).toBe("••••");
  });
});

describe("llmStatusLabel", () => {
  it("reports not connected when unconfigured", () => {
    expect(llmStatusLabel({ configured: false })).toBe("Not connected");
  });

  it("reports the masked tail when configured", () => {
    expect(llmStatusLabel({ configured: true, kind: "api_key", last4: "1234" })).toBe(
      "Connected — key ending ••••1234",
    );
  });
});

describe("formatMcpConfig", () => {
  it("pretty-prints a JSON object", () => {
    expect(formatMcpConfig({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it("falls back to String() on non-serializable input", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(typeof formatMcpConfig(circular)).toBe("string");
  });
});

describe("normalizeRuntimeStatus", () => {
  it("passes through known statuses", () => {
    for (const s of ["none", "provisioning", "running", "stopped", "error"]) {
      expect(normalizeRuntimeStatus(s)).toBe(s);
    }
  });

  it("falls back to 'none' for unknown/garbage input", () => {
    expect(normalizeRuntimeStatus("bogus")).toBe("none");
    expect(normalizeRuntimeStatus(undefined)).toBe("none");
    expect(normalizeRuntimeStatus(42)).toBe("none");
  });
});

describe("runtimeStatusBadge", () => {
  it("maps each status to a sensible badge variant + label", () => {
    expect(runtimeStatusBadge("running")).toEqual({ variant: "success", label: "Running" });
    expect(runtimeStatusBadge("provisioning")).toEqual({ variant: "warning", label: "Provisioning" });
    expect(runtimeStatusBadge("stopped")).toEqual({ variant: "secondary", label: "Stopped" });
    expect(runtimeStatusBadge("error")).toEqual({ variant: "destructive", label: "Error" });
    expect(runtimeStatusBadge("none")).toEqual({ variant: "outline", label: "Not provisioned" });
  });
});

describe("canProvision", () => {
  it("is false without a configured Claude key", () => {
    expect(canProvision(false, "none")).toBe(false);
    expect(canProvision(false, "stopped")).toBe(false);
  });

  it("is true with a key when not already up/coming up", () => {
    expect(canProvision(true, "none")).toBe(true);
    expect(canProvision(true, "stopped")).toBe(true);
    expect(canProvision(true, "error")).toBe(true);
  });

  it("is false when already running or provisioning", () => {
    expect(canProvision(true, "running")).toBe(false);
    expect(canProvision(true, "provisioning")).toBe(false);
  });
});

describe("canStop", () => {
  it("allows stop only for running/provisioning", () => {
    expect(canStop("running")).toBe(true);
    expect(canStop("provisioning")).toBe(true);
    expect(canStop("none")).toBe(false);
    expect(canStop("stopped")).toBe(false);
    expect(canStop("error")).toBe(false);
  });
});

describe("isTransientRuntime", () => {
  it("treats provisioning as transient (poll-worthy)", () => {
    expect(isTransientRuntime("provisioning")).toBe(true);
    expect(isTransientRuntime("running")).toBe(false);
    expect(isTransientRuntime("none")).toBe(false);
  });
});

describe("parseRuntime", () => {
  it("coerces a full gateway object", () => {
    expect(
      parseRuntime({
        status: "running",
        container_id: "abc",
        host: "agent-1",
        last_seen_at: "2026-05-30T00:00:00Z",
        last_error: null,
      })
    ).toEqual({
      status: "running",
      container_id: "abc",
      host: "agent-1",
      last_seen_at: "2026-05-30T00:00:00Z",
      last_error: null,
    });
  });

  it("defaults to status 'none' and nulls on empty/garbage input", () => {
    expect(parseRuntime(undefined)).toEqual({
      status: "none",
      container_id: null,
      host: null,
      last_seen_at: null,
      last_error: null,
    });
    expect(parseRuntime({ status: "weird" }).status).toBe("none");
  });
});
