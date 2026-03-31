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
  RefreshCw,
  Search,
  Users,
  User,
  MessageSquare,
  Wifi,
  WifiOff,
} from "lucide-react";
import {
  fetchAccounts,
  fetchConversations,
  updatePermission,
  syncConversations,
  type Account,
  type Conversation,
} from "./messaging-server-actions";

// --- Helpers ---

const PLATFORM_COLORS: Record<string, { bg: string; text: string }> = {
  whatsapp: { bg: "bg-green-100", text: "text-green-800" },
  telegram: { bg: "bg-blue-100", text: "text-blue-800" },
};

function PlatformBadge({ platform }: { platform: string }) {
  const colors = PLATFORM_COLORS[platform.toLowerCase()] ?? {
    bg: "bg-gray-100",
    text: "text-gray-700",
  };
  return (
    <Badge
      className={`${colors.bg} ${colors.text} border-transparent text-[10px] px-1.5 py-0`}
    >
      {platform}
    </Badge>
  );
}

function StatusDot({ status }: { status: string }) {
  const isConnected = status === "connected";
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${
        isConnected ? "bg-green-500" : "bg-red-400"
      }`}
      title={status}
    />
  );
}

function formatTime(ts: string | null): string {
  if (!ts) return "never";
  try {
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

// --- Accounts Section ---

function AccountsSection({
  accounts,
  onSync,
  isSyncing,
}: {
  accounts: Account[];
  onSync: (accountId: string) => void;
  isSyncing: boolean;
}) {
  if (accounts.length === 0) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="flex flex-col items-center justify-center text-gray-400">
            <WifiOff className="h-8 w-8 mb-2" />
            <p className="text-sm">No messaging accounts connected.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Wifi className="h-4 w-4" />
          Connected Accounts
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="divide-y divide-gray-100">
          {accounts.map((account) => (
            <div
              key={account.account_id}
              className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
            >
              <StatusDot status={account.status} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">
                    {account.display_name}
                  </span>
                  <PlatformBadge platform={account.platform} />
                </div>
                {account.last_seen_at && (
                  <span className="text-xs text-gray-400">
                    Last seen {formatTime(account.last_seen_at)}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Badge
                  variant="outline"
                  className={`text-[10px] px-1.5 py-0 ${
                    account.status === "connected"
                      ? "border-green-300 text-green-700"
                      : "border-red-300 text-red-600"
                  }`}
                >
                  {account.status}
                </Badge>
                {account.platform.toLowerCase() === "whatsapp" && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onSync(account.account_id)}
                    disabled={isSyncing}
                    className="h-7 text-xs"
                  >
                    <RefreshCw
                      className={`h-3 w-3 mr-1 ${
                        isSyncing ? "animate-spin" : ""
                      }`}
                    />
                    Sync
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// --- Conversation Row ---

function ConversationRow({
  conversation,
  onPermissionChange,
  isPending,
}: {
  conversation: Conversation;
  onPermissionChange: (
    platform: string,
    conversationId: string,
    permission: "agent" | "input" | "ignore"
  ) => void;
  isPending: boolean;
}) {
  const permissions = ["ignore", "input", "agent"] as const;
  const permissionConfig = {
    ignore: { label: "Ignore", activeClass: "bg-red-50 text-red-600" },
    input: { label: "Input", activeClass: "bg-blue-50 text-blue-700" },
    agent: { label: "Agent", activeClass: "bg-amber-100 text-amber-800" },
  };

  return (
    <div className="flex items-center gap-3 py-2.5">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {conversation.is_group ? (
            <Users className="h-3.5 w-3.5 text-gray-400 shrink-0" />
          ) : (
            <User className="h-3.5 w-3.5 text-gray-400 shrink-0" />
          )}
          <span className="text-sm font-medium truncate">
            {conversation.name || conversation.conversation_id}
          </span>
          <PlatformBadge platform={conversation.platform} />
          {conversation.is_group && (
            <Badge className="bg-purple-100 text-purple-700 border-transparent text-[10px] px-1.5 py-0">
              group
            </Badge>
          )}
        </div>
        {conversation.last_message_at && (
          <div className="flex items-center gap-2 mt-0.5 pl-5.5">
            <span className="text-xs text-gray-400">
              Last message {formatTime(conversation.last_message_at)}
            </span>
          </div>
        )}
      </div>

      <div className="flex items-center rounded-md border border-gray-200 p-0.5 shrink-0">
        {permissions.map((p) => {
          const config = permissionConfig[p];
          const isActive = conversation.permission === p;
          return (
            <button
              key={p}
              onClick={() => {
                if (isActive) return;
                onPermissionChange(
                  conversation.platform,
                  conversation.conversation_id,
                  p
                );
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

// --- Conversations Section ---

function ConversationsSection({
  conversations,
  onPermissionChange,
  isPending,
}: {
  conversations: Conversation[];
  onPermissionChange: (
    platform: string,
    conversationId: string,
    permission: "agent" | "input" | "ignore"
  ) => void;
  isPending: boolean;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "direct" | "group">("all");
  const [namedOnly, setNamedOnly] = useState(false);
  const [sortBy, setSortBy] = useState<"permission" | "name">("permission");

  const filtered = conversations
    .filter((c) => {
      if (filter === "direct" && c.is_group) return false;
      if (filter === "group" && !c.is_group) return false;
      if (namedOnly && !c.name) return false;
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const name = (c.name || c.conversation_id).toLowerCase();
        const platform = c.platform.toLowerCase();
        return name.includes(query) || platform.includes(query);
      }
      return true;
    })
    .sort((a, b) => {
      if (sortBy === "name") {
        const nameA = (a.name || a.conversation_id).toLowerCase();
        const nameB = (b.name || b.conversation_id).toLowerCase();
        return nameA.localeCompare(nameB);
      }
      return 0; // keep original order for permission grouping
    });

  // Separate by permission for display (only used when sorting by permission)
  const agentConvos = filtered.filter((c) => c.permission === "agent");
  const inputConvos = filtered.filter((c) => c.permission === "input");
  const ignoreConvos = filtered.filter((c) => c.permission === "ignore");

  const sections = [
    { label: "Agent", items: agentConvos, color: "text-amber-700" },
    { label: "Input", items: inputConvos, color: "text-blue-700" },
    { label: "Ignored", items: ignoreConvos, color: "text-red-600" },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <MessageSquare className="h-4 w-4" />
          Conversations
        </CardTitle>
        <CardDescription>
          Control how the agent interacts with each conversation. Agent = full
          access, Input = read only, Ignore = skip entirely.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <div className="relative flex-1 min-w-[180px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input
              placeholder="Search conversations..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <div className="flex items-center rounded-md border border-gray-200 p-0.5 shrink-0">
            {(["all", "direct", "group"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-2.5 py-1 text-xs font-medium rounded transition-colors cursor-pointer ${
                  filter === f
                    ? "bg-gray-100 text-gray-800"
                    : "text-gray-400 hover:text-gray-600"
                }`}
              >
                {f === "all"
                  ? `All (${conversations.length})`
                  : f === "direct"
                    ? `Direct (${conversations.filter((c) => !c.is_group).length})`
                    : `Groups (${conversations.filter((c) => c.is_group).length})`}
              </button>
            ))}
          </div>
          <button
            onClick={() => setNamedOnly((v) => !v)}
            className={`px-2.5 py-1 text-xs font-medium rounded border transition-colors cursor-pointer shrink-0 ${
              namedOnly
                ? "bg-gray-800 text-white border-gray-800"
                : "bg-white text-gray-500 border-gray-200 hover:text-gray-700"
            }`}
          >
            Named only
          </button>
          <div className="flex items-center rounded-md border border-gray-200 p-0.5 shrink-0">
            {(["permission", "name"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSortBy(s)}
                className={`px-2.5 py-1 text-xs font-medium rounded transition-colors cursor-pointer ${
                  sortBy === s
                    ? "bg-gray-100 text-gray-800"
                    : "text-gray-400 hover:text-gray-600"
                }`}
              >
                {s === "permission" ? "By permission" : "By name"}
              </button>
            ))}
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-gray-400">
            <MessageSquare className="h-8 w-8 mb-2" />
            <p className="text-sm">
              {conversations.length === 0
                ? "No conversations found. Try syncing your accounts."
                : "No conversations match your filters."}
            </p>
          </div>
        ) : sortBy === "name" ? (
          <div>
            <div className="text-xs text-gray-400 mb-1 px-1">
              {filtered.length} conversation{filtered.length !== 1 ? "s" : ""}
            </div>
            <div className="divide-y divide-gray-100">
              {filtered.map((conversation) => (
                <ConversationRow
                  key={conversation.id}
                  conversation={conversation}
                  onPermissionChange={onPermissionChange}
                  isPending={isPending}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {sections.map((section) => {
              if (section.items.length === 0) return null;
              return (
                <div key={section.label}>
                  <div
                    className={`text-xs font-semibold uppercase tracking-wide mb-1 px-1 ${section.color}`}
                  >
                    {section.label} ({section.items.length})
                  </div>
                  <div className="divide-y divide-gray-100">
                    {section.items.map((conversation) => (
                      <ConversationRow
                        key={conversation.id}
                        conversation={conversation}
                        onPermissionChange={onPermissionChange}
                        isPending={isPending}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// --- Main View ---

export function MessagingView() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [isPending, startTransition] = useTransition();
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{
    total: number;
    new_conversations: number;
  } | null>(null);

  const loadData = useCallback(() => {
    startTransition(async () => {
      const [accountsData, conversationsData] = await Promise.all([
        fetchAccounts(),
        fetchConversations(),
      ]);
      setAccounts(accountsData);
      setConversations(conversationsData);
    });
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  function handlePermissionChange(
    platform: string,
    conversationId: string,
    permission: "agent" | "input" | "ignore"
  ) {
    // Optimistic update
    setConversations((prev) =>
      prev.map((c) =>
        c.platform === platform && c.conversation_id === conversationId
          ? { ...c, permission }
          : c
      )
    );

    startTransition(async () => {
      const success = await updatePermission(
        platform,
        conversationId,
        permission
      );
      if (!success) {
        // Revert on failure
        const fresh = await fetchConversations();
        setConversations(fresh);
      }
    });
  }

  function handleSync(accountId: string) {
    setIsSyncing(true);
    setSyncResult(null);

    startTransition(async () => {
      try {
        const result = await syncConversations(accountId);
        setSyncResult(result);
        // Reload conversations after sync
        const fresh = await fetchConversations();
        setConversations(fresh);
      } finally {
        setIsSyncing(false);
      }
    });
  }

  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - 8rem)" }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4 shrink-0">
        <div>
          <h1 className="text-2xl font-bold">Messaging Settings</h1>
          <p className="text-sm text-gray-500 mt-1">
            Manage connected accounts and conversation permissions.
          </p>
        </div>
        <Button
          onClick={loadData}
          disabled={isPending}
          variant="outline"
          size="sm"
        >
          <RefreshCw
            className={`h-4 w-4 mr-1 ${isPending ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>

      {/* Sync result banner */}
      {syncResult && (
        <div className="mb-4 shrink-0 rounded-md border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-800">
          Sync complete: {syncResult.total} conversations total,{" "}
          {syncResult.new_conversations} new.
          <button
            onClick={() => setSyncResult(null)}
            className="ml-2 text-green-600 hover:text-green-800 font-medium cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Content — scrollable */}
      <div className="flex-1 overflow-y-auto min-h-0 pb-4 space-y-4">
        <AccountsSection
          accounts={accounts}
          onSync={handleSync}
          isSyncing={isSyncing}
        />
        <ConversationsSection
          conversations={conversations}
          onPermissionChange={handlePermissionChange}
          isPending={isPending}
        />
      </div>
    </div>
  );
}
