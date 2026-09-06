"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  fetchConnectorsPage,
  setConnectorEnabled,
  submitConnectorCredentials,
  syncConnectorNow,
  updateConnectorRules,
  updateConnectorSchedule,
} from "./connectors-server-actions";
import {
  AUTH_TYPE_NOTES,
  DEFAULT_RULES,
  type ConnectorRules,
  type ConnectorStatus,
  type ConnectorView,
  type ConnectorsPageData,
} from "./connectors-types";

// ---------- helpers ----------

const STATUS_BADGE: Record<ConnectorStatus, { label: string; variant: "secondary" | "success" | "destructive" | "warning" }> = {
  unconfigured: { label: "Not configured", variant: "secondary" },
  ok: { label: "OK", variant: "success" },
  auth_failed: { label: "Auth failed", variant: "destructive" },
  error: { label: "Error", variant: "destructive" },
  stale: { label: "Stale", variant: "warning" },
};

const SENSITIVITY_CLASS: Record<string, string> = {
  financial: "bg-amber-50 text-amber-800 border-amber-200",
  medical: "bg-rose-50 text-rose-800 border-rose-200",
  civic: "bg-sky-50 text-sky-800 border-sky-200",
  utility: "bg-lime-50 text-lime-800 border-lime-200",
  home: "bg-violet-50 text-violet-800 border-violet-200",
};

function formatWhen(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return d.toLocaleString();
}

function formatSchedule(minutes: number | null): string {
  if (minutes === null) return "no scheduled pull";
  if (minutes % 1440 === 0) return `every ${minutes / 1440} day${minutes === 1440 ? "" : "s"}`;
  if (minutes % 60 === 0) return `every ${minutes / 60} h`;
  return `every ${minutes} min`;
}

type Notice = { kind: "ok" | "error"; text: string } | null;

function NoticeLine({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return (
    <p className={`text-xs mt-2 ${notice.kind === "ok" ? "text-green-700" : "text-red-600"}`}>{notice.text}</p>
  );
}

function Toggle({ on, disabled, onChange, label }: { on: boolean; disabled?: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      disabled={disabled}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${on ? "bg-blue-500" : "bg-gray-200"}`}
    >
      <span className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow ring-0 transition-transform ${on ? "translate-x-5" : "translate-x-0"}`} />
    </button>
  );
}

// ---------- rules ----------

function RulesSection({ initial, disabled }: { initial: ConnectorRules; disabled: boolean }) {
  const [rules, setRules] = useState<ConnectorRules>(initial);
  const [merchantsText, setMerchantsText] = useState(initial.known_merchants.join("\n"));
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    setRules(initial);
    setMerchantsText(initial.known_merchants.join("\n"));
  }, [initial]);

  async function save() {
    setSaving(true);
    setNotice(null);
    const known_merchants = merchantsText.split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean);
    const res = await updateConnectorRules({ ...rules, known_merchants });
    setNotice(res.ok ? { kind: "ok", text: "Rules saved" } : { kind: "error", text: res.error ?? "Save failed" });
    setSaving(false);
  }

  const checkbox = (key: "foreign" | "unknown_merchant" | "asleep_at_home", label: string, hint: string) => (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={rules[key]}
        disabled={disabled}
        onChange={(e) => setRules({ ...rules, [key]: e.target.checked })}
      />
      <span>
        <span className="font-medium">{label}</span>
        <span className="block text-xs text-gray-400">{hint}</span>
      </span>
    </label>
  );

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4 mb-6">
      <h2 className="text-base font-semibold">Alert rules</h2>
      <p className="text-xs text-gray-400 mt-0.5 mb-4">
        Which connector events wake the agent immediately. Everything else lands in the morning brief.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="rule-amount">Amount threshold (ILS)</Label>
          <Input
            id="rule-amount"
            type="number"
            min={0}
            className="mt-1"
            value={rules.amount_threshold}
            disabled={disabled}
            onChange={(e) => setRules({ ...rules, amount_threshold: Number(e.target.value) })}
          />
          <p className="text-xs text-gray-400 mt-1">Default {DEFAULT_RULES.amount_threshold}. Charges at or above this alert at once.</p>
        </div>
        <div>
          <Label htmlFor="rule-dup">Duplicate window (minutes)</Label>
          <Input
            id="rule-dup"
            type="number"
            min={0}
            className="mt-1"
            value={rules.duplicate_window_minutes}
            disabled={disabled}
            onChange={(e) => setRules({ ...rules, duplicate_window_minutes: Number(e.target.value) })}
          />
          <p className="text-xs text-gray-400 mt-1">Same amount and merchant twice within this window counts as a duplicate.</p>
        </div>
        <div className="space-y-3">
          {checkbox("foreign", "Foreign charges", "Non-ILS or abroad")}
          {checkbox("unknown_merchant", "Unknown merchant", "Merchant not in the known list below")}
          {checkbox("asleep_at_home", "Asleep at home", "Any charge while delivery mode is sleep and you are at home (high priority)")}
        </div>
        <div>
          <Label htmlFor="rule-merchants">Known merchants</Label>
          <Textarea
            id="rule-merchants"
            className="mt-1 min-h-24"
            placeholder="One per line"
            value={merchantsText}
            disabled={disabled}
            onChange={(e) => setMerchantsText(e.target.value)}
          />
          <p className="text-xs text-gray-400 mt-1">Merchants here never trigger the unknown-merchant rule.</p>
        </div>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Button size="sm" onClick={save} disabled={saving || disabled}>
          {saving ? "Saving..." : "Save rules"}
        </Button>
        <NoticeLine notice={notice} />
      </div>
    </section>
  );
}

