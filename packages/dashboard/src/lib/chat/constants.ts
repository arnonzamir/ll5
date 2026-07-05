import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock,
  Ellipsis,
  LayoutList,
  Send,
  ShieldAlert,
  ThumbsDown,
  ThumbsUp,
  Wrench,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { Message, Reaction } from "./types";

export const REACTION_ICONS: Record<Reaction, LucideIcon> = {
  acknowledge: Check,
  reject: X,
  agree: ThumbsUp,
  disagree: ThumbsDown,
  confused: CircleHelp,
  thinking: Ellipsis,
};

export const REACTION_LABELS: Record<Reaction, string> = {
  acknowledge: "Acknowledge",
  reject: "Reject",
  agree: "Agree",
  disagree: "Disagree",
  confused: "Confused",
  thinking: "Thinking",
};

/** Display order in the inline reaction strip — stable across surfaces.
 *  Order: positive vote, negative vote, ack, hard reject, confused, thinking. */
export const REACTION_ORDER: Reaction[] = [
  "agree",
  "disagree",
  "acknowledge",
  "reject",
  "confused",
  "thinking",
];

export const VALID_REACTIONS: Reaction[] = [...REACTION_ORDER];

/** What the USER can pick — one positive + one negative only. The old picker
 *  showed two of each (👍/✓ and 👎/✗), which overlapped and read as confusing.
 *  REACTION_ORDER/VALID_REACTIONS stay full so existing and agent-sent reactions
 *  still render and validate. */
export const PICKER_REACTIONS: Reaction[] = ["agree", "disagree"];

/** Compact-row grouping window. Consecutive `display_compact=true` messages
 *  within this distance collapse under a single "N system events" band. */
export const COMPACT_GROUP_WINDOW_MS = 60_000;

/** Pick a leading glyph for a compact system row based on content heuristics.
 *  Deterministic — same content always maps to the same icon. */
export function compactIcon(m: Message): LucideIcon {
  const c = (m.content ?? "").toLowerCase();
  // Agent activity markers (live tool-action rows from the PostToolUse hook).
  if (m.metadata?.kind === "activity") {
    if (c.startsWith("whatsapp →") || c.startsWith("telegram →")) return Send;
    return Zap;
  }
  if (c.includes("[scheduler]") || c.includes("heartbeat") || c.includes("briefing")) return Clock;
  if (c.includes("alert") || c.includes("unhealthy") || c.includes("failed")) return ShieldAlert;
  if (c.includes("[tool") || c.includes("tool result")) return Wrench;
  if (c.includes("[conversation")) return Ellipsis;
  return LayoutList;
}

export { ChevronDown, ChevronRight };
