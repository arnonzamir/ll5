"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  AlertTriangle,
  Bot,
  KeyRound,
  Loader2,
  Play,
  RefreshCw,
  Server,
  Square,
  TerminalSquare,
} from "lucide-react";
import { ClaudeKeyForm } from "./claude-key-form";
import {
  fetchAgentModels,
  fetchAgentSessions,
  fetchConsoleUrl,
  fetchLlmCredential,
  fetchRuntime,
  provisionRuntime,
  stopRuntime,
} from "./agent-server-actions";
import {
  canProvision,
  canStop,
  isTransientRuntime,
  runtimeStatusBadge,
  type AgentModelsCatalog,
  type AgentRuntime,
  type LlmCredentialStatus,
} from "./agent-types";
import { relativeTime } from "@/app/(admin)/admin/tenants/tenants-types";

export function AgentSettingsView() {
  const [llm, setLlm] = useState<LlmCredentialStatus>({ configured: false });
  const [catalog, setCatalog] = useState<AgentModelsCatalog>({ providers: [] });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [llmStatus, models] = await Promise.all([
      fetchLlmCredential(),
      fetchAgentModels(),
    ]);
    setLlm(llmStatus);
    setCatalog(models);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Bot className="h-6 w-6 text-primary" /> Your Agent
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Configure the provider, model, and API key for your own LL5-hosted agent, then
            provision its container.
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={load} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* ---- Provider / model / API key ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <KeyRound className="h-5 w-5 text-primary" /> Model &amp; API key
          </CardTitle>
          <CardDescription>
            Choose the provider and model your assistant runs on, connect your API key, and
            (for opencode) pick per-tool models.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ClaudeKeyForm status={llm} catalog={catalog} onStatusChange={setLlm} />
        </CardContent>
      </Card>

      {/* ---- Hosted runtime ---- */}
      <RuntimeSection llm={llm} />

      {/* ---- Workers ---- */}
      <WorkersCard />
    </div>
  );
}

/* ---------- Hosted runtime section ---------- */

function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-gray-400">{label}</dt>
      <dd className={`min-w-0 break-words text-gray-700 ${mono ? "font-mono" : ""}`}>{value}</dd>
    </>
  );
}

const POLL_MS = 4000;