// ---------- credentials ----------

function CredentialsForm({ connector, onSaved }: { connector: ConnectorView; onSaved: () => void }) {
  const [fields, setFields] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const authType = connector.auth_type;
  if (authType !== "scraper_credentials" && authType !== "api_token") {
    return <p className="text-xs text-gray-500">{AUTH_TYPE_NOTES[authType]}</p>;
  }

  const spec: Array<{ key: string; label: string; type?: string; optional?: boolean; placeholder?: string }> =
    authType === "scraper_credentials"
      ? [
          { key: "username", label: "Username or ID number", placeholder: "Portal username / teudat zehut" },
          { key: "password", label: "Password", type: "password" },
          { key: "card_last4", label: "Card last 4 digits", optional: true, placeholder: "Optional" },
        ]
      : [
          { key: "token", label: "API token", type: "password" },
          { key: "base_url", label: "Base URL", placeholder: "https://..." },
        ];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    for (const f of spec) {
      if (!f.optional && !(fields[f.key] ?? "").trim()) {
        setNotice({ kind: "error", text: `${f.label} is required` });
        return;
      }
    }
    setSaving(true);
    setNotice(null);
    const res = await submitConnectorCredentials(connector.id, authType, fields);
    if (res.ok) {
      setFields({});
      setNotice({ kind: "ok", text: "Credentials stored" });
      onSaved();
    } else {
      setNotice({ kind: "error", text: res.error ?? "Could not store credentials" });
    }
    setSaving(false);
  }

  return (
    <form onSubmit={submit} className="space-y-2" autoComplete="off">
      <p className="text-xs text-gray-500">{AUTH_TYPE_NOTES[authType]}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {spec.map((f) => (
          <div key={f.key}>
            <Label htmlFor={`${connector.id}-${f.key}`} className="text-xs">{f.label}</Label>
            <Input
              id={`${connector.id}-${f.key}`}
              type={f.type ?? "text"}
              className="mt-1 h-8"
              placeholder={f.placeholder}
              value={fields[f.key] ?? ""}
              autoComplete="off"
              onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })}
            />
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" variant="outline" disabled={saving}>
          {saving ? "Storing..." : connector.has_credentials ? "Replace credentials" : "Store credentials"}
        </Button>
        <NoticeLine notice={notice} />
      </div>
    </form>
  );
}

// ---------- card ----------

