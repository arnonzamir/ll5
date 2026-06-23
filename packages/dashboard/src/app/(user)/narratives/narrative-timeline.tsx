"use client";

import { useMemo } from "react";
import { Lock, GitCommitHorizontal, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Narrative, Observation } from "./narratives-server-actions";

const SOURCE_VARIANT: Record<string, "default" | "secondary" | "success" | "warning" | "outline"> = {
  whatsapp: "success",
  telegram: "default",
  chat: "default",
  system: "secondary",
  journal: "warning",
  inference: "outline",
  user_statement: "default",
};

const CONFIDENCE_DOT: Record<string, string> = {
  high: "bg-emerald-500",
  medium: "bg-amber-500",
  low: "bg-gray-400",
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type TimelineItem =
  | { kind: "observation"; at: string; obs: Observation }
  | { kind: "decision"; at: string; text: string };

interface NarrativeTimelineProps {
  narrative: Narrative | null;
  observations: Observation[];
}

export function NarrativeTimeline({ narrative, observations }: NarrativeTimelineProps) {
  // Merge observations + recent decisions into one chronological rail (newest
  // at the top). Decisions are agent-curated milestones; observations are raw
  // sightings — both belong on the development timeline.
  const items = useMemo<TimelineItem[]>(() => {
    const merged: TimelineItem[] = [];
    for (const o of observations) merged.push({ kind: "observation", at: o.observedAt, obs: o });
    for (const d of narrative?.recentDecisions ?? []) {
      merged.push({ kind: "decision", at: d.observedAt, text: d.text });
    }
    merged.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    return merged;
  }, [observations, narrative]);

  if (items.length === 0) {
    return <p className="text-sm text-gray-400 italic">No timeline yet — nothing observed.</p>;
  }

  return (
    <ol className="relative ml-2 border-l-2 border-gray-200 space-y-5 pl-5 py-1">
      {items.map((item, i) =>
        item.kind === "decision" ? (
          <li key={`d-${i}`} className="relative">
            <span className="absolute -left-[1.65rem] top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-white ring-4 ring-white">
              <GitCommitHorizontal className="h-3 w-3" />
            </span>
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <span>{formatTime(item.at)}</span>
              <Badge variant="default" className="text-[10px]">decision</Badge>
            </div>
            <div className="text-sm font-medium text-gray-800 mt-0.5">{item.text}</div>
          </li>
        ) : (
          <li key={item.obs.id} className="relative">
            <span
              className={cn(
                "absolute -left-[1.4rem] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-white",
                CONFIDENCE_DOT[item.obs.confidence] ?? "bg-gray-400",
              )}
              title={`${item.obs.confidence} confidence`}
            />
            <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
              <span>{formatTime(item.at)}</span>
              <Badge variant={SOURCE_VARIANT[item.obs.source] ?? "outline"} className="text-[10px]">
                {item.obs.source}
              </Badge>
              <span className="text-gray-400">· {item.obs.confidence}</span>
              {item.obs.mood && <span className="italic text-gray-500">· {item.obs.mood}</span>}
              {item.obs.sensitive && (
                <Badge variant="outline" className="text-amber-700 border-amber-300 text-[10px]">
                  <Lock className="h-3 w-3 mr-1" />
                  sensitive
                </Badge>
              )}
            </div>
            <div className="text-sm whitespace-pre-line mt-0.5">{item.obs.text}</div>
            {item.obs.sourceExcerpt && (
              <div className="text-xs text-gray-500 italic border-l-2 border-gray-100 pl-2 mt-1">
                &ldquo;{item.obs.sourceExcerpt}&rdquo;
              </div>
            )}
          </li>
        ),
      )}
      {narrative?.firstObservedAt && (
        <li className="relative">
          <span className="absolute -left-[1.4rem] top-1.5 h-2.5 w-2.5 rounded-full bg-gray-300 ring-4 ring-white" />
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <Sparkles className="h-3 w-3" />
            <span>First observed · {formatTime(narrative.firstObservedAt)}</span>
          </div>
        </li>
      )}
    </ol>
  );
}
