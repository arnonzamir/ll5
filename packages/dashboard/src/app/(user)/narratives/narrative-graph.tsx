"use client";

import { useMemo } from "react";
import { User as UserIcon, MapPin } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  NarrativeConnections,
  RelatedNarrative,
  EntityNode,
  ConnectionVia,
  SubjectRef,
} from "./narratives-server-actions";

// ---------------------------------------------------------------------------
// Visual language
// ---------------------------------------------------------------------------
// Entities (participants / places) share one neutral edge style. Related
// narratives are colored + dashed by their *dominant* `via` so the eye can
// read "why are these connected" at a glance (and the legend names it).

const VIA_STYLE: Record<ConnectionVia, { label: string; stroke: string; dash?: string }> = {
  "shared-participant": { label: "shared person", stroke: "#6366f1" /* indigo-500 */ },
  "shared-place": { label: "shared place", stroke: "#0d9488" /* teal-600 */, dash: "5 4" },
  "co-subject": { label: "co-subject", stroke: "#d97706" /* amber-600 */, dash: "2 4" },
};

const ENTITY_STROKE = "#cbd5e1"; // slate-300 — quiet, structural

/** The dominant relationship reason drives a related node's color/dash. */
function dominantVia(r: RelatedNarrative): ConnectionVia {
  return r.via[0] ?? "co-subject";
}

function truncate(s: string, n = 16): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

interface PlacedNode {
  x: number;
  y: number;
  angle: number;
}

interface NarrativeGraphProps {
  /** The center subject (selected narrative). */
  subject: SubjectRef;
  /** Center label — the narrative title. */
  title: string;
  connections: NarrativeConnections | null;
  /** Click a related-narrative node → select it in the parent. */
  onSelectRelated?: (subject: SubjectRef) => void;
}

export function NarrativeGraph({ subject, title, connections, onSelectRelated }: NarrativeGraphProps) {
  const entities = connections?.entities ?? [];
  const related = connections?.related ?? [];

  // Geometry. Fixed viewBox; nodes laid on a circle around the center. We start
  // related narratives at the top and walk clockwise, then entities, so each
  // category clusters but everything still spreads evenly.
  const W = 520;
  const H = 320;
  const cx = W / 2;
  const cy = H / 2;
  const radius = Math.min(W, H) / 2 - 56;

  const { relatedPlaced, entityPlaced, vias } = useMemo(() => {
    const total = related.length + entities.length;
    const placed = (i: number): PlacedNode => {
      // -90deg start (top), clockwise. Guard against a single-node div-by-zero.
      const step = total > 0 ? (2 * Math.PI) / total : 0;
      const angle = -Math.PI / 2 + step * i;
      return {
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
        angle,
      };
    };
    const rel = related.map((r, i) => ({ r, pos: placed(i) }));
    const ent = entities.map((e, i) => ({ e, pos: placed(related.length + i) }));
    // Which via styles are actually present → drive the legend.
    const present = new Set<ConnectionVia>();
    for (const r of related) present.add(dominantVia(r));
    return { relatedPlaced: rel, entityPlaced: ent, vias: present };
  }, [related, entities, cx, cy, radius]);

  const isEmpty = entities.length === 0 && related.length === 0;

  return (
    <div className="space-y-2">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ height: 300 }}
        role="img"
        aria-label={`Connection map for ${title}`}
      >
        {/* Edges first so nodes paint on top. */}
        {entityPlaced.map(({ pos }, i) => (
          <line
            key={`ee-${i}`}
            x1={cx}
            y1={cy}
            x2={pos.x}
            y2={pos.y}
            stroke={ENTITY_STROKE}
            strokeWidth={1.5}
          />
        ))}
        {relatedPlaced.map(({ r, pos }, i) => {
          const style = VIA_STYLE[dominantVia(r)];
          return (
            <line
              key={`re-${i}`}
              x1={cx}
              y1={cy}
              x2={pos.x}
              y2={pos.y}
              stroke={style.stroke}
              strokeWidth={Math.max(1.5, Math.min(4, 1 + r.weight))}
              strokeDasharray={style.dash}
              opacity={0.8}
            />
          );
        })}

        {/* Entity nodes (participants / places). */}
        {entityPlaced.map(({ e, pos }, i) => (
          <EntitySvgNode key={`en-${i}`} node={e} x={pos.x} y={pos.y} side={pos.x < cx ? "left" : "right"} />
        ))}

        {/* Related-narrative nodes — clickable. */}
        {relatedPlaced.map(({ r, pos }, i) => (
          <RelatedSvgNode
            key={`rn-${i}`}
            related={r}
            x={pos.x}
            y={pos.y}
            side={pos.x < cx ? "left" : "right"}
            onClick={() => onSelectRelated?.(r.subject)}
          />
        ))}

        {/* Center node — the selected narrative. */}
        <g>
          <circle cx={cx} cy={cy} r={30} className="fill-primary" />
          <circle cx={cx} cy={cy} r={30} fill="none" stroke="#ffffff" strokeWidth={2} />
          <text
            x={cx}
            y={cy + 4}
            textAnchor="middle"
            className="fill-white"
            fontSize={11}
            fontWeight={600}
          >
            {truncate(title, 12)}
          </text>
        </g>

        {isEmpty && (
          <text x={cx} y={cy + 56} textAnchor="middle" className="fill-gray-400" fontSize={11}>
            No connections discovered yet
          </text>
        )}
      </svg>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-500 px-1">
        {(entities.length > 0) && (
          <LegendItem stroke={ENTITY_STROKE} label="participant / place" />
        )}
        {(["shared-participant", "shared-place", "co-subject"] as ConnectionVia[])
          .filter((v) => vias.has(v))
          .map((v) => (
            <LegendItem key={v} stroke={VIA_STYLE[v].stroke} dash={VIA_STYLE[v].dash} label={VIA_STYLE[v].label} />
          ))}
      </div>
    </div>
  );
}