function ConnectorCard({ connector, mcpAvailable, onChanged }: { connector: ConnectorView; mcpAvailable: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [schedule, setSchedule] = useState<string>(connector.schedule_minutes?.toString() ?? "");

  useEffect(() => {
    setSchedule(connector.schedule_minutes?.toString() ?? "");
  }, [connector.schedule_minutes]);

  const badge = STATUS_BADGE[connector.status] ?? STATUS_BADGE.unconfigured;
  const canSync = connector.enabled && connector.has_credentials && mcpAvailable;
  const hasPull = connector.kinds.includes("ledger") && connector.default_schedule_minutes !== null;

  async function toggle(enabled: boolean) {
    setBusy(true);
    setNotice(null);
    const res = await setConnectorEnabled(connector.id, enabled);
    if (!res.ok) setNotice({ kind: "error", text: res.error ?? "Update failed" });
    setBusy(false);
    onChanged();
  }

  async function sync() {
    setBusy(true);
    setNotice(null);
    const res = await syncConnectorNow(connector.id);
    if (res.ok) {
      const summary = res.counts
        ? Object.entries(res.counts).map(([k, v]) => `${k}: ${String(v)}`).join(", ")
        : "";
      setNotice({ kind: "ok", text: summary ? `Synced (${summary})` : "Sync started" });
    } else {
      setNotice({ kind: "error", text: res.error ?? "Sync failed" });
    }
    setBusy(false);
    onChanged();
  }

  async function saveSchedule() {
    const minutes = Number(schedule);
    setBusy(true);
    setNotice(null);
    const res = await updateConnectorSchedule(connector.id, minutes);
    setNotice(res.ok ? { kind: "ok", text: "Schedule saved" } : { kind: "error", text: res.error ?? "Schedule not saved" });
    setBusy(false);
    onChanged();
  }

  return (
    <div className={`rounded-lg border p-4 transition-colors ${connector.enabled ? "border-gray-200 bg-white" : "border-gray-100 bg-gray-50"}`}>
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{connector.label}</span>
            <Badge variant={badge.variant}>{badge.label}</Badge>
            <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] ${SENSITIVITY_CLASS[connector.sensitivity] ?? "bg-gray-50 text-gray-700 border-gray-200"}`}>
              {connector.sensitivity}
            </span>
            {connector.kinds.map((k) => (
              <span key={k} className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600">{k}</span>
            ))}
          </div>
          <div className="text-xs text-gray-400 mt-1">
            <span>Last sync: {formatWhen(connector.last_success_at)}</span>
            <span className="mx-2">|</span>
            <span>{formatSchedule(connector.schedule_minutes)}</span>
            <span className="mx-2">|</span>
            <span>{connector.has_credentials ? "credentials stored" : "no credentials"}</span>
          </div>
          {connector.last_error && (
            <p className="text-xs text-red-600 mt-1 break-words">Last error: {connector.last_error}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button size="sm" variant="outline" onClick={sync} disabled={busy || !canSync} title={canSync ? "Run one pull now" : "Enable the connector and store credentials first"}>
            Sync now
          </Button>
          <Toggle on={connector.enabled} disabled={busy} onChange={toggle} label={`Enable ${connector.label}`} />
        </div>
      </div>

      <NoticeLine notice={notice} />

      <div className="mt-3 border-t border-gray-100 pt-3 space-y-3">
        <CredentialsForm connector={connector} onSaved={onChanged} />
        {hasPull && (
          <div className="flex items-end gap-2">
            <div>
              <Label htmlFor={`${connector.id}-schedule`} className="text-xs">Pull every (minutes)</Label>
              <Input
                id={`${connector.id}-schedule`}
                type="number"
                min={5}
                className="mt-1 h-8 w-32"
                value={schedule}
                disabled={!mcpAvailable}
                onChange={(e) => setSchedule(e.target.value)}
              />
            </div>
            <Button size="sm" variant="ghost" onClick={saveSchedule} disabled={busy || !mcpAvailable || schedule === String(connector.schedule_minutes ?? "")}>
              Save schedule
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- page ----------

export function ConnectorsView() {
  const [data, setData] = useState<ConnectorsPageData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchConnectorsPage());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">Connectors</h1>
          <p className="text-sm text-gray-500 mt-1">
            External accounts (cards, bank, HMO, municipality, utilities, home). Enabling a connector opens its
            gateway ingest and its scheduled pull; credentials are stored encrypted on the connectors service.
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={load} disabled={loading} aria-label="Refresh">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {data && !data.mcpAvailable && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            The connectors service did not answer. Showing the catalog with gateway switch state only: status, last
            sync, credentials and sync are unavailable until it is back.
          </span>
        </div>
      )}

      {!data ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : (
        <>
          <RulesSection initial={data.rules} disabled={false} />
          <div className="space-y-3">
            {data.connectors.map((c) => (
              <ConnectorCard key={c.id} connector={c} mcpAvailable={data.mcpAvailable} onChanged={load} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
