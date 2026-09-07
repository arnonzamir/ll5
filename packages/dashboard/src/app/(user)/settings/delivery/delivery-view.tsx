"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, CheckCircle2, RefreshCw, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fetchDeliveryPage, resetDeliveryPolicy, type DeliveryPageData } from "./delivery-server-actions";
import {
  MODALITIES,
  MODALITY_LABEL,
  actedOnRate,
  parseBucketKey,
  pct,
  share,
  type DeliveryPolicy,
  type ModalityCounts,
  type StatsBucket,
} from "./delivery-types";

// Page shape: learned policy table, then the 14-day outcomes per bucket with
// small CSS bars, then the reset. Read-only apart from the reset (DECISION-034
// Section 6: the nightly pass owns the policy; the user can only start over).

function AmberLine({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="status"
      className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function KeyChips({ bucketKey }: { bucketKey: string }) {
  const k = parseBucketKey(bucketKey);
  const chip = "rounded border border-gray-200 bg-gray-50 px-1.5 py-px font-mono text-[11px] text-gray-700";
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className={chip} title="class">{k.cls}</span>
      <span className={chip} title="stakes">{k.stakes}</span>
      <span className={chip} title="deadline band">{k.deadline_band}</span>
      <span className={chip} title="delivery mode at send">{k.mode}</span>
    </span>
  );
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function PolicyTable({ policy }: { policy: DeliveryPolicy }) {
  const keys = Object.keys(policy.buckets);
  const ratePct = Math.round(policy.exploration_rate * 100);
  const oneIn = policy.exploration_rate > 0 ? Math.round(1 / policy.exploration_rate) : null;
  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600">
        Exploration rate {ratePct}%:{" "}
        {oneIn
          ? `on buckets with fewer than 20 samples, about one ask in ${oneIn} goes out one step louder or quieter than the preferred way, so the learning can tell what works; it decays as buckets fill.`
          : "exploration is off; every ask uses the preferred way."}
      </p>
      <p className="font-mono text-[11px] text-gray-500">
        version {policy.version} · updated {fmtWhen(policy.updated_at)} · {keys.length} bucket{keys.length === 1 ? "" : "s"}
      </p>
      {keys.length === 0 ? (
        <p className="text-sm text-gray-500">
          No buckets learned yet. Until the nightly pass writes some, the defaults apply: fyi stays in chat,
          needs-you goes out as a notify push, do-by as an alert.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-[11px] uppercase tracking-wide text-gray-500">
                <th className="py-1.5 pr-3 font-medium">Class</th>
                <th className="py-1.5 pr-3 font-medium">Stakes</th>
                <th className="py-1.5 pr-3 font-medium">Deadline</th>
                <th className="py-1.5 pr-3 font-medium">Mode</th>
                <th className="py-1.5 pr-3 font-medium">Preferred</th>
                <th className="py-1.5 pr-3 font-medium">Floor</th>
                <th className="py-1.5 pr-3 text-right font-medium">n</th>
                <th className="py-1.5 text-right font-medium">Score</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => {
                const k = parseBucketKey(key);
                const b = policy.buckets[key];
                return (
                  <tr key={key} className="border-b border-gray-100">
                    <td className="py-1.5 pr-3 font-mono text-[12px]">{k.cls}</td>
                    <td className="py-1.5 pr-3 font-mono text-[12px]">{k.stakes}</td>
                    <td className="py-1.5 pr-3 font-mono text-[12px]">{k.deadline_band}</td>
                    <td className="py-1.5 pr-3 font-mono text-[12px]">{k.mode}</td>
                    <td className="py-1.5 pr-3">{b.preferred}</td>
                    <td className="py-1.5 pr-3 text-gray-600">{b.floor ?? "-"}</td>
                    <td className="py-1.5 pr-3 text-right font-mono text-[12px]">{b.n}</td>
                    <td className="py-1.5 text-right font-mono text-[12px]">
                      {b.score === null ? "-" : b.score.toFixed(2)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ModalityRow({ modality, c }: { modality: string; c: ModalityCounts }) {
  const acted = actedOnRate(c);
  const dismissed = share(c.dismissed, c.sent);
  const missed = share(c.missed, c.sent);
  const w = (v: number | null) => `${Math.round((v ?? 0) * 100)}%`;
  const label = MODALITY_LABEL[modality as keyof typeof MODALITY_LABEL] ?? modality;
  return (
    <div className="grid grid-cols-[9rem_1fr_3.5rem] items-center gap-3 py-1 text-sm">
      <span className="truncate text-gray-700" title={modality}>{label}</span>
      <div className="space-y-1">
        <div
          className="flex h-2 w-full overflow-hidden rounded bg-gray-100"
          title={`acted on ${pct(acted)} · dismissed ${pct(dismissed)} · missed ${pct(missed)}`}
        >
          <div className="h-2 bg-emerald-500" style={{ width: w(acted) }} />
          <div className="h-2 bg-amber-400" style={{ width: w(dismissed) }} />
          <div className="h-2 bg-rose-400" style={{ width: w(missed) }} />
        </div>
        <p className="font-mono text-[10px] text-gray-500">
          sent {c.sent} · seen {c.seen} · acknowledged {c.acknowledged} · done by deadline {c.done_by_deadline} · dismissed{" "}
          {c.dismissed} · missed {c.missed}
          {c.too_much + c.not_enough > 0 && (
            <>
              {" "}· too much {c.too_much} · not enough {c.not_enough}
            </>
          )}
        </p>
      </div>
      <span className="text-right font-mono text-[12px] text-gray-800" title="acted on = acknowledged + done by deadline, over sent">
        {pct(acted)}
      </span>
    </div>
  );
}

function StatsBucketBlock({ bucket }: { bucket: StatsBucket }) {
  const present = MODALITIES.filter((m) => bucket.modalities[m]);
  return (
    <div className="rounded-md border border-gray-200 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <KeyChips bucketKey={bucket.key} />
        <span className="font-mono text-[11px] text-gray-500">{bucket.n} sent</span>
      </div>
      {present.length === 0 ? (
        <p className="text-sm text-gray-500">No modality breakdown.</p>
      ) : (
        present.map((m) => <ModalityRow key={m} modality={m} c={bucket.modalities[m]!} />)
      )}
    </div>
  );
}

export function DeliveryView() {
  const [data, setData] = useState<DeliveryPageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resetMsg, setResetMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchDeliveryPage());
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      setData({ policy: { ok: false, error }, stats: { ok: false, error } });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const doReset = () => {
    setConfirmOpen(false);
    startTransition(async () => {
      const res = await resetDeliveryPolicy();
      if (res.ok) {
        setResetMsg({ ok: true, text: "Learning reset. The defaults apply until the next nightly pass writes a new policy." });
        await load();
      } else {
        setResetMsg({ ok: false, text: `Reset failed: ${res.error}` });
      }
    });
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link href="/dashboard" className="mb-2 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800">
            <ArrowLeft className="h-4 w-4" /> Dashboard
          </Link>
          <h1 className="text-2xl font-semibold text-gray-900">What works for you</h1>
          <p className="mt-1 max-w-2xl text-sm text-gray-600">
            How your assistant reaches you is learned, not fixed: every classed message records how it went out and
            what you did with it, and a nightly pass turns that into a policy per situation. This page shows the
            policy and the last {data?.stats.ok ? data.stats.data.days : 14} days behind it.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Learned policy</CardTitle>
          <CardDescription>
            One row per situation: message class, stakes, how far the deadline was, and the delivery mode at the
            time. Preferred is the way it goes out; floor is the quietest it is allowed to be.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading && !data ? (
            <p className="text-sm text-gray-500">Loading…</p>
          ) : data?.policy.ok ? (
            data.policy.data ? (
              <PolicyTable policy={data.policy.data} />
            ) : (
              <p className="text-sm text-gray-500">
                Nothing learned yet. The defaults apply: fyi stays in chat, needs-you goes out as a notify push,
                do-by as an alert.
              </p>
            )
          ) : (
            <AmberLine>Policy unavailable: {data?.policy.ok === false ? data.policy.error : "unknown"}</AmberLine>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Last {data?.stats.ok ? data.stats.data.days : 14} days</CardTitle>
          <CardDescription>
            Per situation and per way of reaching you. The bar is the share acted on (green: acknowledged or done by
            the deadline), dismissed (amber) and missed (red), out of what was sent.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading && !data ? (
            <p className="text-sm text-gray-500">Loading…</p>
          ) : data?.stats.ok ? (
            data.stats.data.buckets.length === 0 ? (
              <p className="text-sm text-gray-500">No classed deliveries in this window.</p>
            ) : (
              data.stats.data.buckets.map((b) => <StatsBucketBlock key={b.key} bucket={b} />)
            )
          ) : (
            <AmberLine>Stats unavailable: {data?.stats.ok === false ? data.stats.error : "unknown"}</AmberLine>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reset learning</CardTitle>
          <CardDescription>
            Throws away every learned bucket and puts the exploration rate back to 35%. The 14-day record stays;
            the next nightly pass learns again from it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {resetMsg && (
            <p
              role="status"
              className={`flex items-center gap-2 text-sm ${resetMsg.ok ? "text-emerald-700" : "text-red-700"}`}
            >
              {resetMsg.ok ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
              {resetMsg.text}
            </p>
          )}
          <Button variant="outline" onClick={() => setConfirmOpen(true)} disabled={pending}>
            <RotateCcw className="h-4 w-4" />
            Reset learning
          </Button>
        </CardContent>
      </Card>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset what your assistant has learned?</DialogTitle>
            <DialogDescription>
              The policy goes back to empty (version 1, exploration 35%, no buckets). Messages use the class defaults
              until the nightly pass writes a new policy. This cannot be undone from here.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Keep it
            </Button>
            <Button variant="destructive" onClick={doReset} disabled={pending}>
              Reset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
