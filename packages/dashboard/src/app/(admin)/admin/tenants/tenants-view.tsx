"use client";

import { useState, useEffect, useTransition, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Building2,
  RefreshCw,
  Ban,
  CheckCircle,
  Mail,
  Copy,
  Check,
  Calendar,
  MessageSquare,
  HeartPulse,
} from "lucide-react";
import {
  fetchTenants,
  setTenantEnabled,
  inviteTenant,
} from "./tenants-server-actions";
import {
  roleBadgeVariant,
  onboardingProgress,
  relativeTime,
  type Tenant,
} from "./tenants-types";

// --- Error Banner ---

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

// --- Onboarding progress indicator ---

function OnboardingProgressCell({ tenant }: { tenant: Tenant }) {
  const { complete, percent, done, total } = onboardingProgress(
    tenant.onboarding
  );
  if (complete) {
    return <Badge variant="success">Complete</Badge>;
  }
  return (
    <div className="flex items-center gap-2 min-w-[7rem]">
      <div className="h-1.5 flex-1 rounded-full bg-gray-100 overflow-hidden">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="text-xs text-gray-500 tabular-nums">
        {total > 0 ? `${done}/${total}` : `${percent}%`}
      </span>
    </div>
  );
}

// --- Channel chips ---

function ChannelChips({ tenant }: { tenant: Tenant }) {
  const chips: Array<{
    key: string;
    label: string;
    on: boolean;
    Icon: typeof Calendar;
  }> = [
    { key: "google", label: "Google", on: tenant.channels.google, Icon: Calendar },
    {
      key: "whatsapp",
      label: "WhatsApp",
      on: tenant.channels.whatsapp,
      Icon: MessageSquare,
    },
    { key: "health", label: "Health", on: tenant.channels.health, Icon: HeartPulse },
  ];
  return (
    <div className="flex items-center gap-1">
      {chips.map(({ key, label, on, Icon }) => (
        <span
          key={key}
          title={`${label}: ${on ? "connected" : "not connected"}`}
          className={
            "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium " +
            (on
              ? "border-green-200 bg-green-50 text-green-700"
              : "border-gray-200 bg-gray-50 text-gray-300")
          }
        >
          <Icon className="h-3 w-3" />
          {label}
        </span>
      ))}
    </div>
  );
}

// --- Invite / Resend dialog ---