function LegendItem({ stroke, dash, label }: { stroke: string; dash?: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width={20} height={6} aria-hidden>
        <line x1={0} y1={3} x2={20} y2={3} stroke={stroke} strokeWidth={2} strokeDasharray={dash} />
      </svg>
      <span>{label}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// SVG node primitives — pill with label + tiny icon glyph
// ---------------------------------------------------------------------------

const STATUS_FILL: Record<string, string> = {
  active: "#ffffff",
  dormant: "#f8fafc",
  closed: "#f1f5f9",
};

function EntitySvgNode({
  node,
  x,
  y,
  side,
}: {
  node: EntityNode;
  x: number;
  y: number;
  side: "left" | "right";
}) {
  const label = truncate(node.name || node.ref, 14);
  const Icon = node.kind === "person" ? UserIcon : MapPin;
  return (
    <g>
      <circle cx={x} cy={y} r={5} fill="#e2e8f0" stroke="#94a3b8" strokeWidth={1} />
      <foreignObject x={x - 8} y={y - 8} width={16} height={16}>
        <div className="flex items-center justify-center w-4 h-4 text-slate-500">
          <Icon className="w-3 h-3" />
        </div>
      </foreignObject>
      <text
        x={side === "left" ? x - 10 : x + 10}
        y={y + 3}
        textAnchor={side === "left" ? "end" : "start"}
        className="fill-gray-600"
        fontSize={10}
      >
        {label}
      </text>
    </g>
  );
}

function RelatedSvgNode({
  related,
  x,
  y,
  side,
  onClick,
}: {
  related: RelatedNarrative;
  x: number;
  y: number;
  side: "left" | "right";
  onClick: () => void;
}) {
  const style = VIA_STYLE[dominantVia(related)];
  const label = truncate(related.title, 16);
  return (
    <g
      className="cursor-pointer"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <title>{`${related.title} — ${related.via.join(", ")}`}</title>
      <circle
        cx={x}
        cy={y}
        r={8}
        fill={STATUS_FILL[related.status] ?? "#ffffff"}
        stroke={style.stroke}
        strokeWidth={2}
      />
      <text
        x={side === "left" ? x - 12 : x + 12}
        y={y + 3}
        textAnchor={side === "left" ? "end" : "start"}
        className={cn("fill-gray-800", related.status === "closed" && "fill-gray-400")}
        fontSize={10}
        fontWeight={500}
      >
        {label}
      </text>
    </g>
  );
}
