"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Search,
  Sparkles,
  User as UserIcon,
  MapPin,
  Users,
  Tag,
  Lock,
  ArrowUpDown,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  fetchNarratives,
  fetchNarrativeDetail,
  fetchNarrativeConnections,
  type Narrative,
  type Observation,
  type SubjectKind,
  type SubjectRef,
  type NarrativeConnections,
} from "./narratives-server-actions";
import { NarrativeDetailView } from "./detail/narrative-detail-view";

const KIND_ICON: Record<SubjectKind, React.ComponentType<{ className?: string }>> = {
  person: UserIcon,
  place: MapPin,
  group: Users,
  topic: Tag,
};

const STATUS_VARIANT: Record<string, "default" | "secondary" | "success" | "warning" | "outline"> = {
  active: "success",
  dormant: "secondary",
  closed: "outline",
};

function relativeAge(iso?: string): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 14) return `${days}d ago`;
  if (days < 60) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function sameSubject(a: SubjectRef, b: SubjectRef): boolean {
  return a.kind === b.kind && a.ref === b.ref;
}

interface DetailState {
  subject: SubjectRef;
  detail: { narrative: Narrative | null; observations: Observation[] };
  connections: NarrativeConnections | null;
}

interface NarrativesViewProps {
  initial: Narrative[];
}