function InviteDialog({
  open,
  onOpenChange,
  initialEmail,
  onInvite,
  isPending,
  acceptUrl,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialEmail: string;
  onInvite: (email: string) => void;
  isPending: boolean;
  acceptUrl: string | null;
}) {
  const [email, setEmail] = useState(initialEmail);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open) {
      setEmail(initialEmail);
      setCopied(false);
    }
  }, [open, initialEmail]);

  async function copy() {
    if (!acceptUrl) return;
    try {
      await navigator.clipboard.writeText(acceptUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard may be unavailable; input stays selectable */
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    onInvite(email.trim());
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite / Resend</DialogTitle>
          <DialogDescription>
            Send an invite link to onboard or re-onboard this tenant.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="tenant_invite_email">Email</Label>
            <Input
              id="tenant_invite_email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="invitee@example.com"
              autoFocus
            />
          </div>

          {acceptUrl && (
            <div className="space-y-2 rounded-md border border-green-200 bg-green-50 p-3">
              <p className="text-sm font-medium text-green-800">
                Invite created. Share this link until email delivery is
                configured:
              </p>
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={acceptUrl}
                  className="text-xs"
                  onFocus={(e) => e.target.select()}
                />
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
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Close
            </Button>
            <Button type="submit" disabled={isPending || !email.trim()}>
              <Mail className="h-3.5 w-3.5 mr-1" />
              {isPending ? "Sending..." : "Send invite"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Tenant Row ---

function TenantRow({
  tenant,
  onToggleEnabled,
  onInvite,
  isPending,
}: {
  tenant: Tenant;
  onToggleEnabled: (tenant: Tenant) => void;
  onInvite: (tenant: Tenant) => void;
  isPending: boolean;
}) {
  return (
    <tr className="border-b border-gray-100 last:border-0 align-middle">
      <td className="py-2.5 pr-3">
        <div className="flex flex-col">
          <span className="text-sm font-medium">
            {tenant.display_name ||
              tenant.username || (
                <span className="text-gray-400 italic">unnamed</span>
              )}
          </span>
          <span className="text-xs text-gray-400">
            {tenant.email ?? tenant.username ?? tenant.user_id}
          </span>
        </div>
      </td>
      <td className="py-2.5 pr-3">
        <Badge variant={roleBadgeVariant(tenant.role)}>{tenant.role}</Badge>
      </td>
      <td className="py-2.5 pr-3">
        <Badge variant={tenant.enabled ? "success" : "destructive"}>
          {tenant.enabled ? "Enabled" : "Disabled"}
        </Badge>
      </td>
      <td className="py-2.5 pr-3">
        <OnboardingProgressCell tenant={tenant} />
      </td>
      <td className="py-2.5 pr-3">
        <ChannelChips tenant={tenant} />
      </td>
      <td className="py-2.5 pr-3">
        <span className="text-xs text-gray-400">
          {relativeTime(tenant.last_active_at)}
        </span>
      </td>
      <td className="py-2.5 text-right">
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onInvite(tenant)}
            disabled={isPending}
            className="h-7 px-2 text-xs"
          >
            <Mail className="h-3 w-3 mr-1" />
            Invite
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onToggleEnabled(tenant)}
            disabled={isPending}
            className={`h-7 px-2 text-xs ${
              tenant.enabled
                ? "text-red-600 hover:text-red-700 hover:bg-red-50"
                : "text-green-600 hover:text-green-700 hover:bg-green-50"
            }`}
          >
            {tenant.enabled ? (
              <>
                <Ban className="h-3 w-3 mr-1" />
                Disable
              </>
            ) : (
              <>
                <CheckCircle className="h-3 w-3 mr-1" />
                Enable
              </>
            )}
          </Button>
        </div>
      </td>
    </tr>
  );
}

// --- Main View ---

export function TenantsView() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteTarget, setInviteTarget] = useState<Tenant | null>(null);
  const [acceptUrl, setAcceptUrl] = useState<string | null>(null);

  const loadTenants = useCallback(() => {
    startTransition(async () => {
      const data = await fetchTenants();
      setTenants(data);
    });
  }, []);

  useEffect(() => {
    loadTenants();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleToggleEnabled(tenant: Tenant) {
    const next = !tenant.enabled;
    const label = tenant.display_name || tenant.email || tenant.username || tenant.user_id;
    if (
      !window.confirm(
        `${next ? "Enable" : "Disable"} tenant "${label}"?`
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await setTenantEnabled(tenant.user_id, next);
      if (!result.success) {
        setError(result.error ?? "Failed to update tenant status");
        return;
      }
      loadTenants();
    });
  }

  function handleInviteClick(tenant: Tenant) {
    setInviteTarget(tenant);
    setAcceptUrl(null);
    setInviteOpen(true);
  }

  function handleInvite(email: string) {
    setError(null);
    startTransition(async () => {
      const result = await inviteTenant(email, inviteTarget?.role);
      if (!result.success) {
        setError(result.error ?? "Failed to send invite");
        return;
      }
      setAcceptUrl(result.accept_url ?? null);
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Tenants</h1>
        <Button
          onClick={loadTenants}
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

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Building2 className="h-4 w-4 text-gray-400" />
            <span>All tenants</span>
            <Badge variant="secondary" className="text-xs">
              {tenants.length}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {tenants.length === 0 && !isPending ? (
            <div className="flex flex-col items-center justify-center py-12 text-gray-400">
              <Building2 className="h-12 w-12 mb-3" />
              <p className="text-sm">No tenants found.</p>
              <p className="text-xs mt-1">
                Invite a user to onboard the first tenant.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wide pb-2 pr-3">
                      Tenant
                    </th>
                    <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wide pb-2 pr-3">
                      Role
                    </th>
                    <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wide pb-2 pr-3">
                      Status
                    </th>
                    <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wide pb-2 pr-3">
                      Onboarding
                    </th>
                    <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wide pb-2 pr-3">
                      Channels
                    </th>
                    <th className="text-left text-xs font-medium text-gray-500 uppercase tracking-wide pb-2 pr-3">
                      Last active
                    </th>
                    <th className="text-right text-xs font-medium text-gray-500 uppercase tracking-wide pb-2">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {tenants.map((tenant) => (
                    <TenantRow
                      key={tenant.user_id}
                      tenant={tenant}
                      onToggleEnabled={handleToggleEnabled}
                      onInvite={handleInviteClick}
                      isPending={isPending}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <InviteDialog
        open={inviteOpen}
        onOpenChange={(open) => {
          setInviteOpen(open);
          if (!open) {
            setInviteTarget(null);
            setAcceptUrl(null);
          }
        }}
        initialEmail={inviteTarget?.email ?? ""}
        onInvite={handleInvite}
        isPending={isPending}
        acceptUrl={acceptUrl}
      />
    </div>
  );
}
