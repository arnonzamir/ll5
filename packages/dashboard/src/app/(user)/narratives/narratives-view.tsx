"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search, Sparkles, User as UserIcon, MapPin, Users, Tag, Lock } from "lucide-react";
import { fetchNarratives, type Narrative, type SubjectKind } from "./narratives-server-actions";

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

function subjectHref(n: Narrative): string {
  const params = new URLSearchParams({ kind: n.subject.kind, ref: n.subject.ref });
  return `/narratives/detail?${params.toString()}`;
}

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

interface NarrativesViewProps {
  initial: Narrative[];
}

export function NarrativesView({ initial }: NarrativesViewProps) {
  const [items, setItems] = useState<Narrative[]>(initial);
  const [status, setStatus] = useState<"active" | "dormant" | "closed" | "all">("active");
  const [kind, setKind] = useState<SubjectKind | "all">("all");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [pending, startTransition] = useTransition();

  // Debounce query
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  // Refetch on filter change
  useEffect(() => {
    startTransition(async () => {
      const next = await fetchNarratives({
        status: status === "all" ? undefined : status,
        subject_kind: kind === "all" ? undefined : kind,
        query: debounced || undefined,
        limit: 200,
      });
      setItems(next);
    });
  }, [status, kind, debounced]);

  const counts = useMemo(() => {
    const byStatus: Record<string, number> = { active: 0, dormant: 0, closed: 0 };
    const byKind: Record<string, number> = { person: 0, place: 0, group: 0, topic: 0 };
    for (const n of items) {
      byStatus[n.status] = (byStatus[n.status] ?? 0) + 1;
      byKind[n.subject.kind] = (byKind[n.subject.kind] ?? 0) + 1;
    }
    return { byStatus, byKind };
  }, [items]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search title, summary, threads…"
            className="pl-9"
          />
        </div>
        <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
          <SelectTrigger className="w-36">
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
          <SelectTrigger className="w-36">
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
      </div>

      <div className="text-xs text-gray-500 flex flex-wrap gap-3">
        <span>{items.length} narrative{items.length === 1 ? "" : "s"}</span>
        {pending && <span className="text-primary">Loading…</span>}
        <span>·</span>
        <span>active {counts.byStatus.active}</span>
        <span>dormant {counts.byStatus.dormant}</span>
        <span>closed {counts.byStatus.closed}</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {items.map((n) => {
          const Icon = KIND_ICON[n.subject.kind];
          return (
            <Link key={n.id} href={subjectHref(n)} className="block">
              <Card className="hover:shadow-md transition-shadow h-full">
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2 min-w-0">
                      <Icon className="h-4 w-4 text-gray-400 mt-0.5 shrink-0" />
                      <div className="min-w-0">
                        <div className="font-semibold truncate">{n.title}</div>
                        <div className="text-xs text-gray-500 truncate">
                          {n.subject.kind}:{n.subject.ref}
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <Badge variant={STATUS_VARIANT[n.status] ?? "default"}>{n.status}</Badge>
                      {n.sensitive && (
                        <Badge variant="outline" className="text-amber-700 border-amber-300">
                          <Lock className="h-3 w-3 mr-1" />
                          sensitive
                        </Badge>
                      )}
                    </div>
                  </div>
                  {n.summary && (
                    <p className="text-sm text-gray-700 line-clamp-3 whitespace-pre-line">
                      {n.summary}
                    </p>
                  )}
                  {!n.summary && n.observationCount > 0 && (
                    <p className="text-xs text-gray-400 italic">
                      No summary yet — {n.observationCount} observation{n.observationCount === 1 ? "" : "s"} accumulated. Ask the agent to consolidate.
                    </p>
                  )}
                  <div className="flex items-center justify-between text-xs text-gray-500 pt-1">
                    <span>{n.observationCount} obs · {relativeAge(n.lastObservedAt)}</span>
                    {n.currentMood && (
                      <span className="italic">{n.currentMood}</span>
                    )}
                  </div>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>

      {items.length === 0 && !pending && (
        <Card>
          <CardContent className="p-12 text-center text-gray-500">
            <Sparkles className="h-8 w-8 mx-auto mb-3 text-gray-300" />
            <p>No narratives match these filters yet.</p>
            <p className="text-xs mt-1">
              Narratives accumulate as the agent listens. Try the Active tab, or run /backfill-narratives in chat.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
