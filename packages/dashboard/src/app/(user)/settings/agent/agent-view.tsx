"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  Check,
  Copy,
  Download,
  KeyRound,
  Link2,
  Loader2,
  Play,
  RefreshCw,
  Server,
  Square,
  Trash2,
} from "lucide-react";
import { ClaudeKeyForm } from "./claude-key-form";
import {
  fetchAgentCredentials,
  fetchAgentModels,
  fetchAgentSessions,
  fetchLlmCredential,
  fetchRuntime,
  generateConnection,
  provisionRuntime,
  revokeAgentCredential,
  stopRuntime,
} from "./agent-server-actions";
import {
  canProvision,
  canStop,
  formatMcpConfig,
  isTransientRuntime,
  runtimeStatusBadge,
  type AgentCredential,
  type AgentModelsCatalog,
  type AgentRuntime,
  type ConnectionKit,
  type LlmCredentialStatus,
} from "./agent-types";
import { relativeTime } from "@/app/(admin)/admin/tenants/tenants-types";

export function AgentSettingsView() {
  const [llm, setLlm] = useState<LlmCredentialStatus>({ configured: false });
  const [catalog, setCatalog] = useState<AgentModelsCatalog>({ providers: [] });
  const [credentials, setCredentials] = useState<AgentCredential[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [llmStatus, creds, models] = await Promise.all([
      fetchLlmCredential(),
      fetchAgentCredentials(),
      fetchAgentModels(),
    ]);
    setLlm(llmStatus);
    setCredentials(creds);
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
            Connect your own Claude credential and issue connection kits for a self-run Claude Code.
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={load} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* ---- Claude API key ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <KeyRound className="h-5 w-5 text-primary" /> Model &amp; API key
          </CardTitle>
          <CardDescription>
            Choose the provider and model your assistant runs on, and connect your API key.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ClaudeKeyForm status={llm} catalog={catalog} onStatusChange={setLlm} />
        </CardContent>
      </Card>

      {/* ---- Connection kit ---- */}
      <ConnectionKitSection
        credentials={credentials}
        onChanged={load}
      />

      {/* ---- Hosted runtime ---- */}
      <RuntimeSection llmConfigured={llm.configured} />

      {/* ---- Workers ---- */}
      <WorkersCard />
    </div>
  );
}

/* ---------- Hosted runtime section ---------- */

const POLL_MS = 4000;

