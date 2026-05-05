"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowLeft,
  Sparkles,
  Lock,
  User as UserIcon,
  MapPin,
  Users,
  Tag,
  CheckCircle2,
  RotateCcw,
  Pause,
} from "lucide-react";
import {
  closeNarrative,
  reopenNarrative,
  setDormant,
  type Narrative,
  type Observation,
  type SubjectRef,
  type SubjectKind,
} from "../narratives-server-actions";

const KIND_ICON: Record<SubjectKind, React.ComponentType<{ className?: string }>> = {
  person: UserIcon,
  place: MapPin,
  group: Users,
  topic: Tag,
};

const STATUS_VARIANT: Record<string, "default" | "secondary" | "success" | "warning" | "outline"> = {
  active: "success",
  dormant: "secondary",
  closed: "outline",
};

const SOURCE_VARIANT: Record<string, "default" | "secondary" | "success" | "warning" | "outline"> = {
  whatsapp: "success",
  telegram: "default",
  chat: "default",
  system: "secondary",
  journal: "warning",
  inference: "outline",
  user_statement: "default",
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface NarrativeDetailViewProps {
  subject: SubjectRef;
  initial: { narrative: Narrative | null; observations: Observation[] };
}

export function NarrativeDetailView({ subject, initial }: NarrativeDetailViewProps) {
  const [narrative, setNarrative] = useState<Narrative | null>(initial.narrative);
  const observations = initial.observations;
  const [closeReason, setCloseReason] = useState("");
  const [showCloseForm, setShowCloseForm] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const Icon = KIND_ICON[subject.kind];

  function doClose() {
    if (!closeReason.trim()) {
      setError("Reason required to close");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await closeNarrative(subject, closeReason);
        if (narrative) setNarrative({ ...narrative, status: "closed", closedReason: closeReason });
        setShowCloseForm(false);
        setCloseReason("");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  function doReopen() {
    setError(null);
    startTransition(async () => {
      try {
        await reopenNarrative(subject);
        if (narrative) setNarrative({ ...narrative, status: "active" });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  function doDormant() {
    setError(null);
    startTransition(async () => {
      try {
        await setDormant(subject);
        if (narrative) setNarrative({ ...narrative, status: "dormant" });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  if (!narrative && observations.length === 0) {
    return (
      <Card>
        <CardContent className="p-12 text-center text-gray-500">
          <Sparkles className="h-8 w-8 mx-auto mb-3 text-gray-300" />
          <p>No narrative or observations exist for this subject yet.</p>
          <Link href="/narratives" className="inline-block mt-4">
            <Button variant="outline" size="sm">
              <ArrowLeft className="h-4 w-4 mr-1" />
              Back to narratives
            </Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <Link href="/narratives">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back
          </Button>
        </Link>
        <div className="flex items-center gap-2">
          {narrative && narrative.status === "active" && (
            <Button variant="outline" size="sm" onClick={doDormant} disabled={pending}>
              <Pause className="h-4 w-4 mr-1" />
              Mark dormant
            </Button>
          )}
          {narrative && narrative.status !== "closed" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowCloseForm((s) => !s)}
              disabled={pending}
            >
              <CheckCircle2 className="h-4 w-4 mr-1" />
              Close
            </Button>
          )}
          {narrative && narrative.status !== "active" && (
            <Button variant="outline" size="sm" onClick={doReopen} disabled={pending}>
              <RotateCcw className="h-4 w-4 mr-1" />
              Reopen
            </Button>
          )}
        </div>
      </div>

      {showCloseForm && narrative && (
        <Card>
          <CardContent className="p-4 space-y-2">
            <div className="text-sm font-semibold">Close this narrative</div>
            <Textarea
              value={closeReason}
              onChange={(e) => setCloseReason(e.target.value)}
              placeholder="Why is this thread done? (e.g. 'Tamar's pregnancy ended — baby born; new narrative for the baby')"
              rows={3}
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={doClose} disabled={pending || !closeReason.trim()}>
                Confirm close
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowCloseForm(false)}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {error && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded p-3">
          {error}
        </div>
      )}

      {narrative ? (
        <Card>
          <CardContent className="p-6 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2 min-w-0">
                <Icon className="h-5 w-5 text-gray-400 mt-1 shrink-0" />
                <div className="min-w-0">
                  <h2 className="text-xl font-bold">{narrative.title}</h2>
                  <div className="text-xs text-gray-500">
                    {subject.kind}:{subject.ref}
                  </div>
                </div>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                <Badge variant={STATUS_VARIANT[narrative.status] ?? "default"}>
                  {narrative.status}
                </Badge>
                {narrative.sensitive && (
                  <Badge variant="outline" className="text-amber-700 border-amber-300">
                    <Lock className="h-3 w-3 mr-1" />
                    sensitive
                  </Badge>
                )}
                {narrative.currentMood && (
                  <Badge variant="secondary" className="italic">
                    {narrative.currentMood}
                  </Badge>
                )}
              </div>
            </div>

            {narrative.summary && (
              <div className="prose prose-sm max-w-none whitespace-pre-line">
                {narrative.summary}
              </div>
            )}
            {!narrative.summary && (
              <p className="text-sm text-gray-400 italic">
                No summary yet — {narrative.observationCount} observations accumulated.
              </p>
            )}

            {narrative.openThreads.length > 0 && (
              <div>
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                  Open threads
                </div>
                <ul className="text-sm space-y-1 list-disc pl-5">
                  {narrative.openThreads.map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ul>
              </div>
            )}

            {narrative.recentDecisions.length > 0 && (
              <div>
                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                  Recent decisions
                </div>
                <ul className="text-sm space-y-1">
                  {narrative.recentDecisions.map((d, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="text-xs text-gray-400 shrink-0">{formatTime(d.observedAt)}</span>
                      <span>{d.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {narrative.status === "closed" && narrative.closedReason && (
              <div className="text-sm border-l-2 border-gray-300 pl-3 text-gray-600 italic">
                Closed: {narrative.closedReason}
              </div>
            )}

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs text-gray-500 pt-2 border-t">
              <div>
                <div className="font-semibold text-gray-700">Observations</div>
                <div>{narrative.observationCount}</div>
              </div>
              <div>
                <div className="font-semibold text-gray-700">First seen</div>
                <div>{narrative.firstObservedAt ? formatTime(narrative.firstObservedAt) : "—"}</div>
              </div>
              <div>
                <div className="font-semibold text-gray-700">Last seen</div>
                <div>{narrative.lastObservedAt ? formatTime(narrative.lastObservedAt) : "—"}</div>
              </div>
              <div>
                <div className="font-semibold text-gray-700">Last consolidated</div>
                <div>{narrative.lastConsolidatedAt ? formatTime(narrative.lastConsolidatedAt) : "never"}</div>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-6">
            <div className="flex items-start gap-2">
              <Icon className="h-5 w-5 text-gray-400 mt-1 shrink-0" />
              <div>
                <h2 className="text-xl font-bold">No narrative yet</h2>
                <div className="text-xs text-gray-500">
                  {subject.kind}:{subject.ref}
                </div>
                <p className="text-sm text-gray-600 mt-2">
                  {observations.length} observation{observations.length === 1 ? "" : "s"} are accumulated for this subject. Ask the agent to consolidate them into a narrative.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-6">
          <h3 className="text-lg font-semibold mb-4">
            Observations
            <span className="text-sm font-normal text-gray-500 ml-2">
              ({observations.length}, newest first)
            </span>
          </h3>
          <ul className="space-y-3">
            {observations.map((o) => (
              <li key={o.id} className="border-l-2 border-gray-200 pl-3 space-y-1">
                <div className="flex items-center gap-2 text-xs text-gray-500">
                  <span>{formatTime(o.observedAt)}</span>
                  <Badge variant={SOURCE_VARIANT[o.source] ?? "outline"} className="text-[10px]">
                    {o.source}
                  </Badge>
                  <span>·</span>
                  <span>{o.confidence}</span>
                  {o.mood && <span className="italic">· {o.mood}</span>}
                  {o.sensitive && (
                    <Badge variant="outline" className="text-amber-700 border-amber-300 text-[10px]">
                      <Lock className="h-3 w-3 mr-1" />
                      sensitive
                    </Badge>
                  )}
                </div>
                <div className="text-sm whitespace-pre-line">{o.text}</div>
                {o.sourceExcerpt && (
                  <div className="text-xs text-gray-500 italic border-l-2 border-gray-100 pl-2">
                    &ldquo;{o.sourceExcerpt}&rdquo;
                  </div>
                )}
              </li>
            ))}
            {observations.length === 0 && (
              <li className="text-sm text-gray-400 italic">No observations yet.</li>
            )}
          </ul>
        </CardContent>
      </Card>
    </>
  );
}