function RuntimeSection({ llm }: { llm: LlmCredentialStatus }) {
  const llmConfigured = llm.configured;
  const [runtime, setRuntime] = useState<AgentRuntime>({ status: "none" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [consolePending, setConsolePending] = useState(false);

  async function handleConsole() {
    setError(null);
    setConsolePending(true);
    try {
      const result = await fetchConsoleUrl();
      if (result.ok && result.url) {
        window.open(result.url, "_blank", "noopener");
      } else {
        setError(result.error ?? "Could not open the console.");
      }
    } finally {
      setConsolePending(false);
    }
  }

  const load = useCallback(async () => {
    const rt = await fetchRuntime();
    setRuntime(rt);
    setLoading(false);
    return rt;
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // While provisioning, poll until the runtime settles (running/error/etc.).
  useEffect(() => {
    if (!isTransientRuntime(runtime.status)) return;
    const id = setInterval(() => {
      void load();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [runtime.status, load]);

  function handleProvision() {
    setError(null);
    startTransition(async () => {
      const result = await provisionRuntime();
      if (result.ok && result.runtime) {
        setRuntime(result.runtime);
      } else {
        setError(result.error ?? "Could not provision the runtime.");
      }
    });
  }

  function handleStop() {
    setError(null);
    startTransition(async () => {
      const result = await stopRuntime();
      if (result.ok && result.runtime) {
        setRuntime(result.runtime);
      } else {
        setError(result.error ?? "Could not stop the runtime.");
      }
    });
  }

  const badge = runtimeStatusBadge(runtime.status);
  const provisionEnabled = canProvision(llmConfigured, runtime.status) && !isPending;
  const showStop = canStop(runtime.status);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Server className="h-5 w-5 text-primary" /> Hosted runtime
        </CardTitle>
        <CardDescription>
          Your dedicated LL5-hosted agent container. It runs on the provider, model, and key you
          set above; every action is scoped to your account.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Status line */}
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant={badge.variant} className="gap-1">
            {runtime.status === "provisioning" && (
              <Loader2 className="h-3 w-3 animate-spin" />
            )}
            {badge.label}
          </Badge>
          {runtime.last_seen_at && (
            <span className="text-xs text-gray-400">
              Last seen {relativeTime(runtime.last_seen_at)}
            </span>
          )}
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-300" />}
        </div>

        {/* Details grid — full runtime + config info */}
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-xs">
          <DetailRow label="Provider" value={llm.provider ?? (llm.configured ? "—" : "not set")} />
          <DetailRow label="Model" value={llm.model ?? "(image default)"} />
          {llm.model_overrides && Object.keys(llm.model_overrides).length > 0 && (
            <DetailRow
              label="Per-tool models"
              value={Object.entries(llm.model_overrides).map(([s, m]) => `${s}: ${m}`).join(", ")}
            />
          )}
          <DetailRow label="Container" value={runtime.container_id ? runtime.container_id.slice(0, 12) : "—"} mono />
          <DetailRow label="Host" value={runtime.host ?? "—"} />
          <DetailRow
            label="Last heartbeat"
            value={runtime.last_seen_at ? relativeTime(runtime.last_seen_at) : "—"}
          />
        </dl>

        {/* Last error (from the runtime, not a UI error) */}
        {runtime.last_error && (
          <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="break-words">{runtime.last_error}</span>
          </div>
        )}

        {/* Gating hint */}
        {!llmConfigured && (
          <p className="text-xs text-gray-500">
            Connect your API key above before provisioning the runtime.
          </p>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2">
          <Button onClick={handleProvision} disabled={!provisionEnabled}>
            {isPending && !showStop ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <>
                <Play className="h-4 w-4 mr-1.5" />
                {runtime.status === "stopped" || runtime.status === "error"
                  ? "Re-provision"
                  : "Provision"}
              </>
            )}
          </Button>
          {showStop && (
            <Button variant="outline" onClick={handleStop} disabled={isPending} className="text-red-600">
              {isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <Square className="h-3.5 w-3.5 mr-1.5" /> Stop
                </>
              )}
            </Button>
          )}
          {runtime.status === "running" && (
            <Button variant="outline" onClick={handleConsole} disabled={consolePending}>
              {consolePending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <TerminalSquare className="h-3.5 w-3.5 mr-1.5" /> Open console
                </>
              )}
            </Button>
          )}
        </div>

        {/* UI/network error */}
        {error && <p className="text-xs text-red-600">{error}</p>}
      </CardContent>
    </Card>
  );
}

/* ---------- Workers card ---------- */

const WORKER_NAMES: Record<string, string> = {
  main: "Interactive",
  "narrative-loop": "Narrative",
  "reconcile-loop": "Reconcile",
};

function heartbeatAge(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 1000);
}

function WorkersCard() {
  const [sessions, setSessions] = useState<{
    agent_session_id: string | null;
    agent_sessions: Record<string, string>;
    agent_session_heartbeats: Record<string, string>;
  }>({ agent_session_id: null, agent_sessions: {}, agent_session_heartbeats: {} });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const result = await fetchAgentSessions();
    setSessions(result);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, [load]);

  const workerKeys = ["main", "narrative-loop", "reconcile-loop"] as const;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Server className="h-5 w-5 text-primary" /> Workers
        </CardTitle>
        <CardDescription>
          Background workers inside your agent container and their last-seen heartbeats.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading && <Loader2 className="h-4 w-4 animate-spin text-gray-300" />}
        {!loading && workerKeys.map((key) => {
          const sessionId = sessions.agent_sessions[key];
          const heartbeat = sessions.agent_session_heartbeats[key];
          const age = heartbeatAge(heartbeat);
          const alive = age !== null && age < 120;
          const stale = age !== null && age >= 120 && age < 300;
          const dead = age !== null && age >= 300;
          return (
            <div key={key} className="flex items-center gap-3 rounded-md border border-gray-200 bg-white p-3 text-sm">
              {/* Status dot */}
              <span
                className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${
                  dead ? "bg-red-400" : stale ? "bg-amber-400" : alive ? "bg-green-400" : "bg-gray-300"
                }`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{WORKER_NAMES[key] ?? key}</span>
                  {!sessionId && <span className="text-xs text-gray-400">not registered</span>}
                </div>
                {sessionId && (
                  <div className="mt-0.5 text-xs text-gray-400 font-mono">
                    {sessionId.slice(0, 16)}…
                  </div>
                )}
              </div>
              <div className="shrink-0 text-right text-xs text-gray-400">
                {age !== null && `${age}s ago`}
                {age === null && "—"}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
