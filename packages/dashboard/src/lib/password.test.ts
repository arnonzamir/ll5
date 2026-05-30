import { describe, it, expect } from "vitest";
import { validateNewPassword, MIN_PASSWORD_LENGTH } from "./password";

describe("validateNewPassword", () => {
  it("accepts a valid matching password at the minimum length", () => {
    const pw = "a".repeat(MIN_PASSWORD_LENGTH);
    expect(validateNewPassword(pw, pw)).toBeNull();
  });

  it("accepts a valid matching password above the minimum length", () => {
    expect(validateNewPassword("correct-horse", "correct-horse")).toBeNull();
  });

  it("rejects an empty password", () => {
    expect(validateNewPassword("", "")).toMatch(/enter and confirm/i);
    expect(validateNewPassword("abcdefgh", "")).toMatch(/enter and confirm/i);
  });

  it("rejects a mismatched confirmation", () => {
    expect(validateNewPassword("abcdefgh", "abcdefgX")).toMatch(/do not match/i);
  });

  it("rejects a password shorter than the minimum length", () => {
    const short = "a".repeat(MIN_PASSWORD_LENGTH - 1);
    expect(validateNewPassword(short, short)).toMatch(/at least/i);
  });
});
