import { describe, it, expect } from "vitest";
import {
  ANTHROPIC_API_KEY_PREFIX,
  isLikelyAnthropicApiKey,
  maskedKeyDisplay,
  llmStatusLabel,
  formatMcpConfig,
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