export function NarrativesView({ initial }: NarrativesViewProps) {
  const [items, setItems] = useState<Narrative[]>(initial);
  const [status, setStatus] = useState<"active" | "dormant" | "closed" | "all">("active");
  const [kind, setKind] = useState<SubjectKind | "all">("all");
  const [sort, setSort] = useState<"relevance" | "recency">("relevance");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [pending, startTransition] = useTransition();

  // Master-detail selection.
  const [selected, setSelected] = useState<SubjectRef | null>(null);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [detailPending, startDetailTransition] = useTransition();

  // Debounce query
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  // Refetch list on filter/sort change
  useEffect(() => {
    startTransition(async () => {
      const next = await fetchNarratives({
        status: status === "all" ? undefined : status,
        subject_kind: kind === "all" ? undefined : kind,
        query: debounced || undefined,
        sort,
        limit: 200,
      });
      setItems(next);
    });
  }, [status, kind, sort, debounced]);

  // Load detail + connections when selection changes.
  function selectNarrative(subject: SubjectRef) {
    setSelected(subject);
    // Optimistically clear stale detail so the pane shows a loading affordance
    // only when we don't already have it.
    setDetail((prev) => (prev && sameSubject(prev.subject, subject) ? prev : null));
    startDetailTransition(async () => {
      const [d, c] = await Promise.all([
        fetchNarrativeDetail(subject, 200),
        fetchNarrativeConnections(subject),
      ]);
      setDetail({ subject, detail: d, connections: c });
    });
  }

  const counts = useMemo(() => {
    const byStatus: Record<string, number> = { active: 0, dormant: 0, closed: 0 };
    for (const n of items) {
      byStatus[n.status] = (byStatus[n.status] ?? 0) + 1;
    }
    return { byStatus };
  }, [items]);

  const detailReady = detail && selected && sameSubject(detail.subject, selected);

  return (
    <div className="flex flex-col lg:flex-row gap-4 lg:h-[calc(100vh-12rem)]">
      {/* LEFT RAIL — search + filters + list */}
      <div
        className={cn(
          "w-full lg:w-96 shrink-0 flex flex-col gap-3 lg:overflow-hidden",
          // On narrow screens, hide the list once a narrative is selected.
          selected ? "hidden lg:flex" : "flex",
        )}
      >
        <div className="space-y-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search title, summary, threads…"
              className="pl-9"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
              <SelectTrigger className="w-[7.5rem]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="dormant">Dormant</SelectItem>
                <SelectItem value="closed">Closed</SelectItem>
                <SelectItem value="all">All</SelectItem>
              </SelectContent>
            </Select>
            <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
              <SelectTrigger className="w-[7.5rem]">
                <SelectValue placeholder="Kind" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All kinds</SelectItem>
                <SelectItem value="person">People</SelectItem>
                <SelectItem value="place">Places</SelectItem>
                <SelectItem value="group">Groups</SelectItem>
                <SelectItem value="topic">Topics</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sort} onValueChange={(v) => setSort(v as typeof sort)}>
              <SelectTrigger className="w-[8.5rem]">
                <ArrowUpDown className="h-3.5 w-3.5 mr-1 text-gray-400" />
                <SelectValue placeholder="Sort" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="relevance">Relevance</SelectItem>
                <SelectItem value="recency">Recency</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="text-xs text-gray-500 flex flex-wrap gap-2 items-center">
            <span>{items.length} narrative{items.length === 1 ? "" : "s"}</span>
            {pending && (
              <span className="inline-flex items-center gap-1 text-primary">
                <Loader2 className="h-3 w-3 animate-spin" />
                loading
              </span>
            )}
            <span>·</span>
            <span>active {counts.byStatus.active}</span>
            <span>dormant {counts.byStatus.dormant}</span>
            <span>closed {counts.byStatus.closed}</span>
          </div>
        </div>

        <div className="flex flex-col gap-2 lg:overflow-y-auto lg:flex-1 pr-1">
          {items.map((n) => {
            const Icon = KIND_ICON[n.subject.kind];
            const isActive = selected && sameSubject(selected, n.subject);
            return (
              <button
                key={n.id}
                onClick={() => selectNarrative(n.subject)}
                className="block w-full text-left"
              >
                <Card
                  className={cn(
                    "transition-all hover:shadow-md",
                    isActive && "ring-2 ring-primary border-primary/40 shadow-md",
                  )}
                >
                  <CardContent className="p-3 space-y-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-2 min-w-0">
                        <Icon className="h-4 w-4 text-gray-400 mt-0.5 shrink-0" />
                        <div className="min-w-0">
                          <div className="font-semibold text-sm truncate">{n.title}</div>
                          <div className="text-xs text-gray-500 truncate">
                            {n.subject.kind}:{n.subject.ref}
                          </div>
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <Badge variant={STATUS_VARIANT[n.status] ?? "default"}>{n.status}</Badge>
                        {n.sensitive && (
                          <Badge variant="outline" className="text-amber-700 border-amber-300">
                            <Lock className="h-3 w-3" />
                          </Badge>
                        )}
                      </div>
                    </div>
                    {n.summary && (
                      <p className="text-xs text-gray-600 line-clamp-2 whitespace-pre-line">
                        {n.summary}
                      </p>
                    )}
                    {!n.summary && n.observationCount > 0 && (
                      <p className="text-xs text-gray-400 italic line-clamp-2">
                        No summary yet — {n.observationCount} observation
                        {n.observationCount === 1 ? "" : "s"}.
                      </p>
                    )}
                    <div className="flex items-center justify-between text-[11px] text-gray-500 pt-0.5">
                      <span>
                        {n.observationCount} obs · {relativeAge(n.lastObservedAt)}
                      </span>
                      {n.currentMood && <span className="italic truncate ml-2">{n.currentMood}</span>}
                    </div>
                  </CardContent>
                </Card>
              </button>
            );
          })}

          {items.length === 0 && !pending && (
            <Card>
              <CardContent className="p-8 text-center text-gray-500">
                <Sparkles className="h-7 w-7 mx-auto mb-3 text-gray-300" />
                <p className="text-sm">No narratives match these filters yet.</p>
                <p className="text-xs mt-1">
                  Narratives accumulate as the agent listens. Try the Active tab, or run
                  /backfill-narratives in chat.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* RIGHT PANE — detail */}
      <div
        className={cn(
          "flex-1 min-w-0 lg:overflow-y-auto",
          selected ? "block" : "hidden lg:block",
        )}
      >
        {!selected && (
          <Card className="h-full">
            <CardContent className="h-full min-h-72 flex flex-col items-center justify-center text-center text-gray-500 p-12">
              <Sparkles className="h-10 w-10 mb-3 text-gray-300" />
              <p className="font-medium">Select a narrative</p>
              <p className="text-sm mt-1 max-w-xs">
                Pick a thread on the left to see its summary, connection map, and development
                timeline.
              </p>
            </CardContent>
          </Card>
        )}

        {selected && !detailReady && (
          <Card>
            <CardContent className="p-12 flex items-center justify-center text-gray-500">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              Loading narrative…
            </CardContent>
          </Card>
        )}

        {selected && detailReady && (
          <NarrativeDetailView
            key={`${detail.subject.kind}:${detail.subject.ref}`}
            subject={detail.subject}
            initial={detail.detail}
            connections={detail.connections}
            variant="pane"
            onSelectRelated={selectNarrative}
            onBack={() => setSelected(null)}
          />
        )}

        {selected && detailPending && detailReady && (
          <div className="text-xs text-gray-400 mt-2 flex items-center gap-1 px-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            refreshing…
          </div>
        )}
      </div>
    </div>
  );
}
