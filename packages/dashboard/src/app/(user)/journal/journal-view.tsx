"use client";

import { useState, useTransition, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RefreshCw, Search, Check } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  fetchJournalEntries,
  fetchUserModel,
  resolveEntry,
  type JournalEntry,
  type JournalFilters,
  type UserModelSection,
} from "./journal-server-actions";

const TYPE_COLORS: Record<string, string> = {
  feedback: "bg-red-50 text-red-700 border-red-200",
  observation: "bg-blue-50 text-blue-700 border-blue-200",
  decision: "bg-green-50 text-green-700 border-green-200",
  context: "bg-yellow-50 text-yellow-700 border-yellow-200",
  thought: "bg-purple-50 text-purple-700 border-purple-200",
  commitment: "bg-orange-50 text-orange-700 border-orange-200",
};

const ENTRY_TYPES = [
  "all",
  "observation",
  "feedback",
  "decision",
  "context",
  "thought",
  "commitment",
] as const;

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffSec = Math.floor((now - then) / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function EntryRow({
  entry,
  onResolved,
}: {
  entry: JournalEntry;
  onResolved: () => void;
}) {
  const [resolving, startResolve] = useTransition();

  function handleResolve() {
    startResolve(async () => {
      await resolveEntry(entry.id);
      onResolved();
    });
  }

  const typeColor =
    TYPE_COLORS[entry.type] ?? "bg-gray-50 text-gray-700 border-gray-200";

  return (
    <div className="border-b border-gray-100 last:border-0 px-4 py-3 hover:bg-gray-50/50">
      <div className="flex items-start gap-3">
        <div className="flex flex-col items-start gap-1.5 shrink-0 pt-0.5">
          <Badge className={`text-[11px] px-2 py-0.5 font-medium border ${typeColor}`}>
            {entry.type}
          </Badge>
          {entry.signal && (
            <Badge
              variant="outline"
              className="text-[10px] px-1.5 py-0 font-normal"
            >
              {entry.signal}
            </Badge>
          )}
        </div>

        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-900">
              {entry.topic}
            </span>
            <span className="text-[11px] text-gray-400">
              {relativeTime(entry.created_at)}
            </span>
          </div>
          <p className="text-sm text-gray-600 whitespace-pre-wrap">
            {entry.content}
          </p>
        </div>

        <div className="shrink-0 pt-0.5">
          {entry.status === "open" ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleResolve}
              disabled={resolving}
              className="text-xs text-gray-500 hover:text-green-700 h-7"
            >
              <Check className="h-3.5 w-3.5 mr-1" />
              Resolve
            </Button>
          ) : (
            <Badge
              variant="outline"
              className="text-[10px] text-gray-400 border-gray-200"
            >
              {entry.status}
            </Badge>
          )}
        </div>
      </div>
    </div>
  );
}

