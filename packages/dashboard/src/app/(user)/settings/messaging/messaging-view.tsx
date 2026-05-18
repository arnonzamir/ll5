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
  Plus,
  QrCode,
  Power,
  RotateCw,
  X,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  fetchAccounts,
  fetchConversations,
  updatePermission,
  syncConversations,
  provisionWhatsAppAccount,
  getPairingQr,
  restartAccount,
  disconnectAccount,
  getAccountStatus,
} from "./messaging-server-actions";
import type { Account, Conversation, PairingQr } from "./messaging-types";

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
  // Map both Evolution states (open/close/connecting) AND the legacy
  // 'connected'/'disconnected' strings the DB row stores. Anything yellow-ish
  // (pairing) gets a pulse so the user notices.
  const normalized = status.toLowerCase();
  let color = "bg-gray-300";
  let pulse = false;
  if (normalized === "connected" || normalized === "open") {
    color = "bg-green-500";
  } else if (
    normalized === "connecting" ||
    normalized === "qr_pending" ||
    normalized === "reconnecting"
  ) {
    color = "bg-yellow-400";
    pulse = true;
  } else if (
    normalized === "close" ||
    normalized === "disconnected" ||
    normalized === "token_invalid"
  ) {
    color = "bg-red-400";
  }
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${color} ${pulse ? "animate-pulse" : ""}`}
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
  } catch (err) {
    console.warn("[messaging] formatTime failed:", err instanceof Error ? err.message : String(err));
    return "";
  }
}

// --- Status badge color picker (shared with AccountRow) ---
function statusBadgeClass(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === "connected" || normalized === "open") {
    return "border-green-300 text-green-700";
  }
  if (
    normalized === "connecting" ||
    normalized === "qr_pending" ||
    normalized === "reconnecting"
  ) {
    return "border-yellow-300 text-yellow-700";
  }
  return "border-red-300 text-red-600";
}

// --- Accounts Section ---

function AccountRow({
  account,
  onSync,
  onRepair,
  onRestart,
  onDisconnect,
  isBusy,
}: {
  account: Account;
  onSync: (accountId: string) => void;
  onRepair: (accountId: string) => void;
  onRestart: (accountId: string) => void;
  onDisconnect: (accountId: string) => void;
  isBusy: boolean;
}) {
  const isWhatsApp = account.platform.toLowerCase() === "whatsapp";
  return (
    <div className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
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
          className={`text-[10px] px-1.5 py-0 ${statusBadgeClass(account.status)}`}
        >
          {account.status}
        </Badge>
        {isWhatsApp && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onSync(account.account_id)}
              disabled={isBusy}
              className="h-7 text-xs"
              title="Sync conversations from Evolution"
            >
              <RefreshCw className={`h-3 w-3 mr-1 ${isBusy ? "animate-spin" : ""}`} />
              Sync
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onRepair(account.account_id)}
              disabled={isBusy}
              className="h-7 text-xs"
              title="Fetch fresh QR — re-link this number to a new device slot"
            >
              <QrCode className="h-3 w-3 mr-1" />
              Re-pair
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onRestart(account.account_id)}
              disabled={isBusy}
              className="h-7 text-xs"
              title="Restart Evolution instance — recovers from ghost-connected state"
            >
              <RotateCw className="h-3 w-3 mr-1" />
              Restart
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onDisconnect(account.account_id)}
              disabled={isBusy}
              className="h-7 text-xs text-red-600 hover:text-red-700 hover:bg-red-50"
              title="Log this WhatsApp out (does NOT delete the instance)"
            >
              <Power className="h-3 w-3 mr-1" />
              Disconnect
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function AccountsSection({
  accounts,
  onSync,
  onRepair,
  onRestart,
  onDisconnect,
  onAddClick,
  isBusy,
}: {
  accounts: Account[];
  onSync: (accountId: string) => void;
  onRepair: (accountId: string) => void;
  onRestart: (accountId: string) => void;
  onDisconnect: (accountId: string) => void;
  onAddClick: () => void;
  isBusy: boolean;
}) {
  return (
    <Card>
      <CardHeader className="pb-3 flex flex-row items-center justify-between">
        <CardTitle className="text-base flex items-center gap-2">
          <Wifi className="h-4 w-4" />
          Connected Accounts
        </CardTitle>
        <Button size="sm" onClick={onAddClick} className="h-7 text-xs">
          <Plus className="h-3 w-3 mr-1" />
          Add WhatsApp account
        </Button>
      </CardHeader>
      <CardContent>
        {accounts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-gray-400">
            <WifiOff className="h-8 w-8 mb-2" />
            <p className="text-sm">No messaging accounts connected.</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {accounts.map((account) => (
              <AccountRow
                key={account.account_id}
                account={account}
                onSync={onSync}
                onRepair={onRepair}
                onRestart={onRestart}
                onDisconnect={onDisconnect}
                isBusy={isBusy}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// --- Add Account Dialog ---

function AddAccountDialog({
  open,
  onOpenChange,
  onProvision,
  isSubmitting,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onProvision: (instanceName: string) => void;
  isSubmitting: boolean;
  error: string | null;
}) {
  const [instanceName, setInstanceName] = useState("ll5");
  const validName = /^[a-z0-9_]{1,64}$/.test(instanceName);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add WhatsApp account</DialogTitle>
          <DialogDescription>
            Creates a new Evolution API instance with the gateway webhook
            pre-configured, then shows you a QR code to pair your phone.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <Label htmlFor="instance-name" className="text-xs text-gray-600">
              Instance name
            </Label>
            <Input
              id="instance-name"
              value={instanceName}
              onChange={(e) => setInstanceName(e.target.value)}
              placeholder="ll5"
              disabled={isSubmitting}
              className="mt-1"
            />
            <p className="text-[11px] text-gray-400 mt-1">
              Lowercase letters, digits, underscore. No spaces. Evolution
              enforces this.
            </p>
          </div>
          {!validName && instanceName.length > 0 && (
            <p className="text-xs text-red-600">
              Invalid name: only lowercase letters, digits, and underscore allowed.
            </p>
          )}
          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            onClick={() => onProvision(instanceName)}
            disabled={!validName || isSubmitting}
          >
            {isSubmitting ? "Creating…" : "Create + show QR"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- Pairing QR Dialog ---

function PairingDialog({
  open,
  onOpenChange,
  qr,
  status,
  title,
  onRefreshQr,
  isRefreshing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  qr: PairingQr | null;
  status: string;
  title: string;
  onRefreshQr: () => void;
  isRefreshing: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <QrCode className="h-4 w-4" /> {title}
          </DialogTitle>
          <DialogDescription>
            On your phone: <strong>WhatsApp → Settings → Linked Devices → Link a Device</strong> → scan the code below.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center py-4">
          {qr?.base64 ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={qr.base64.startsWith("data:") ? qr.base64 : `data:image/png;base64,${qr.base64}`}
              alt="WhatsApp pairing QR code"
              className="w-64 h-64 border border-gray-200 rounded-md"
            />
          ) : (
            <div className="w-64 h-64 border border-dashed border-gray-200 rounded-md flex items-center justify-center text-xs text-gray-400">
              {isRefreshing ? "Loading QR…" : "QR not available"}
            </div>
          )}
          {qr?.pairing_code && (
            <div className="mt-3 text-center">
              <div className="text-[11px] text-gray-400 uppercase tracking-wide">
                Or enter pairing code
              </div>
              <div className="font-mono text-lg tracking-widest">
                {qr.pairing_code}
              </div>
            </div>
          )}
          <div className="mt-3 flex items-center gap-2 text-xs">
            <StatusDot status={status} />
            <span className="text-gray-500">{status}</span>
          </div>
        </div>
        <DialogFooter className="flex sm:justify-between">
          <Button variant="outline" size="sm" onClick={onRefreshQr} disabled={isRefreshing}>
            <RefreshCw className={`h-3 w-3 mr-1 ${isRefreshing ? "animate-spin" : ""}`} />
            Refresh QR
          </Button>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            <X className="h-3 w-3 mr-1" />
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
    <div className={`flex items-center gap-3 py-2.5 ${conversation.is_archived ? "opacity-50" : ""}`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {conversation.is_group ? (
            <Users className="h-3.5 w-3.5 text-gray-400 shrink-0" />
          ) : (
            <User className="h-3.5 w-3.5 text-gray-400 shrink-0" />
          )}
          <span className="text-sm font-medium truncate">
            {conversation.name && !conversation.name.includes('@') ? conversation.name : conversation.conversation_id.split('@')[0]}
          </span>
          <PlatformBadge platform={conversation.platform} />
          {conversation.is_group && (
            <Badge className="bg-purple-100 text-purple-700 border-transparent text-[10px] px-1.5 py-0">
              group
            </Badge>
          )}
          {conversation.is_archived && (
            <span className="text-[10px] text-gray-400 italic">archived</span>
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
  // Conversations list is collapsed by default — most of the time the user
  // is here to manage accounts, not flip 500 conversation toggles.
  const [collapsed, setCollapsed] = useState(true);

  const filtered = conversations
    .filter((c) => {
      if (filter === "direct" && c.is_group) return false;
      if (filter === "group" && !c.is_group) return false;
      if (namedOnly && (!c.name || /^\+?\d[\d\s\-()]+$/.test(c.name) || c.name.includes("@"))) return false;
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
      <CardHeader
        className="pb-3 cursor-pointer select-none"
        onClick={() => setCollapsed((v) => !v)}
        role="button"
        aria-expanded={!collapsed}
      >
        <CardTitle className="text-base flex items-center gap-2">
          {collapsed ? (
            <ChevronRight className="h-4 w-4 text-gray-400" />
          ) : (
            <ChevronDown className="h-4 w-4 text-gray-400" />
          )}
          <MessageSquare className="h-4 w-4" />
          Conversations
          <span className="ml-1 text-xs font-normal text-gray-400">
            ({conversations.length})
          </span>
        </CardTitle>
        {!collapsed && (
          <CardDescription>
            Control how the agent interacts with each conversation. Agent = full
            access, Input = read only, Ignore = skip entirely.
          </CardDescription>
        )}
      </CardHeader>
      {!collapsed && (
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
      )}
    </Card>
  );
}

// --- Main View ---

export function MessagingView() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [isPending, startTransition] = useTransition();
  const [isSyncing, setIsSyncing] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [syncResult, setSyncResult] = useState<{
    total: number;
    new_conversations: number;
  } | null>(null);

  // Add-account dialog
  const [addOpen, setAddOpen] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addSubmitting, setAddSubmitting] = useState(false);

  // Pairing-QR dialog (used for both initial-pair-after-add and re-pair)
  const [pairOpen, setPairOpen] = useState(false);
  const [pairTitle, setPairTitle] = useState("Pair WhatsApp");
  const [pairAccountId, setPairAccountId] = useState<string | null>(null);
  const [pairQr, setPairQr] = useState<PairingQr | null>(null);
  const [pairStatus, setPairStatus] = useState<string>("qr_pending");
  const [pairRefreshing, setPairRefreshing] = useState(false);

  // Banner for action results
  const [actionBanner, setActionBanner] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);

  // Helper: refresh each account's live status from Evolution (writes back to
  // DB via the MCP), then re-fetch the rows so local state reflects truth.
  // Without this, the DB column stays at whatever the last CONNECTION_UPDATE
  // webhook wrote — which can lag Evolution by minutes or be flat-out wrong
  // after a pairing flow. See incident notes 2026-05-18 PM.
  const refreshAccountsLive = useCallback(async (accs: Account[]) => {
    if (accs.length === 0) return;
    await Promise.all(accs.map((a) => getAccountStatus(a.account_id)));
    const fresh = await fetchAccounts();
    setAccounts(fresh);
  }, []);

  const loadData = useCallback(() => {
    startTransition(async () => {
      const [accountsData, conversationsData] = await Promise.all([
        fetchAccounts(),
        fetchConversations(),
      ]);
      setAccounts(accountsData);
      setConversations(conversationsData);
      // Fire-and-forget live refresh — paints DB-state immediately, replaces
      // it with Evolution-truth a few seconds later.
      void refreshAccountsLive(accountsData);
    });
  }, [refreshAccountsLive]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Every 15s: pull live status from Evolution (writes DB), then re-read DB.
  useEffect(() => {
    if (accounts.length === 0) return;
    const interval = setInterval(() => {
      void refreshAccountsLive(accounts);
    }, 15_000);
    return () => clearInterval(interval);
  }, [accounts, refreshAccountsLive]);

  // While the pairing dialog is open, poll get_account_status every 5s and
  // auto-close when the account flips to connected. Also re-fetch the QR
  // every 30s because Evolution rotates it.
  useEffect(() => {
    if (!pairOpen || !pairAccountId) return;
    const aid = pairAccountId;

    const statusTimer = setInterval(async () => {
      const status = await getAccountStatus(aid);
      if (status) {
        setPairStatus(status.status);
        if (status.status === "connected" || status.status === "open") {
          setPairOpen(false);
          setActionBanner({
            kind: "success",
            text: `WhatsApp connected: ${status.display_name}`,
          });
          // Refresh the accounts list immediately
          const fresh = await fetchAccounts();
          setAccounts(fresh);
        }
      }
    }, 5_000);

    const qrTimer = setInterval(async () => {
      setPairRefreshing(true);
      const qr = await getPairingQr(aid);
      if (qr) setPairQr(qr);
      setPairRefreshing(false);
    }, 30_000);

    return () => {
      clearInterval(statusTimer);
      clearInterval(qrTimer);
    };
  }, [pairOpen, pairAccountId]);

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

  async function handleProvision(instanceName: string) {
    setAddSubmitting(true);
    setAddError(null);
    try {
      const result = await provisionWhatsAppAccount(instanceName);
      if (!result.success || !result.account) {
        setAddError(result.message || result.error || "Provision failed");
        return;
      }
      // Close add dialog, open pair dialog
      setAddOpen(false);
      setPairTitle(`Pair "${result.account.instance_name}"`);
      setPairAccountId(result.account.id);
      setPairQr(result.qr ?? null);
      setPairStatus(result.account.status);
      setPairOpen(true);
      // Refresh accounts list
      const fresh = await fetchAccounts();
      setAccounts(fresh);
    } finally {
      setAddSubmitting(false);
    }
  }

  async function handleRepair(accountId: string) {
    setIsBusy(true);
    setActionBanner(null);
    try {
      const qr = await getPairingQr(accountId);
      if (!qr) {
        setActionBanner({ kind: "error", text: "Could not fetch pairing QR. Is the instance running?" });
        return;
      }
      const account = accounts.find((a) => a.account_id === accountId);
      setPairTitle(`Re-pair "${account?.display_name ?? "WhatsApp"}"`);
      setPairAccountId(accountId);
      setPairQr(qr);
      setPairStatus("qr_pending");
      setPairOpen(true);
    } finally {
      setIsBusy(false);
    }
  }

  async function handleRestart(accountId: string) {
    setIsBusy(true);
    setActionBanner(null);
    try {
      const result = await restartAccount(accountId);
      if (result.success) {
        setActionBanner({
          kind: "success",
          text: `Restart issued (state: ${result.state_after ?? "pending"}). May take 10–30s to fully reconnect.`,
        });
      } else {
        setActionBanner({ kind: "error", text: `Restart failed: ${result.error}` });
      }
      const fresh = await fetchAccounts();
      setAccounts(fresh);
    } finally {
      setIsBusy(false);
    }
  }

  async function handleDisconnect(accountId: string) {
    const account = accounts.find((a) => a.account_id === accountId);
    const name = account?.display_name ?? "this account";
    if (!confirm(
      `Log "${name}" out of WhatsApp?\n\nThe Evolution instance and stored data are NOT deleted — you can re-pair later.`,
    )) {
      return;
    }
    setIsBusy(true);
    setActionBanner(null);
    try {
      const result = await disconnectAccount(accountId);
      if (result.success) {
        setActionBanner({ kind: "success", text: `Logged ${name} out of WhatsApp.` });
      } else {
        setActionBanner({ kind: "error", text: `Disconnect failed: ${result.error}` });
      }
      const fresh = await fetchAccounts();
      setAccounts(fresh);
    } finally {
      setIsBusy(false);
    }
  }

  async function refreshPairQr() {
    if (!pairAccountId) return;
    setPairRefreshing(true);
    try {
      const qr = await getPairingQr(pairAccountId);
      if (qr) setPairQr(qr);
    } finally {
      setPairRefreshing(false);
    }
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

      {/* Action banner (provision / restart / disconnect) */}
      {actionBanner && (
        <div
          className={`mb-4 shrink-0 rounded-md border px-4 py-2 text-sm ${
            actionBanner.kind === "success"
              ? "border-green-200 bg-green-50 text-green-800"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {actionBanner.text}
          <button
            onClick={() => setActionBanner(null)}
            className="ml-2 font-medium cursor-pointer underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Content — scrollable */}
      <div className="flex-1 overflow-y-auto min-h-0 pb-4 space-y-4">
        <AccountsSection
          accounts={accounts}
          onSync={(id) => { handleSync(id); }}
          onRepair={(id) => { void handleRepair(id); }}
          onRestart={(id) => { void handleRestart(id); }}
          onDisconnect={(id) => { void handleDisconnect(id); }}
          onAddClick={() => { setAddError(null); setAddOpen(true); }}
          isBusy={isBusy || isSyncing}
        />
        <ConversationsSection
          conversations={conversations}
          onPermissionChange={handlePermissionChange}
          isPending={isPending}
        />
      </div>

      <AddAccountDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onProvision={(name) => { void handleProvision(name); }}
        isSubmitting={addSubmitting}
        error={addError}
      />

      <PairingDialog
        open={pairOpen}
        onOpenChange={setPairOpen}
        qr={pairQr}
        status={pairStatus}
        title={pairTitle}
        onRefreshQr={() => { void refreshPairQr(); }}
        isRefreshing={pairRefreshing}
      />
    </div>
  );
}
