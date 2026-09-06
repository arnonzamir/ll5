"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Lock, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  fetchFinanceOverview,
  fetchLedgerPage,
  fetchLedgerSummary,
  markMerchantKnown,
  resolveFindingAction,
  syncFinancyNow,
} from "./finance-server-actions";
import {
  DEFAULT_PERIOD,
  FINANCY_ID,
  PERIOD_OPTIONS,
  eventTitle,
  rowCategoryMain,
  rowMemo,
  rowMerchant,
  type BarRow,
  type EventRow,
  type FinanceConnector,
  type FinanceOverview,
  type Finding,
  type LedgerFilters,
  type LedgerKindFilter,
  type LedgerRow,
  type LedgerSummary,
  type PeriodDays,
  type SnapshotAccount,
  type SnapshotConnection,
} from "./finance-types";

// Page shape: accounts header (Financy snapshot) → filters → period summary
// (CSS bar rows) → ledger table with "load more" → events (last 50) →
// open findings. Everything loads through server actions that re-check the
// step-up; the bearer token never reaches this component.

// ---------- formatting ----------

const moneyFormatters = new Map<string, Intl.NumberFormat>();

/** ILS with thousands separators and 2 decimals; other ISO codes the same way. */
export function formatMoney(amount: number | null | undefined, currency: string | null | undefined): string {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return "—";
  const code = (currency ?? "ILS").toUpperCase();
  let fmt = moneyFormatters.get(code);
  if (!fmt) {
    try {
      fmt = new Intl.NumberFormat("en-IL", { style: "currency", currency: code, minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } catch {
      fmt = new Intl.NumberFormat("en-IL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    moneyFormatters.set(code, fmt);
  }
  return fmt.format(amount);
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("en-GB", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return formatDateTime(iso);
}

/** "2026-09-01" → "1 Sep 2026" without timezone shifts. */
function formatYmd(ymd: string | null): string {
  if (!ymd) return "unknown";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return ymd;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

function connectorLabel(connectors: FinanceConnector[], id: string): string {
  return connectors.find((c) => c.id === id)?.label.split(" (")[0] ?? id;
}

type Notice = { kind: "ok" | "error"; text: string } | null;

function NoticeLine({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return (
    <p className={`text-xs mt-2 ${notice.kind === "ok" ? "text-green-700" : "text-red-600"}`} role={notice.kind === "error" ? "alert" : "status"}>
      {notice.text}
    </p>
  );
}

function SectionTitle({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 mb-3">
      <h2 className="text-base font-semibold">{children}</h2>
      {aside && <span className="text-xs text-gray-400">{aside}</span>}
    </div>
  );
}

// ---------- accounts header ----------

const CONNECTION_STATUS_VARIANT: Record<string, "success" | "destructive" | "warning" | "secondary"> = {
  ACTIVE: "success",
  active: "success",
  ok: "success",
  ERROR: "destructive",
  error: "destructive",
  DISCONNECTED: "warning",
};

function AccountCard({ account }: { account: SnapshotAccount }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">
          {account.accountType ?? "Account"}
          {account.last4 && <span className="text-gray-500 font-normal"> ····{account.last4}</span>}
        </span>
        <span className="text-xs text-gray-400">{account.providerId ?? ""}</span>
      </div>
      <div className="mt-1 text-sm">
        {account.balances.length === 0 ? (
          <span className="text-gray-400">no balance reported</span>
        ) : (
          account.balances.map((b, i) => (
            <div key={i} className="flex justify-between gap-2">
              <span className="text-gray-500 text-xs">{b.type ?? "balance"}</span>
              <span className="tabular-nums">{formatMoney(b.amount, b.currency ?? account.currency)}</span>
            </div>
          ))
        )}
      </div>
      {account.currency && <div className="mt-1 text-[11px] text-gray-400">{account.currency}</div>}
    </div>
  );
}

function ConnectionLine({ connection }: { connection: SnapshotConnection }) {
  const status = connection.status ?? "unknown";
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-600">
      <span className="font-medium text-gray-800">{connection.providerId ?? connection.id}</span>
      <Badge variant={connection.hasError ? "destructive" : (CONNECTION_STATUS_VARIANT[status] ?? "secondary")}>{status}</Badge>
      <span>Financy fetched {formatWhen(connection.lastFetchedAt)}</span>
      <span>data through {formatYmd(connection.dataThrough)}</span>
    </li>
  );
}

function AccountsPanel({ overview, onSynced }: { overview: FinanceOverview; onSynced: () => void }) {
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const financy = overview.connectors.find((c) => c.id === FINANCY_ID);
  const accounts = overview.connectors.flatMap((c) => c.snapshot.accounts);
  const connections = overview.connectors.flatMap((c) => c.snapshot.connections);

  async function sync() {
    setSyncing(true);
    setNotice(null);
    const res = await syncFinancyNow();
    if (res.ok) {
      const counts = res.counts ? Object.entries(res.counts).map(([k, v]) => `${k} ${String(v)}`).join(", ") : "";
      setNotice({ kind: "ok", text: `Sync ran${counts ? `: ${counts}` : ""}` });
      onSynced();
    } else {
      setNotice({ kind: "error", text: res.error ?? "Sync failed" });
    }
    setSyncing(false);
  }

  return (
    <section className="rounded-lg border border-gray-200 bg-gray-50 p-4 mb-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Accounts</h2>
          <p className="text-sm text-gray-600 mt-0.5">
            Financy data through <span className="font-medium">{formatYmd(overview.data_through)}</span>
            {financy?.snapshot.accounts_fetched_at && (
              <span className="text-gray-400"> · accounts read {formatWhen(financy.snapshot.accounts_fetched_at)}</span>
            )}
            {financy?.last_success_at && <span className="text-gray-400"> · last pull {formatWhen(financy.last_success_at)}</span>}
          </p>
          {financy?.last_error && <p className="text-xs text-red-600 mt-1">Last error: {financy.last_error}</p>}
        </div>
        <div className="text-right">
          <Button size="sm" variant="secondary" onClick={sync} disabled={syncing || !overview.mcpAvailable || !financy?.has_credentials}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1 ${syncing ? "animate-spin" : ""}`} />
            Sync Financy now
          </Button>
          <NoticeLine notice={notice} />
        </div>
      </div>

      {connections.length > 0 && (
        <ul className="mt-3 space-y-1">
          {connections.map((c) => (
            <ConnectionLine key={c.id} connection={c} />
          ))}
        </ul>
      )}

      {accounts.length === 0 ? (
        <p className="mt-3 text-sm text-gray-400">
          {financy?.has_credentials ? "No accounts recorded yet. Run a sync." : "Financy is not configured. Set it up under Settings → Connectors."}
        </p>
      ) : (
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {accounts.map((a) => (
            <AccountCard key={a.id} account={a} />
          ))}
        </div>
      )}
    </section>
  );
}

// ---------- filters ----------

function FiltersBar({
  connectors,
  value,
  onApply,
  busy,
}: {
  connectors: FinanceConnector[];
  value: LedgerFilters;
  onApply: (f: LedgerFilters) => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState<LedgerFilters>(value);
  useEffect(() => setDraft(value), [value]);

  return (
    <form
      className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-white p-3 mb-4"
      onSubmit={(e) => {
        e.preventDefault();
        onApply({ ...draft, account_last4: draft.account_last4?.trim() || undefined, merchant: draft.merchant?.trim() || undefined });
      }}
    >
      <div>
        <Label htmlFor="period" className="text-xs">Period</Label>
        <select
          id="period"
          className="mt-1 block h-8 rounded-md border border-gray-300 bg-white px-2 text-sm"
          value={draft.period}
          onChange={(e) => setDraft({ ...draft, period: Number(e.target.value) as PeriodDays })}
        >
          {PERIOD_OPTIONS.map((p) => (
            <option key={p} value={p}>
              last {p} days
            </option>
          ))}
        </select>
      </div>
      <div>
        <Label htmlFor="connector" className="text-xs">Connector</Label>
        <select
          id="connector"
          className="mt-1 block h-8 rounded-md border border-gray-300 bg-white px-2 text-sm"
          value={draft.connector_id ?? ""}
          onChange={(e) => setDraft({ ...draft, connector_id: e.target.value || undefined })}
        >
          <option value="">all</option>
          {connectors.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label.split(" (")[0]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <Label htmlFor="last4" className="text-xs">Account last 4</Label>
        <Input
          id="last4"
          className="mt-1 h-8 w-24"
          inputMode="numeric"
          maxLength={4}
          placeholder="0034"
          value={draft.account_last4 ?? ""}
          onChange={(e) => setDraft({ ...draft, account_last4: e.target.value.replace(/\D+/g, "").slice(0, 4) })}
        />
      </div>
      <div>
        <Label htmlFor="kind" className="text-xs">Kind</Label>
        <select
          id="kind"
          className="mt-1 block h-8 rounded-md border border-gray-300 bg-white px-2 text-sm"
          value={draft.kind ?? ""}
          onChange={(e) => setDraft({ ...draft, kind: (e.target.value || undefined) as LedgerKindFilter | undefined })}
        >
          <option value="">charges and refunds</option>
          <option value="charge">charges</option>
          <option value="refund">refunds</option>
        </select>
      </div>
      <div className="min-w-[12rem] flex-1">
        <Label htmlFor="merchant" className="text-xs">Merchant contains</Label>
        <Input
          id="merchant"
          className="mt-1 h-8"
          dir="auto"
          maxLength={120}
          placeholder="e.g. Shufersal"
          value={draft.merchant ?? ""}
          onChange={(e) => setDraft({ ...draft, merchant: e.target.value })}
        />
      </div>
      <Button type="submit" size="sm" disabled={busy}>
        Apply
      </Button>
    </form>
  );
}

// ---------- summary ----------

function Bars({ rows, currency }: { rows: BarRow[]; currency: string }) {
  if (rows.length === 0) return <p className="text-xs text-gray-400">nothing in this period</p>;
  const max = Math.max(...rows.map((r) => Math.abs(r.total)), 1);
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => (
        <li key={r.label} className="text-xs">
          <div className="flex justify-between gap-2">
            <span dir="auto" className="truncate" title={r.label}>
              {r.label} <span className="text-gray-400">({r.count})</span>
            </span>
            <span className="tabular-nums shrink-0">{formatMoney(r.total, currency)}</span>
          </div>
          <div className="mt-0.5 h-1.5 w-full rounded bg-gray-100">
            <div
              className={`h-1.5 rounded ${r.total < 0 ? "bg-green-400" : "bg-blue-400"}`}
              style={{ width: `${Math.max(2, Math.round((Math.abs(r.total) / max) * 100))}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "charge" | "refund" }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${tone === "refund" ? "text-green-700" : tone === "charge" ? "text-gray-900" : ""}`}>{value}</div>
    </div>
  );
}

function SummarySection({ summary, period, loading }: { summary: LedgerSummary | null; period: PeriodDays; loading: boolean }) {
  return (
    <section className="mb-6">
      <SectionTitle
        aside={
          summary
            ? `${summary.rows_considered} rows${summary.partial ? " (first 1000 only)" : ""}${loading ? " · updating" : ""}`
            : loading
              ? "computing"
              : undefined
        }
      >
        Last {period} days
      </SectionTitle>
      {!summary ? (
        <p className="text-sm text-gray-400">{loading ? "Computing summary..." : "No summary available."}</p>
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-3 mb-4">
            <Stat label="Charges" value={formatMoney(summary.charges, summary.currency)} tone="charge" />
            <Stat label="Refunds" value={formatMoney(summary.refunds, summary.currency)} tone="refund" />
            <Stat label="Transactions" value={String(summary.count)} />
          </div>
          {Object.keys(summary.other_currencies).length > 0 && (
            <p className="text-xs text-gray-500 mb-3">
              Other currencies (net):{" "}
              {Object.entries(summary.other_currencies)
                .map(([c, v]) => formatMoney(v, c))
                .join(", ")}
            </p>
          )}
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-lg border border-gray-200 bg-white p-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Top merchants</h3>
              <Bars rows={summary.top_merchants} currency={summary.currency} />
            </div>
            <div className="rounded-lg border border-gray-200 bg-white p-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">By category</h3>
              <Bars rows={summary.by_category} currency={summary.currency} />
            </div>
            <div className="rounded-lg border border-gray-200 bg-white p-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">By account</h3>
              <Bars rows={summary.by_account} currency={summary.currency} />
            </div>
          </div>
        </>
      )}
    </section>
  );
}

// ---------- ledger ----------

function LedgerTable({
  rows,
  connectors,
  knownMerchants,
  onKnown,
}: {
  rows: LedgerRow[];
  connectors: FinanceConnector[];
  knownMerchants: string[];
  onKnown: (merchant: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const known = new Set(knownMerchants.map((m) => m.toLowerCase()));

  async function mark(row: LedgerRow) {
    const merchant = rowMerchant(row);
    if (!merchant) return;
    setBusy(row.id);
    setNotice(null);
    const res = await markMerchantKnown(merchant);
    if (res.ok) {
      setNotice({ kind: "ok", text: `"${merchant}" added to known merchants` });
      onKnown(merchant);
    } else {
      setNotice({ kind: "error", text: res.error ?? "Could not save" });
    }
    setBusy(null);
  }

  if (rows.length === 0) return <p className="text-sm text-gray-400">No ledger rows match.</p>;

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-xs text-gray-500">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Date</th>
            <th className="px-3 py-2 text-left font-medium">Merchant</th>
            <th className="px-3 py-2 text-left font-medium">Category</th>
            <th className="px-3 py-2 text-left font-medium">Account</th>
            <th className="px-3 py-2 text-left font-medium">Source</th>
            <th className="px-3 py-2 text-right font-medium">Amount</th>
            <th className="px-3 py-2 text-right font-medium"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((row) => {
            const merchant = rowMerchant(row);
            const memo = rowMemo(row);
            const isKnown = merchant ? known.has(merchant.toLowerCase()) : false;
            const refund = row.kind === "refund";
            return (
              <tr key={row.id} className="align-top">
                <td className="px-3 py-2 whitespace-nowrap tabular-nums text-gray-600">{formatDate(row.occurred_at)}</td>
                <td className="px-3 py-2 max-w-[18rem]">
                  <div dir="auto" className="truncate" title={merchant ?? undefined}>
                    {merchant ?? <span className="text-gray-400">(no merchant)</span>}
                  </div>
                  {memo && (
                    <div dir="auto" className="text-xs text-gray-400 truncate" title={memo}>
                      {memo}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-gray-600" dir="auto">{rowCategoryMain(row) ?? "—"}</td>
                <td className="px-3 py-2 tabular-nums text-gray-600">{row.account_ref ? `····${row.account_ref.slice(-4)}` : "—"}</td>
                <td className="px-3 py-2 text-gray-500 text-xs">{connectorLabel(connectors, row.connector_id)}</td>
                <td className={`px-3 py-2 text-right tabular-nums whitespace-nowrap ${refund ? "text-green-700" : ""}`}>
                  {refund ? "+" : ""}
                  {formatMoney(row.amount, row.currency)}
                  {row.kind !== "charge" && row.kind !== "refund" && <span className="ml-1 text-xs text-gray-400">{row.kind}</span>}
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  {merchant && !isKnown && (
                    <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={busy === row.id} onClick={() => mark(row)}>
                      Mark known
                    </Button>
                  )}
                  {merchant && isKnown && <span className="text-xs text-gray-400">known</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="px-3 pb-2">
        <NoticeLine notice={notice} />
      </div>
    </div>
  );
}

// ---------- events ----------

function eventDescription(ev: EventRow): { text: string; muted: boolean } {
  if (ev.kind === "otp") return { text: "one-time code", muted: true };
  if (ev.kind === "unknown") {
    const title = eventTitle(ev);
    return { text: `unclassified${title ? ` · ${title}` : ""}`, muted: true };
  }
  return { text: ev.merchant ?? eventTitle(ev) ?? ev.kind, muted: !ev.merchant };
}

const EVENT_STATUS_VARIANT: Record<string, "success" | "warning" | "secondary"> = {
  matched: "success",
  open: "warning",
  expired: "secondary",
};

function EventsPanel({ events, connectors }: { events: EventRow[]; connectors: FinanceConnector[] }) {
  return (
    <section className="mb-6">
      <SectionTitle aside={`last ${events.length}`}>Phone events</SectionTitle>
      {events.length === 0 ? (
        <p className="text-sm text-gray-400">No connector events yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">When</th>
                <th className="px-3 py-2 text-left font-medium">Connector</th>
                <th className="px-3 py-2 text-left font-medium">Kind</th>
                <th className="px-3 py-2 text-left font-medium">Merchant</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {events.map((ev) => {
                const d = eventDescription(ev);
                return (
                  <tr key={ev.id}>
                    <td className="px-3 py-2 whitespace-nowrap tabular-nums text-gray-600">{formatDateTime(ev.occurred_at)}</td>
                    <td className="px-3 py-2 text-gray-600">{connectorLabel(connectors, ev.connector_id)}</td>
                    <td className="px-3 py-2 text-gray-600">{ev.kind}</td>
                    <td className={`px-3 py-2 max-w-[18rem] truncate ${d.muted ? "text-gray-400" : ""}`} dir="auto" title={d.text}>
                      {d.text}
                      {ev.account_ref && <span className="ml-1 text-xs text-gray-400">····{ev.account_ref.slice(-4)}</span>}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                      {ev.amount != null ? formatMoney(ev.amount, ev.currency) : ""}
                      {ev.foreign && <span className="ml-1 text-xs text-amber-700">foreign</span>}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant={EVENT_STATUS_VARIANT[ev.status] ?? "secondary"}>{ev.status}</Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------- findings ----------

function FindingsPanel({ findings, onResolved }: { findings: Finding[]; onResolved: (id: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  async function resolve(f: Finding) {
    setBusy(f.id);
    setNotice(null);
    const res = await resolveFindingAction(f.id, "Resolved from the finance page");
    if (res.ok) onResolved(f.id);
    else setNotice({ kind: "error", text: res.error ?? "Could not resolve" });
    setBusy(null);
  }

  return (
    <section className="mb-6">
      <SectionTitle aside="open, this week's digest">Findings</SectionTitle>
      {findings.length === 0 ? (
        <p className="text-sm text-gray-400">No open findings.</p>
      ) : (
        <ul className="space-y-2">
          {findings.map((f) => (
            <li key={f.id} className="flex items-start justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-xs text-amber-800">
                  <span className="font-medium">{f.connector_label.split(" (")[0]}</span>
                  <Badge variant="warning">{f.kind}</Badge>
                  <span className="text-amber-700/70">{formatWhen(f.opened_at)}</span>
                </div>
                <p className="mt-1 text-sm text-gray-800" dir="auto">
                  {f.summary}
                </p>
              </div>
              <Button size="sm" variant="secondary" disabled={busy === f.id} onClick={() => resolve(f)}>
                Resolve
              </Button>
            </li>
          ))}
        </ul>
      )}
      <NoticeLine notice={notice} />
    </section>
  );
}

// ---------- page ----------

export function FinanceView() {
  const [overview, setOverview] = useState<FinanceOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [filters, setFilters] = useState<LedgerFilters>({ period: DEFAULT_PERIOD });
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hiddenByAccount, setHiddenByAccount] = useState(0);
  const [ledgerLoading, setLedgerLoading] = useState(true);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  const [summary, setSummary] = useState<LedgerSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);

  const loadOverview = useCallback(async () => {
    setOverviewLoading(true);
    try {
      setOverview(await fetchFinanceOverview());
    } finally {
      setOverviewLoading(false);
    }
  }, []);

  const loadLedger = useCallback(async (f: LedgerFilters) => {
    setLedgerLoading(true);
    setSummaryLoading(true);
    setLedgerError(null);
    setRows([]);
    setNextCursor(null);
    setHiddenByAccount(0);
    const [page, sum] = await Promise.all([fetchLedgerPage(f, null), fetchLedgerSummary(f)]);
    if (page.ok) {
      setRows(page.rows);
      setNextCursor(page.next_cursor);
      setHiddenByAccount(page.hidden_by_account);
    } else {
      setLedgerError(page.error);
    }
    setSummary(sum.ok ? sum.summary : null);
    if (!sum.ok && !page.ok) setLedgerError(page.ok ? sum.error : page.error);
    setLedgerLoading(false);
    setSummaryLoading(false);
  }, []);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    loadLedger(filters);
  }, [filters, loadLedger]);

  async function loadMore() {
    if (!nextCursor) return;
    setLedgerLoading(true);
    const page = await fetchLedgerPage(filters, nextCursor);
    if (page.ok) {
      setRows((prev) => [...prev, ...page.rows]);
      setNextCursor(page.next_cursor);
      setHiddenByAccount((h) => h + page.hidden_by_account);
    } else {
      setLedgerError(page.error);
    }
    setLedgerLoading(false);
  }

  function refreshAll() {
    loadOverview();
    loadLedger(filters);
  }

  const connectors = overview?.connectors ?? [];

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            Finance
            <Lock className="h-4 w-4 text-gray-400" aria-label="Sensitive page" />
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Accounts, ledger and card events from the connectors service. Read-only apart from known merchants, findings and a manual Financy sync.
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={refreshAll} disabled={overviewLoading || ledgerLoading} aria-label="Refresh">
          <RefreshCw className={`h-4 w-4 ${overviewLoading || ledgerLoading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {overview && !overview.mcpAvailable && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            The connectors service did not answer. Accounts, ledger, events and findings are unavailable until it is back.
            {overview.errors.length > 0 && <span className="block text-xs mt-1 text-amber-700/80">{overview.errors.join(" · ")}</span>}
          </span>
        </div>
      )}
      {overview && overview.mcpAvailable && overview.errors.length > 0 && (
        <p className="mb-4 text-xs text-amber-700">Some data did not load: {overview.errors.join(" · ")}</p>
      )}

      {!overview ? (
        <p className="text-sm text-gray-400">Loading...</p>
      ) : (
        <AccountsPanel overview={overview} onSynced={refreshAll} />
      )}

      <FiltersBar connectors={connectors} value={filters} onApply={setFilters} busy={ledgerLoading} />

      <SummarySection summary={summary} period={filters.period} loading={summaryLoading} />

      <section className="mb-6">
        <SectionTitle
          aside={
            rows.length > 0
              ? `${rows.length} shown${hiddenByAccount > 0 ? ` · ${hiddenByAccount} hidden by account filter` : ""}`
              : undefined
          }
        >
          Ledger
        </SectionTitle>
        {ledgerError && (
          <p className="mb-2 text-sm text-red-600" role="alert">
            {ledgerError}
          </p>
        )}
        {ledgerLoading && rows.length === 0 ? (
          <p className="text-sm text-gray-400">Loading ledger...</p>
        ) : (
          <LedgerTable
            rows={rows}
            connectors={connectors}
            knownMerchants={overview?.known_merchants ?? []}
            onKnown={(m) => setOverview((o) => (o ? { ...o, known_merchants: [...o.known_merchants, m] } : o))}
          />
        )}
        {nextCursor && (
          <div className="mt-3">
            <Button size="sm" variant="secondary" onClick={loadMore} disabled={ledgerLoading}>
              {ledgerLoading ? "Loading..." : "Load more"}
            </Button>
          </div>
        )}
      </section>

      {overview && <EventsPanel events={overview.events} connectors={connectors} />}

      {overview && (
        <FindingsPanel
          findings={overview.findings}
          onResolved={(id) => setOverview((o) => (o ? { ...o, findings: o.findings.filter((f) => f.id !== id) } : o))}
        />
      )}
    </div>
  );
}