function RuntimeSection({ llmConfigured }: { llmConfigured: boolean }) {
  const [runtime, setRuntime] = useState<AgentRuntime>({ status: "none" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

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
          The LL5-hosted agent container that runs with your Claude credential.
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
            Connect your Claude API key above before provisioning the runtime.
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
        </div>

        {/* UI/network error */}
        {error && <p className="text-xs text-red-600">{error}</p>}
      </CardContent>
    </Card>
  );
}

/* ---------- Connection kit section ---------- */

function ConnectionKitSection({
  credentials,
  onChanged,
}: {
  credentials: AgentCredential[];
  onChanged: () => Promise<void> | void;
}) {
  const [name, setName] = useState("");
  const [kit, setKit] = useState<ConnectionKit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [revokingId, setRevokingId] = useState<string | null>(null);

  function handleGenerate() {
    setError(null);
    startTransition(async () => {
      const result = await generateConnection(name);
      if (result.ok && result.kit) {
        setKit(result.kit); // shown ONCE — not re-fetchable
        setName("");
        await onChanged();
      } else {
        setError(result.error ?? "Could not generate a connection.");
      }
    });
  }

  function handleRevoke(id: string) {
    setRevokingId(id);
    startTransition(async () => {
      await revokeAgentCredential(id);
      await onChanged();
      setRevokingId(null);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Link2 className="h-5 w-5 text-primary" /> Connection kit
        </CardTitle>
        <CardDescription>
          For users who self-run Claude Code. The hosted runtime comes in a later phase.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Generate */}
        <div className="space-y-2">
          <Label htmlFor="connection-name">Connection name (optional)</Label>
          <div className="flex gap-2">
            <Input
              id="connection-name"
              placeholder="e.g. laptop"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="flex-1"
            />
            <Button onClick={handleGenerate} disabled={isPending}>
              {isPending && !revokingId ? <Loader2 className="h-4 w-4 animate-spin" /> : "Generate connection"}
            </Button>
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>

        {/* Once-shown kit */}
        {kit && <OnceShownKit kit={kit} onDismiss={() => setKit(null)} />}

        {/* Existing credentials */}
        <div className="space-y-2 border-t border-gray-100 pt-4">
          <p className="text-sm font-medium text-gray-700">Existing connections</p>
          {credentials.length === 0 ? (
            <p className="text-xs text-gray-400">No connections yet.</p>
          ) : (
            <div className="space-y-2">
              {credentials.map((c) => {
                const revoked = !!c.revoked_at;
                return (
                  <div
                    key={c.id}
                    className={`flex items-center gap-3 rounded-md border p-3 text-sm ${
                      revoked ? "border-gray-100 bg-gray-50 opacity-60" : "border-gray-200 bg-white"
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 font-medium">
                        {c.name}
                        {revoked && <Badge variant="secondary">Revoked</Badge>}
                      </div>
                      <div className="mt-0.5 text-xs text-gray-400">
                        Created {fmtDate(c.created_at)}
                        {" · "}
                        Last used {c.last_used_at ? fmtDate(c.last_used_at) : "never"}
                      </div>
                    </div>
                    {!revoked && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-red-600"
                        onClick={() => handleRevoke(c.id)}
                        disabled={isPending && revokingId === c.id}
                      >
                        {isPending && revokingId === c.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <>
                            <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Revoke
                          </>
                        )}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Renders the token + mcp_config exactly once, with copy/download + a hard
 *  "you won't see this again" warning. */
function OnceShownKit({ kit, onDismiss }: { kit: ConnectionKit; onDismiss: () => void }) {
  const mcpJson = formatMcpConfig(kit.mcp_config);
  const [copied, setCopied] = useState<"token" | "config" | null>(null);

  async function copy(text: string, which: "token" | "config") {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard unavailable — user can select manually */
    }
  }

  function download() {
    const blob = new Blob([mcpJson], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = ".mcp.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-4">
      <div className="flex items-start gap-2 text-sm text-amber-800">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          <span className="font-semibold">Save these now — you won&apos;t see them again.</span>{" "}
          The connection token and config are shown only once and cannot be retrieved later.
        </p>
      </div>

      {/* Token */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <Label className="text-xs">Connection token</Label>
          <Button variant="ghost" size="sm" onClick={() => copy(kit.token, "token")}>
            {copied === "token" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            <span className="ml-1.5">{copied === "token" ? "Copied" : "Copy"}</span>
          </Button>
        </div>
        <code className="block w-full overflow-x-auto whitespace-pre rounded border border-amber-200 bg-white px-2 py-1.5 font-mono text-xs select-all">
          {kit.token}
        </code>
      </div>

      {/* mcp_config */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <Label className="text-xs">.mcp.json</Label>
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" onClick={() => copy(mcpJson, "config")}>
              {copied === "config" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              <span className="ml-1.5">{copied === "config" ? "Copied" : "Copy"}</span>
            </Button>
            <Button variant="ghost" size="sm" onClick={download}>
              <Download className="h-3.5 w-3.5" />
              <span className="ml-1.5">Download</span>
            </Button>
          </div>
        </div>
        <pre className="max-h-64 w-full overflow-auto rounded border border-amber-200 bg-white px-2 py-1.5 font-mono text-xs">
          {mcpJson}
        </pre>
      </div>

      <Button variant="outline" size="sm" onClick={onDismiss}>
        I&apos;ve saved it — dismiss
      </Button>
    </div>
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
          Background agent workers and their last-seen heartbeats.
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

function fmtDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
