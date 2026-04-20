import type { Message } from "./types";
import { COMPACT_GROUP_WINDOW_MS } from "./constants";

/** Build the proxy URL the dashboard uses for gateway-hosted uploads. */
export function uploadsUrl(url: string): string {
  return `/api/uploads${url.replace("/uploads", "")}`;
}

/** Are two messages close enough in time to visually group? */
export function closeInTime(
  a: Message,
  b: Message,
  windowMs = COMPACT_GROUP_WINDOW_MS,
): boolean {
  const ta = new Date(a.created_at).getTime();
  const tb = new Date(b.created_at).getTime();
  return Math.abs(tb - ta) <= windowMs;
}

/** Short time label. Same-day → HH:MM, else Mon DD. */
export function shortTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Ellipsis-truncate helper — single source so UI surfaces match. */
export function truncate(s: string | null | undefined, n = 80): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** Render items for a message list: either a real bubble or a folded
 *  compact-group (consecutive display_compact rows within 60s). Reaction
 *  rows are filtered out here — the caller attaches them under their
 *  parent. */
export type RenderItem =
  | { kind: "bubble"; message: Message }
  | { kind: "compact"; items: Message[] };

export function buildRenderItems(
  messages: Message[],
  reactionIds: Set<string>,
): RenderItem[] {
  const out: RenderItem[] = [];
  for (const m of messages) {
    if (reactionIds.has(m.id)) continue;
    if (m.display_compact) {
      const last = out[out.length - 1];
      if (last && last.kind === "compact" && closeInTime(last.items[last.items.length - 1], m)) {
        last.items.push(m);
        continue;
      }
      out.push({ kind: "compact", items: [m] });
      continue;
    }
    out.push({ kind: "bubble", message: m });
  }
  return out;
}

/** Bucket reactions by target message id + build an id-set of reaction rows
 *  so the main list can skip them. */
export function indexReactions(messages: Message[]): {
  byTarget: Map<string, Message[]>;
  reactionIds: Set<string>;
} {
  const byTarget = new Map<string, Message[]>();
  const reactionIds = new Set<string>();
  for (const m of messages) {
    if (m.reaction && m.reply_to_id) {
      reactionIds.add(m.id);
      const arr = byTarget.get(m.reply_to_id) ?? [];
      arr.push(m);
      byTarget.set(m.reply_to_id, arr);
    }
  }
  return { byTarget, reactionIds };
}
