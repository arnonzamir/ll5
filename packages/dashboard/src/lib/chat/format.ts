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
  | { kind: "compact"; items: Message[] }
  // Agent internal-voice (narrate). Stands alone — never folded into a tool-call group.
  | { kind: "thinking"; message: Message };

/** Instrumentation traffic that should fold like display_compact rows even when
 *  the backend didn't flag it: bracket-tagged tool rows (`[tool…] …`) and bare
 *  rows whose head is a known instrumentation tool (record_moment, ToolSearch).
 *  These otherwise render as standalone assistant bubbles — chat clutter. */
const INSTRUMENTATION_TOOL_NAMES = ["record_moment", "toolsearch", "tool_search"];

export function isInstrumentationRow(m: Message): boolean {
  if (m.role === "user") return false;
  if (m.metadata?.kind === "thinking") return false;
  const c = (m.content ?? "").trim();
  if (c === "") return false;
  if (c.startsWith("[")) {
    const tag = c.slice(1, c.indexOf("]") === -1 ? undefined : c.indexOf("]")).toLowerCase();
    return tag.startsWith("tool") || INSTRUMENTATION_TOOL_NAMES.some((n) => tag.includes(n));
  }
  const head = c.slice(0, 40).toLowerCase();
  return INSTRUMENTATION_TOOL_NAMES.some((n) => head.startsWith(n));
}

export function buildRenderItems(
  messages: Message[],
  reactionIds: Set<string>,
): RenderItem[] {
  const out: RenderItem[] = [];
  for (const m of messages) {
    if (reactionIds.has(m.id)) continue;
    // Defense in depth — skip content-less non-reaction rows. The DB
    // constraint `(reaction IS NULL) <> (content IS NULL)` guarantees this
    // never happens for persisted rows, but client-state can accumulate
    // phantoms from stray SSE events (status_update without a parent in
    // store, etc.). Without this guard they render as empty unboxed-
    // assistant bubbles — visible as a sparkle with no text.
    if (!m.reaction && (m.content == null || m.content.trim() === "")) continue;
    // narrate / internal voice renders standalone — emitting it here also ends any
    // open compact group, so it visibly cuts the folded tool-call block.
    if (m.metadata?.kind === "thinking") {
      out.push({ kind: "thinking", message: m });
      continue;
    }
    if (m.display_compact || isInstrumentationRow(m)) {
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
