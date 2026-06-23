"use client";

import { useEffect, useRef, useState, useTransition } from "react";
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
  Network,
  Clock,
  Loader2,
  Wand2,
} from "lucide-react";
import {
  closeNarrative,
  reopenNarrative,
  setDormant,
  requestNarrativeSummary,
  type Narrative,
  type Observation,
  type SubjectRef,
  type SubjectKind,
  type NarrativeConnections,
} from "../narratives-server-actions";
import { NarrativeGraph } from "../narrative-graph";
import { NarrativeTimeline } from "../narrative-timeline";

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
  /** Connection map for the graph. Null while loading or unavailable. */
  connections?: NarrativeConnections | null;
  /** "page" shows the Back link + outer wrapper; "pane" is the embedded right-pane form. */
  variant?: "page" | "pane";
  /** Selecting a related narrative node in the graph (pane mode). */
  onSelectRelated?: (subject: SubjectRef) => void;
  /** Narrow-screen back affordance in pane mode. */
  onBack?: () => void;
}

// ---------------------------------------------------------------------------
// "Fresh take" — ephemeral agent summary delivered over the chat SSE stream
// ---------------------------------------------------------------------------

type FreshTakeState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "ready"; text: string }
  | { status: "timeout" }
  | { status: "error"; message: string };

function FreshTakeCard({ state, onDismiss }: { state: FreshTakeState; onDismiss: () => void }) {
  if (state.status === "idle") return null;
  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardContent className="p-4 space-y-1">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-primary">
            <Wand2 className="h-3.5 w-3.5" />
            Fresh take · just now
          </div>
          <button
            onClick={onDismiss}
            className="text-xs text-gray-400 hover:text-gray-700"
            aria-label="Dismiss fresh take"
          >
            dismiss
          </button>
        </div>
        {state.status === "pending" && (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Asking the agent for a point-in-time read…
          </div>
        )}
        {state.status === "ready" && (
          <div className="text-sm whitespace-pre-line text-gray-800">{state.text}</div>
        )}
        {state.status === "timeout" && (
          <div className="text-sm text-gray-600">Requested — it&apos;ll appear in your chat.</div>
        )}
        {state.status === "error" && (
          <div className="text-sm text-red-600">{state.message}</div>
        )}
      </CardContent>
    </Card>
  );
}

export function NarrativeDetailView({
  subject,
  initial,
  connections = null,
  variant = "page",
  onSelectRelated,
  onBack,
}: NarrativeDetailViewProps) {
  const [narrative, setNarrative] = useState<Narrative | null>(initial.narrative);
  const observations = initial.observations;
  const [closeReason, setCloseReason] = useState("");
  const [showCloseForm, setShowCloseForm] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Reset local mutable state whenever the subject changes (pane re-use).
  useEffect(() => {
    setNarrative(initial.narrative);
    setCloseReason("");
    setShowCloseForm(false);
    setError(null);
  }, [initial.narrative, subject.kind, subject.ref]);

  // ---- Fresh-take (Summarize now) ------------------------------------------
  const [freshTake, setFreshTake] = useState<FreshTakeState>({ status: "idle" });
  const esRef = useRef<EventSource | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestAtRef = useRef(0);

  function cleanupListener() {
    esRef.current?.close();
    esRef.current = null;
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }

  // Tear down the SSE listener + timer on unmount or subject change.
  useEffect(() => {
    return () => cleanupListener();
  }, [subject.kind, subject.ref]);

  // Reset the fresh take when navigating to a different subject.
  useEffect(() => {
    cleanupListener();
    setFreshTake({ status: "idle" });
  }, [subject.kind, subject.ref]);

  async function doSummarize() {
    if (freshTake.status === "pending") return;
    cleanupListener();
    setFreshTake({ status: "pending" });
    requestAtRef.current = Date.now();

    const res = await requestNarrativeSummary(subject);
    if (res.error) {
      setFreshTake({ status: "error", message: res.error });
      return;
    }

    // Listen for the next assistant reply on the chat stream. The ephemeral
    // summary lands as a normal assistant new_message; we accept the first
    // assistant message created after we fired the request.
    const es = new EventSource("/api/chat/listen");
    esRef.current = es;
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "connected" || data.type === "error") return;
        if (data.event !== "new_message" && data.event !== undefined) return;
        if (data.role !== "assistant") return;
        if (!data.content) return;
        // Only accept messages created after the request fired (skip backfill).
        const created = data.created_at ? new Date(data.created_at).getTime() : Date.now();
        if (created < requestAtRef.current - 2000) return;
        setFreshTake({ status: "ready", text: String(data.content) });
        cleanupListener();
      } catch {
        /* ignore malformed frames */
      }
    };
    es.onerror = () => {
      /* EventSource auto-reconnects; the timeout below is the real backstop. */
    };

    timeoutRef.current = setTimeout(() => {
      setFreshTake((prev) => (prev.status === "pending" ? { status: "timeout" } : prev));
      cleanupListener();
    }, 60_000);
  }

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
      <div className="space-y-4">
        {variant === "pane" && onBack && (
          <Button variant="ghost" size="sm" onClick={onBack} className="lg:hidden">
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back to list
          </Button>
        )}
        <Card>
          <CardContent className="p-12 text-center text-gray-500">
            <Sparkles className="h-8 w-8 mx-auto mb-3 text-gray-300" />
            <p>No narrative or observations exist for this subject yet.</p>
            {variant === "page" && (
              <Link href="/narratives" className="inline-block mt-4">
                <Button variant="outline" size="sm">
                  <ArrowLeft className="h-4 w-4 mr-1" />
                  Back to narratives
                </Button>
              </Link>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        {variant === "page" ? (
          <Link href="/narratives">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4 mr-1" />
              Back
            </Button>
          </Link>
        ) : onBack ? (
          <Button variant="ghost" size="sm" onClick={onBack} className="lg:hidden">
            <ArrowLeft className="h-4 w-4 mr-1" />
            List
          </Button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <Button
            variant="default"
            size="sm"
            onClick={doSummarize}
            disabled={freshTake.status === "pending"}
            title="Ask the agent for a fresh point-in-time summary (delivered to your chat)"
          >
            {freshTake.status === "pending" ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <Wand2 className="h-4 w-4 mr-1" />
            )}
            Summarize now
          </Button>
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

      <FreshTakeCard state={freshTake} onDismiss={() => { cleanupListener(); setFreshTake({ status: "idle" }); }} />

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

      {/* Connection map */}
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center gap-2 mb-3">
            <Network className="h-4 w-4 text-gray-400" />
            <h3 className="text-lg font-semibold">Connections</h3>
            {connections && (
              <span className="text-sm font-normal text-gray-500">
                ({connections.entities.length} entit{connections.entities.length === 1 ? "y" : "ies"},{" "}
                {connections.related.length} related)
              </span>
            )}
          </div>
          <NarrativeGraph
            subject={subject}
            title={narrative?.title ?? `${subject.kind}:${subject.ref}`}
            connections={connections}
            onSelectRelated={onSelectRelated}
          />
        </CardContent>
      </Card>

      {/* Development timeline */}
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center gap-2 mb-4">
            <Clock className="h-4 w-4 text-gray-400" />
            <h3 className="text-lg font-semibold">Timeline</h3>
            <span className="text-sm font-normal text-gray-500">
              ({observations.length} observation{observations.length === 1 ? "" : "s"}, newest first)
            </span>
          </div>
          <NarrativeTimeline narrative={narrative} observations={observations} />
        </CardContent>
      </Card>
    </div>
  );
}
