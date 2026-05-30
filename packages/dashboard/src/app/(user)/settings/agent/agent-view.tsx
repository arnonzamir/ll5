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
  RefreshCw,
  Server,
  Trash2,
} from "lucide-react";
import { ClaudeKeyForm } from "./claude-key-form";
import {
  fetchAgentCredentials,
  fetchLlmCredential,
  generateConnection,
  revokeAgentCredential,
} from "./agent-server-actions";
import {
  formatMcpConfig,
  type AgentCredential,
  type ConnectionKit,
  type LlmCredentialStatus,
} from "./agent-types";

export function AgentSettingsView() {
  const [llm, setLlm] = useState<LlmCredentialStatus>({ configured: false });
  const [credentials, setCredentials] = useState<AgentCredential[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [llmStatus, creds] = await Promise.all([
      fetchLlmCredential(),
      fetchAgentCredentials(),
    ]);
    setLlm(llmStatus);
    setCredentials(creds);
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
            <KeyRound className="h-5 w-5 text-primary" /> Claude API key
          </CardTitle>
          <CardDescription>
            The credential your assistant uses to talk to Claude.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ClaudeKeyForm status={llm} onStatusChange={setLlm} />
        </CardContent>
      </Card>

      {/* ---- Connection kit ---- */}
      <ConnectionKitSection
        credentials={credentials}
        onChanged={load}
      />

      {/* ---- Runtime status (placeholder) ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Server className="h-5 w-5 text-gray-400" /> Runtime status
          </CardTitle>
          <CardDescription>The LL5-hosted agent runtime.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 rounded-md bg-gray-50 p-4 text-sm text-gray-500">
            <Badge variant="secondary">Coming soon</Badge>
            Hosted runtime — coming soon.
          </div>
        </CardContent>
      </Card>
    </div>
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

function fmtDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
