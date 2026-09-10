import { describe, expect, it } from "vitest";
import { buildRenderItems, isRailRow, uploadsUrl } from "./format";
import type { Message } from "./types";

function row(partial: Partial<Message> & { id: string }): Message {
  return {
    role: "assistant",
    content: "text",
    created_at: "2026-09-07T08:00:00.000Z",
    ...partial,
  };
}

describe("isRailRow (DECISION-034 Phase 2)", () => {
  it("is true only for non-user rows with metadata.rail === true", () => {
    expect(isRailRow(row({ id: "a", metadata: { rail: true } }))).toBe(true);
    expect(isRailRow(row({ id: "b", role: "system", metadata: { rail: true, kind: "thinking" } }))).toBe(true);
    expect(isRailRow(row({ id: "c", metadata: { kind: "thinking" } }))).toBe(false);
    expect(isRailRow(row({ id: "d", metadata: { rail: "true" as unknown as boolean } }))).toBe(false);
    expect(isRailRow(row({ id: "e" }))).toBe(false);
  });

  it("never hides a user row", () => {
    expect(isRailRow(row({ id: "u", role: "user", metadata: { rail: true } }))).toBe(false);
  });
});

describe("buildRenderItems", () => {
  it("drops rail rows from the thread and keeps everything else", () => {
    const items = buildRenderItems(
      [
        row({ id: "1", role: "user", content: "hi" }),
        row({ id: "2", metadata: { rail: true, kind: "thinking", trigger_id: "t1" }, content: "checking the calendar" }),
        row({ id: "3", metadata: { rail: true, kind: "tool-call" }, content: "[tool] list_events", display_compact: true }),
        row({ id: "4", content: "Card pickup: the parcel shop closes at 19:00." }),
        row({ id: "5", metadata: { kind: "thinking" }, content: "user-turn narration stays" }),
      ],
      new Set(),
    );
    expect(items.map((i) => (i.kind === "compact" ? "compact" : i.message.id))).toEqual(["1", "4", "5"]);
  });
});

describe("uploadsUrl", () => {
  it("proxies an auth-gated upload", () => {
    expect(uploadsUrl("/uploads/a.png")).toBe("/api/uploads/a.png");
  });

  it("proxies a public file without collapsing it onto the uploads path", () => {
    expect(uploadsUrl("/public/a.png")).toBe("/api/uploads/public/a.png");
  });

  it("leaves an absolute url alone", () => {
    expect(uploadsUrl("https://cdn.example/a.png")).toBe("https://cdn.example/a.png");
  });
});
