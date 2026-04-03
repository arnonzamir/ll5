"use client";

import { useState, useTransition, useEffect, useCallback, useRef } from "react";
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
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import {
  MessageSquare,
  Users,
  User,
  Image as ImageIcon,
} from "lucide-react";
import {
  fetchRules,
  createRule,
  deleteRule,
  fetchKnownSenders,
  fetchConversations,
  type NotificationRule,
  type KnownSender,
  type ConversationInfo,
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
  } catch (err) {
    console.warn("[notifications] formatLastSeen failed:", err instanceof Error ? err.message : String(err));
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

// --- Conversations Section ---

const PRIORITY_OPTIONS = ["ignore", "batch", "immediate", "agent"] as const;
const PRIORITY_CONFIG = {
  ignore: { label: "Ignore", activeClass: "bg-red-50 text-red-600" },
  batch: { label: "Batch", activeClass: "bg-gray-100 text-gray-700" },
  immediate: { label: "Immediate", activeClass: "bg-amber-100 text-amber-800" },
  agent: { label: "Agent", activeClass: "bg-green-100 text-green-800" },
};

const CONVO_PAGE_SIZE = 50;

function ConversationsSection({
  rules,
  onSetPriority,
  onToggleImages,
  isPending: parentPending,
}: {
  rules: NotificationRule[];
  onSetPriority: (platform: string, conversationId: string, priority: "ignore" | "batch" | "immediate" | "agent") => void;
  onToggleImages: (platform: string, conversationId: string, enabled: boolean) => void;
  isPending: boolean;
}) {
  const [conversations, setConversations] = useState<ConversationInfo[]>([]);
  const [totalConversations, setTotalConversations] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [namedOnly, setNamedOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [isLoading, startLoading] = useTransition();
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isPending = parentPending || isLoading;

  const loadConversations = useCallback(
    (opts?: { query?: string; p?: number }) => {
      const q = opts?.query ?? searchQuery;
      const pg = opts?.p ?? page;

      startLoading(async () => {
        const params: Parameters<typeof fetchConversations>[0] = {
          limit: CONVO_PAGE_SIZE,
          offset: (pg - 1) * CONVO_PAGE_SIZE,
        };
        if (q.trim()) params.query = q.trim();

        const { conversations: data, total } = await fetchConversations(params);
        setConversations(data);
        setTotalConversations(total);
      });
    },
    [searchQuery, page]
  );

  useEffect(() => {
    loadConversations({ p: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleSearchChange(value: string) {
    setSearchQuery(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setPage(1);
      loadConversations({ query: value, p: 1 });
    }, 300);
  }

  function handlePageChange(newPage: number) {
    setPage(newPage);
    loadConversations({ p: newPage });
  }

  // Build a map of conversation rules
  const ruleMap = new Map<string, NotificationRule>();
  for (const r of rules) {
    if (r.rule_type === "conversation" && r.platform) {
      ruleMap.set(`${r.platform}:${r.match_value}`, r);
    }
  }

  const totalPages = Math.max(1, Math.ceil(totalConversations / CONVO_PAGE_SIZE));
  const from = totalConversations > 0 ? (page - 1) * CONVO_PAGE_SIZE + 1 : 0;
  const to = Math.min(page * CONVO_PAGE_SIZE, totalConversations);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <MessageSquare className="h-4 w-4" />
          Conversations
          <span className="text-xs font-normal text-gray-400">({totalConversations})</span>
        </CardTitle>
        <CardDescription>
          Set priority per conversation. Agent = can respond, Immediate = notify now, Batch = periodic summary, Ignore = drop.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <div className="relative flex-1 min-w-[180px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input
              placeholder="Search conversations..."
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="pl-9"
            />
          </div>
          <button
            onClick={() => setNamedOnly((v) => !v)}
            className={`px-2.5 py-1 text-xs font-medium rounded border transition-colors cursor-pointer shrink-0 ${
              namedOnly ? "bg-gray-800 text-white border-gray-800" : "bg-white text-gray-500 border-gray-200 hover:text-gray-700"
            }`}
          >
            Named only
          </button>
        </div>

        {conversations.length === 0 && !isLoading ? (
          <div className="flex flex-col items-center justify-center py-8 text-gray-400">
            <MessageSquare className="h-8 w-8 mb-2" />
            <p className="text-sm">No conversations match your search.</p>
          </div>
        ) : (
          <>
            <div className="divide-y divide-gray-100">
              {conversations
                .filter((c) => !namedOnly || (c.name && !/^\+?\d[\d\s\-()]+$/.test(c.name) && !c.name.includes("@")))
                .map((c) => {
                const rule = ruleMap.get(`${c.platform}:${c.conversation_id}`);
                // Default: no name → ignore, has name → batch
                const hasRealName = c.name && !/^\+?\d[\d\s\-()]+$/.test(c.name) && !c.name.includes("@");
                const activePriority = rule?.priority ?? (hasRealName ? "batch" : "ignore");
                return (
                  <div key={`${c.platform}:${c.conversation_id}`} className="flex items-center gap-3 py-2.5">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        {c.is_group ? (
                          <Users className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                        ) : (
                          <User className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                        )}
                        <span className="text-sm font-medium truncate">
                          {c.name || c.conversation_id}
                        </span>
                        <AppBadge app={c.platform} />
                      </div>
                      {c.last_message_at && (
                        <div className="flex items-center gap-2 mt-0.5 pl-5.5">
                          <span className="text-xs text-gray-400">{formatLastSeen(c.last_message_at)}</span>
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => onToggleImages(c.platform, c.conversation_id, !(rule?.download_images))}
                      disabled={isPending}
                      title={rule?.download_images ? "Images: downloading" : "Images: not downloading"}
                      className={`p-1 rounded transition-colors cursor-pointer shrink-0 ${
                        rule?.download_images ? "text-blue-500 bg-blue-50" : "text-gray-300 hover:text-gray-500"
                      }`}
                    >
                      <ImageIcon className="h-3.5 w-3.5" />
                    </button>
                    <div className="flex items-center rounded-md border border-gray-200 p-0.5 shrink-0">
                      {PRIORITY_OPTIONS.map((p) => {
                        const config = PRIORITY_CONFIG[p];
                        const isActive = activePriority === p;
                        return (
                          <button
                            key={p}
                            onClick={() => {
                              if (isActive) return;
                              onSetPriority(c.platform, c.conversation_id, p);
                            }}
                            disabled={isPending}
                            className={`px-2 py-0.5 text-[11px] font-medium rounded transition-colors cursor-pointer ${
                              isActive ? config.activeClass : "text-gray-400 hover:text-gray-600"
                            }`}
                          >
                            {config.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between pt-3 border-t border-gray-100 mt-2">
                <span className="text-xs text-gray-400">
                  {from}–{to} of {totalConversations}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handlePageChange(page - 1)}
                    disabled={page <= 1 || isPending}
                    className="h-7 w-7 p-0"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="text-xs text-gray-500 px-2">
                    Page {page} of {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handlePageChange(page + 1)}
                    disabled={page >= totalPages || isPending}
                    className="h-7 w-7 p-0"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
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

  function handleSetConversationPriority(
    platform: string,
    conversationId: string,
    priority: "ignore" | "batch" | "immediate" | "agent"
  ) {
    startTransition(async () => {
      const existing = rules.find(
        (r) => r.rule_type === "conversation" && r.match_value === conversationId && r.platform === platform
      );
      const created = await createRule("conversation", conversationId, priority, platform, existing?.download_images);
      if (created) {
        setRules((prev) => [
          ...prev.filter(
            (r) => !(r.rule_type === "conversation" && r.match_value === conversationId && r.platform === platform)
          ),
          created,
        ]);
      } else {
        const fresh = await fetchRules();
        setRules(fresh);
      }
    });
  }

  function handleToggleImages(
    platform: string,
    conversationId: string,
    enabled: boolean
  ) {
    startTransition(async () => {
      const existing = rules.find(
        (r) => r.rule_type === "conversation" && r.match_value === conversationId && r.platform === platform
      );
      const priority = existing?.priority ?? "batch";
      const created = await createRule("conversation", conversationId, priority, platform, enabled);
      if (created) {
        setRules((prev) => [
          ...prev.filter(
            (r) => !(r.rule_type === "conversation" && r.match_value === conversationId && r.platform === platform)
          ),
          created,
        ]);
      } else {
        const fresh = await fetchRules();
        setRules(fresh);
      }
    });
  }

  const [tab, setTab] = useState<"people" | "conversations" | "keywords">("people");

  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - 8rem)" }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4 shrink-0">
        <div>
          <h1 className="text-2xl font-bold">Message Rules</h1>
          <p className="text-sm text-gray-500 mt-1">
            Control how messages are routed: ignore, batch summary, immediate alert, or agent response.
          </p>
        </div>
        <Button onClick={loadData} disabled={isPending} variant="outline" size="sm">
          <RefreshCw className={`h-4 w-4 mr-1 ${isPending ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-gray-200 mb-4 shrink-0">
        {([
          { key: "people" as const, label: `People (${senders.length})` },
          { key: "conversations" as const, label: "Conversations" },
          { key: "keywords" as const, label: `Keywords (${rules.filter((r) => r.rule_type === "keyword").length})` },
        ]).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
              tab === key
                ? "border-primary text-primary"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            {label}
          </button>
        ))}
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
        {tab === "conversations" && (
          <ConversationsSection
            rules={rules}
            onSetPriority={handleSetConversationPriority}
            onToggleImages={handleToggleImages}
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
