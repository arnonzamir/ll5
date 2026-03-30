"use client";

import { useState, useTransition, useEffect, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Bell,
  BellOff,
  Trash2,
  Plus,
  RefreshCw,
  Zap,
  Clock,
  Search,
} from "lucide-react";
import {
  fetchRules,
  createRule,
  deleteRule,
  fetchKnownSenders,
  type NotificationRule,
  type KnownSender,
} from "./notification-settings-server-actions";

// --- Helpers ---

const APP_COLORS: Record<string, { bg: string; text: string }> = {
  whatsapp: { bg: "bg-green-100", text: "text-green-800" },
  telegram: { bg: "bg-blue-100", text: "text-blue-800" },
  signal: { bg: "bg-gray-100", text: "text-gray-700" },
  sms: { bg: "bg-orange-100", text: "text-orange-800" },
  android: { bg: "bg-lime-100", text: "text-lime-800" },
};

function AppBadge({ app }: { app: string }) {
  const colors = APP_COLORS[app.toLowerCase()] ?? {
    bg: "bg-gray-100",
    text: "text-gray-700",
  };
  return (
    <Badge
      className={`${colors.bg} ${colors.text} border-transparent text-[10px] px-1.5 py-0`}
    >
      {app}
    </Badge>
  );
}

function formatLastSeen(ts: string): string {
  try {
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffHours < 1) return "just now";
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

const SUGGESTED_KEYWORDS = [
  "urgent",
  "emergency",
  "ASAP",
  "call me",
  "important",
  "help",
];

// --- People Section ---

function PeopleSection({
  senders,
  rules,
  onSetPriority,
  onClearRule,
  isPending,
}: {
  senders: KnownSender[];
  rules: NotificationRule[];
  onSetPriority: (sender: string, priority: "immediate" | "batch" | "ignore") => void;
  onClearRule: (ruleId: string) => void;
  isPending: boolean;
}) {
  const [searchQuery, setSearchQuery] = useState("");

  // Find the rule for a given sender
  function findSenderRule(
    senderName: string
  ): NotificationRule | undefined {
    return rules.find(
      (r) => r.rule_type === "sender" && r.match_value === senderName
    );
  }

  const filteredSenders = searchQuery
    ? senders.filter(
        (s) =>
          s.sender.toLowerCase().includes(searchQuery.toLowerCase()) ||
          s.app.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : senders;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Bell className="h-4 w-4" />
          People
        </CardTitle>
        <CardDescription>
          Set notification priority per sender. Senders without a rule use the
          default batch review.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {senders.length > 10 && (
          <div className="relative mb-4">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input
              placeholder="Filter senders..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
        )}

        {filteredSenders.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-gray-400">
            <BellOff className="h-8 w-8 mb-2" />
            <p className="text-sm">
              {senders.length === 0
                ? "No message senders found yet."
                : "No senders match your search."}
            </p>
          </div>
        ) : (
          (() => {
            const groups: Record<string, typeof filteredSenders> = {};
            for (const s of filteredSenders) {
              const cat = s.category ?? "other";
              if (!groups[cat]) groups[cat] = [];
              groups[cat].push(s);
            }
            const categoryLabels: Record<string, string> = {
              family: "Family",
              friends: "Friends",
              work: "Work",
              other: "Other",
            };
            const categoryOrder = ["family", "friends", "work", "other"];

            return (
              <div className="space-y-4">
                {categoryOrder.map((cat) => {
                  const group = groups[cat];
                  if (!group || group.length === 0) return null;
                  return (
                    <div key={cat}>
                      <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1 px-1">
                        {categoryLabels[cat]} ({group.length})
                      </div>
                      <div className="divide-y divide-gray-100">
                        {group.map((sender) => {
                          const rule = findSenderRule(sender.sender);
                          return (
                            <SenderRow
                              key={`${sender.sender}-${sender.app}`}
                              sender={sender}
                              rule={rule}
                              onSetPriority={onSetPriority}
                              onClearRule={onClearRule}
                              isPending={isPending}
                            />
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()
        )}
      </CardContent>
    </Card>
  );
}

function SenderRow({
  sender,
  rule,
  onSetPriority,
  onClearRule,
  isPending,
}: {
  sender: KnownSender;
  rule: NotificationRule | undefined;
  onSetPriority: (sender: string, priority: "immediate" | "batch" | "ignore") => void;
  onClearRule: (ruleId: string) => void;
  isPending: boolean;
}) {
  const priorities = ["ignore", "batch", "immediate"] as const;
  const priorityConfig = {
    ignore: { label: "Ignore", activeClass: "bg-red-50 text-red-600" },
    batch: { label: "Batch", activeClass: "bg-gray-100 text-gray-700" },
    immediate: { label: "Immediate", activeClass: "bg-amber-100 text-amber-800" },
  };

  // Default highlight: batch (when no rule exists)
  const activePriority = rule?.priority ?? "batch";

  return (
    <div className="flex items-center gap-3 py-2.5">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{sender.sender}</span>
          <AppBadge app={sender.app} />
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-gray-400">
            {sender.messageCount} messages
          </span>
          <span className="text-xs text-gray-300">·</span>
          <span className="text-xs text-gray-400">
            {formatLastSeen(sender.lastSeen)}
          </span>
        </div>
      </div>

      <div className="flex items-center rounded-md border border-gray-200 p-0.5 shrink-0">
        {priorities.map((p) => {
          const config = priorityConfig[p];
          const isActive = activePriority === p;
          return (
            <button
              key={p}
              onClick={() => {
                if (p === "batch" && !rule) return; // already default
                onSetPriority(sender.sender, p);
              }}
              disabled={isPending}
              className={`px-2 py-0.5 text-[11px] font-medium rounded transition-colors cursor-pointer ${
                isActive
                  ? config.activeClass
                  : "text-gray-400 hover:text-gray-600"
              }`}
            >
              {config.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// --- Keywords Section ---

function KeywordsSection({
  rules,
  onAddKeyword,
  onDeleteRule,
  isPending,
}: {
  rules: NotificationRule[];
  onAddKeyword: (keyword: string, priority: "immediate" | "batch") => void;
  onDeleteRule: (ruleId: string) => void;
  isPending: boolean;
}) {
  const [newKeyword, setNewKeyword] = useState("");
  const [newPriority, setNewPriority] = useState<"immediate" | "batch">(
    "immediate"
  );

  const keywordRules = rules.filter((r) => r.rule_type === "keyword");
  const existingKeywords = new Set(keywordRules.map((r) => r.match_value.toLowerCase()));
  const availableSuggestions = SUGGESTED_KEYWORDS.filter(
    (k) => !existingKeywords.has(k.toLowerCase())
  );

  function handleAdd() {
    const trimmed = newKeyword.trim();
    if (!trimmed) return;
    onAddKeyword(trimmed, newPriority);
    setNewKeyword("");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAdd();
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Zap className="h-4 w-4" />
          Keywords
        </CardTitle>
        <CardDescription>
          Create rules that trigger when a message contains specific keywords.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Existing keyword rules */}
        {keywordRules.length > 0 && (
          <div className="space-y-1">
            {keywordRules.map((rule) => (
              <div
                key={rule.id}
                className="flex items-center justify-between gap-2 py-1.5 border-b border-gray-50 last:border-0"
              >
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="font-mono text-xs">
                    {rule.match_value}
                  </Badge>
                  <Badge
                    className={
                      rule.priority === "immediate"
                        ? "bg-amber-100 text-amber-800 border-transparent text-[10px] px-1.5 py-0"
                        : "bg-gray-100 text-gray-700 border-transparent text-[10px] px-1.5 py-0"
                    }
                  >
                    {rule.priority}
                  </Badge>
                </div>
                <button
                  onClick={() => onDeleteRule(rule.id)}
                  disabled={isPending}
                  className="p-1 text-gray-300 hover:text-red-500 transition-colors cursor-pointer"
                  aria-label={`Delete keyword rule: ${rule.match_value}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Suggested keywords */}
        {availableSuggestions.length > 0 && (
          <div>
            <p className="text-xs text-gray-400 mb-2">Suggested keywords</p>
            <div className="flex flex-wrap gap-1.5">
              {availableSuggestions.map((keyword) => (
                <button
                  key={keyword}
                  onClick={() => onAddKeyword(keyword, "immediate")}
                  disabled={isPending}
                  className="text-xs px-2 py-1 rounded-md border border-dashed border-gray-300 text-gray-500 hover:border-primary hover:text-primary hover:bg-primary/5 transition-colors cursor-pointer"
                >
                  <Plus className="h-3 w-3 inline mr-0.5" />
                  {keyword}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Add custom keyword */}
        <div className="flex items-center gap-2 pt-2 border-t border-gray-100">
          <Input
            placeholder="Add keyword..."
            value={newKeyword}
            onChange={(e) => setNewKeyword(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1"
          />
          <div className="flex items-center rounded-md border border-gray-200 p-0.5 shrink-0">
            <button
              onClick={() => setNewPriority("batch")}
              className={`px-2 py-0.5 text-[11px] font-medium rounded transition-colors cursor-pointer ${
                newPriority === "batch"
                  ? "bg-gray-100 text-gray-700"
                  : "text-gray-400 hover:text-gray-600"
              }`}
            >
              Batch
            </button>
            <button
              onClick={() => setNewPriority("immediate")}
              className={`px-2 py-0.5 text-[11px] font-medium rounded transition-colors cursor-pointer ${
                newPriority === "immediate"
                  ? "bg-amber-100 text-amber-800"
                  : "text-gray-400 hover:text-gray-600"
              }`}
            >
              Immediate
            </button>
          </div>
          <Button
            onClick={handleAdd}
            disabled={isPending || !newKeyword.trim()}
            size="sm"
          >
            <Plus className="h-4 w-4" />
            Add
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// --- Main View ---

export function NotificationSettingsView() {
  const [rules, setRules] = useState<NotificationRule[]>([]);
  const [senders, setSenders] = useState<KnownSender[]>([]);
  const [isPending, startTransition] = useTransition();

  const loadData = useCallback(() => {
    startTransition(async () => {
      const [rulesData, sendersData] = await Promise.all([
        fetchRules(),
        fetchKnownSenders(),
      ]);
      setRules(rulesData);
      setSenders(sendersData);
    });
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  function handleSetSenderPriority(
    senderName: string,
    priority: "immediate" | "batch" | "ignore"
  ) {
    // If a rule already exists with same priority, do nothing
    const existing = rules.find(
      (r) => r.rule_type === "sender" && r.match_value === senderName
    );
    if (existing?.priority === priority) return;

    startTransition(async () => {
      // Delete old rule if exists
      if (existing) {
        await deleteRule(existing.id);
      }
      // Create new rule
      const created = await createRule("sender", senderName, priority);
      if (created) {
        setRules((prev) => [
          ...prev.filter(
            (r) =>
              !(r.rule_type === "sender" && r.match_value === senderName)
          ),
          created,
        ]);
      } else {
        // Refresh on failure
        const fresh = await fetchRules();
        setRules(fresh);
      }
    });
  }

  function handleClearRule(ruleId: string) {
    startTransition(async () => {
      const success = await deleteRule(ruleId);
      if (success) {
        setRules((prev) => prev.filter((r) => r.id !== ruleId));
      } else {
        const fresh = await fetchRules();
        setRules(fresh);
      }
    });
  }

  function handleAddKeyword(
    keyword: string,
    priority: "immediate" | "batch"
  ) {
    startTransition(async () => {
      const created = await createRule("keyword", keyword, priority);
      if (created) {
        setRules((prev) => [...prev, created]);
      } else {
        const fresh = await fetchRules();
        setRules(fresh);
      }
    });
  }

  function handleDeleteRule(ruleId: string) {
    startTransition(async () => {
      const success = await deleteRule(ruleId);
      if (success) {
        setRules((prev) => prev.filter((r) => r.id !== ruleId));
      } else {
        const fresh = await fetchRules();
        setRules(fresh);
      }
    });
  }

  const [tab, setTab] = useState<"people" | "keywords">("people");

  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - 8rem)" }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4 shrink-0">
        <div>
          <h1 className="text-2xl font-bold">Notification Rules</h1>
          <p className="text-sm text-gray-500 mt-1">
            Control which messages trigger immediate notifications vs. batch review.
          </p>
        </div>
        <Button onClick={loadData} disabled={isPending} variant="outline" size="sm">
          <RefreshCw className={`h-4 w-4 mr-1 ${isPending ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-gray-200 mb-4 shrink-0">
        <button
          onClick={() => setTab("people")}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
            tab === "people"
              ? "border-primary text-primary"
              : "border-transparent text-gray-500 hover:text-gray-700"
          }`}
        >
          People ({senders.length})
        </button>
        <button
          onClick={() => setTab("keywords")}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
            tab === "keywords"
              ? "border-primary text-primary"
              : "border-transparent text-gray-500 hover:text-gray-700"
          }`}
        >
          Keywords ({rules.filter((r) => r.rule_type === "keyword").length})
        </button>
        <div className="ml-auto text-xs text-gray-400 self-end pb-2">
          {rules.length} rule{rules.length !== 1 ? "s" : ""} total
        </div>
      </div>

      {/* Tab content — scrollable */}
      <div className="flex-1 overflow-y-auto min-h-0 pb-4">
        {tab === "people" && (
          <PeopleSection
            senders={senders}
            rules={rules}
            onSetPriority={handleSetSenderPriority}
            onClearRule={handleClearRule}
            isPending={isPending}
          />
        )}
        {tab === "keywords" && (
          <KeywordsSection
            rules={rules}
            onAddKeyword={handleAddKeyword}
            onDeleteRule={handleDeleteRule}
            isPending={isPending}
          />
        )}
      </div>
    </div>
  );
}
