"use client";

import { useState, useEffect, useTransition, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Mail, Plus, RefreshCw, Trash2, Copy, Check } from "lucide-react";
import {
  fetchInvites,
  createInvite,
  revokeInvite,
} from "./invites-server-actions";
import type { Invite } from "./invites-types";
import { roleBadgeVariant } from "../tenants/tenants-types";

function ErrorBanner({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
      <span>{message}</span>
      <button
        onClick={onDismiss}
        className="text-red-400 hover:text-red-600 cursor-pointer"
      >
        Dismiss
      </button>
    </div>
  );
}

// --- Accept-URL share panel (the working share path until SMTP is wired) ---

function AcceptUrlPanel({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard may be unavailable; the input remains selectable */
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-green-200 bg-green-50 p-3">
      <p className="text-sm font-medium text-green-800">
        Invite created. Share this link until email delivery is configured:
      </p>
      <div className="flex items-center gap-2">
        <Input readOnly value={url} className="text-xs" onFocus={(e) => e.target.select()} />
        <Button type="button" size="sm" variant="outline" onClick={copy}>
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 mr-1" />
              Copied
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5 mr-1" />
              Copy
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

function InviteRow({
  invite,
  onRevoke,
  isPending,
}: {
  invite: Invite;
  onRevoke: (invite: Invite) => void;
  isPending: boolean;
}) {
  return (
    <tr className="border-b border-gray-100 last:border-0">
      <td className="py-2.5 pr-3">
        <span className="text-sm font-medium">{invite.email}</span>
      </td>
      <td className="py-2.5 pr-3">
        <Badge variant={roleBadgeVariant(invite.role)}>
          {invite.role}
        </Badge>
      </td>
      <td className="py-2.5 pr-3">
        {invite.pending ? (
          <Badge variant="warning">Pending</Badge>
        ) : invite.accepted_at ? (
          <Badge variant="success">Accepted</Badge>
        ) : (
          <Badge variant="destructive">Expired</Badge>
        )}
      </td>
      <td className="py-2.5 pr-3">
        <span className="text-xs text-gray-400">
          {invite.expires_at
            ? new Date(invite.expires_at).toLocaleString()
            : "--"}
        </span>
      </td>
      <td className="py-2.5 text-right">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onRevoke(invite)}
          disabled={isPending}
          className="h-7 px-2 text-xs text-red-600 hover:text-red-700 hover:bg-red-50"
        >
          <Trash2 className="h-3 w-3 mr-1" />
          Revoke
        </Button>
      </td>
    </tr>
  );
}

export function InvitesView() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [role, setRole] = useState("user");
  const [lastAcceptUrl, setLastAcceptUrl] = useState<string | null>(null);

  const loadInvites = useCallback(() => {
    startTransition(async () => {
      const data = await fetchInvites();
      setInvites(data);
    });
  }, []);

  useEffect(() => {
    loadInvites();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = email.trim();
    if (!trimmed) {
      setError("Email is required");
      return;
    }
    startTransition(async () => {
      const result = await createInvite({ email: trimmed, role });
      if (!result.success) {
        setError(result.error ?? "Failed to create invite");
        return;
      }
      setEmail("");
      setRole("user");
      if (result.accept_url) setLastAcceptUrl(result.accept_url);
      loadInvites();
    });
  }

  function handleRevoke(invite: Invite) {
    setError(null);
    startTransition(async () => {
      const result = await revokeInvite(invite.id);
      if (!result.success) {
        setError(result.error ?? "Failed to revoke invite");
        return;
      }
      loadInvites();
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Invites</h1>
        <Button
          onClick={loadInvites}
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

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {/* Create invite */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Plus className="h-4 w-4 text-gray-400" />
            Create invite
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={handleCreate}
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
          >
            <div className="flex-1 space-y-2">
              <Label htmlFor="invite_email">Email</Label>
              <Input
                id="invite_email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="invitee@example.com"
              />
            </div>
            <div className="space-y-2 sm:w-40">
              <Label htmlFor="invite_role">Role</Label>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger id="invite_role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">User</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={isPending || !email.trim()}>
              <Plus className="h-3.5 w-3.5 mr-1" />
              Create
            </Button>
          </form>

          {lastAcceptUrl && (
            <div className="mt-4">
              <AcceptUrlPanel url={lastAcceptUrl} />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Invite list */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Mail className="h-4 w-4 text-gray-400" />
            <span>All invites</span>
            <Badge variant="secondary" className="text-xs">
              {invites.length}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {invites.length === 0 && !isPending ? (
            <div className="flex flex-col items-center justify-center py-12 text-gray-400">
              <Mail className="h-12 w-12 mb-3" />
              <p className="text-sm">No invites yet.</p>
              <p className="text-xs mt-1">
                Create an invite above to onboard a new user.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wide pb-2 pr-3">
                      Email
                    </th>
                    <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wide pb-2 pr-3">
                      Role
                    </th>
                    <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wide pb-2 pr-3">
                      Status
                    </th>
                    <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wide pb-2 pr-3">
                      Expires
                    </th>
                    <th className="text-right text-xs font-medium text-gray-500 uppercase tracking-wide pb-2">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {invites.map((invite) => (
                    <InviteRow
                      key={invite.id}
                      invite={invite}
                      onRevoke={handleRevoke}
                      isPending={isPending}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