function UserModelView({ sections, isPending }: { sections: UserModelSection[]; isPending: boolean }) {
  if (isPending) {
    return <p className="p-6 text-sm text-gray-400 text-center">Loading...</p>;
  }

  if (sections.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-8 text-center">
        <p className="text-sm text-gray-500">
          No user model built yet. The agent builds this through the /consolidate skill.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      {sections.map((section) => (
        <Card key={section.id}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              {section.section
                .split("_")
                .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                .join(" ")}
            </CardTitle>
            <CardDescription className="text-xs">
              Last updated: {new Date(section.last_updated).toLocaleString()}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {typeof section.content === "object" && section.content !== null ? (
              <dl className="grid gap-2">
                {Object.entries(section.content).map(([key, value]) => (
                  <div key={key}>
                    <dt className="text-xs font-medium text-gray-500">
                      {key.replace(/_/g, " ")}
                    </dt>
                    <dd className="text-sm text-gray-800 whitespace-pre-wrap">
                      {typeof value === "string"
                        ? value
                        : JSON.stringify(value, null, 2)}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <pre className="text-sm text-gray-700 whitespace-pre-wrap">
                {JSON.stringify(section.content, null, 2)}
              </pre>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

type TabId = "journal" | "user-model";

export function JournalView() {
  const [activeTab, setActiveTab] = useState<TabId>("journal");
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [userModelSections, setUserModelSections] = useState<UserModelSection[]>([]);
  const [isPending, startTransition] = useTransition();

  // Filters
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("open");
  const [topicSearch, setTopicSearch] = useState("");

  const load = useCallback(() => {
    startTransition(async () => {
      const filters: JournalFilters = { limit: 100 };
      if (typeFilter !== "all") filters.type = typeFilter;
      if (statusFilter !== "all") filters.status = statusFilter;
      if (topicSearch) filters.topic = topicSearch;

      const [journalResult, modelSections] = await Promise.all([
        fetchJournalEntries(filters),
        fetchUserModel(),
      ]);
      setEntries(journalResult.entries);
      setTotal(journalResult.total);
      setUserModelSections(modelSections);
    });
  }, [typeFilter, statusFilter, topicSearch]);

  useEffect(() => {
    load();
  }, [load]);

  // Compute type breakdown for stats
  const typeCounts: Record<string, number> = {};
  for (const e of entries) {
    typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1;
  }

  const tabs: { id: TabId; label: string }[] = [
    { id: "journal", label: "Journal Entries" },
    { id: "user-model", label: "User Model" },
  ];

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">Agent Journal</h1>
          <p className="text-sm text-gray-500 mt-1">Observations, decisions, and learning from agent sessions</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={load}
          disabled={isPending}
          aria-label="Refresh"
        >
          <RefreshCw
            className={`h-4 w-4 ${isPending ? "animate-spin" : ""}`}
          />
        </Button>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-gray-200 mb-4">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.id
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
            }`}
          >
            {tab.label}
            {tab.id === "user-model" && userModelSections.length > 0 && (
              <span className="ml-1.5 text-xs text-gray-400">
                ({userModelSections.length})
              </span>
            )}
          </button>
        ))}
      </div>

      {activeTab === "journal" && (
        <>
          {/* Stats bar */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <span className="text-sm text-gray-500">
              {total} {total === 1 ? "entry" : "entries"}
            </span>
            {Object.entries(typeCounts).map(([t, count]) => {
              const color =
                TYPE_COLORS[t] ?? "bg-gray-50 text-gray-700 border-gray-200";
              return (
                <Badge
                  key={t}
                  className={`text-[11px] px-2 py-0.5 font-medium border ${color}`}
                >
                  {t}: {count}
                </Badge>
              );
            })}
          </div>

          {/* Filters */}
          <div className="flex flex-wrap items-end gap-3 mb-4">
            <div className="space-y-1">
              <span className="text-xs text-gray-500">Type</span>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ENTRY_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t === "all" ? "All Types" : t.charAt(0).toUpperCase() + t.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <span className="text-xs text-gray-500">Status</span>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="resolved">Resolved</SelectItem>
                  <SelectItem value="all">All</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex-1 min-w-[200px] space-y-1">
              <span className="text-xs text-gray-500">Topic</span>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
                <Input
                  value={topicSearch}
                  onChange={(e) => setTopicSearch(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && load()}
                  placeholder="Search topics..."
                  className="pl-8 h-9"
                />
              </div>
            </div>
          </div>

          {/* Results count */}
          <div className="text-xs text-gray-400 mb-2">
            {isPending
              ? "Loading..."
              : `${entries.length} of ${total} entries`}
          </div>

          {/* Entry list */}
          <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
            {entries.length === 0 ? (
              <p className="p-6 text-sm text-gray-400 text-center">
                {isPending ? "Loading..." : "No journal entries found"}
              </p>
            ) : (
              entries.map((entry) => (
                <EntryRow key={entry.id} entry={entry} onResolved={load} />
              ))
            )}
          </div>
        </>
      )}

      {activeTab === "user-model" && (
        <UserModelView sections={userModelSections} isPending={isPending} />
      )}
    </div>
  );
}
