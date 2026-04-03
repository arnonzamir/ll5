"use client";

import { useState, useTransition, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  RefreshCw,
  Heart,
  Link2,
  Link2Off,
  Loader2,
  CheckCircle2,
  XCircle,
  ArrowLeft,
} from "lucide-react";
import Link from "next/link";
import {
  fetchHealthSources,
  connectHealthSource,
  disconnectHealthSource,
  syncHealthData,
  type HealthSource,
} from "../../health/health-server-actions";

function SourceCard({
  source,
  onRefresh,
}: {
  source: HealthSource;
  onRefresh: () => void;
}) {
  const [showConnect, setShowConnect] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [syncing, startSync] = useTransition();
  const [connecting, startConnect] = useTransition();
  const [disconnecting, startDisconnect] = useTransition();
  const [status, setStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);

  function handleConnect() {
    setStatus(null);
    startConnect(async () => {
      const result = await connectHealthSource(source.sourceId, { email, password });
      if (result.success) {
        setStatus({ type: "success", message: `${source.displayName} connected` });
        setShowConnect(false);
        setEmail("");
        setPassword("");
        onRefresh();
      } else {
        setStatus({ type: "error", message: result.error ?? "Connection failed" });
      }
    });
  }

  function handleDisconnect() {
    setStatus(null);
    startDisconnect(async () => {
      const result = await disconnectHealthSource(source.sourceId);
      if (result.success) {
        setStatus({ type: "success", message: `${source.displayName} disconnected` });
        onRefresh();
      } else {
        setStatus({ type: "error", message: result.error ?? "Disconnect failed" });
      }
    });
  }

  function handleSync() {
    setStatus(null);
    startSync(async () => {
      const result = await syncHealthData();
      const msg = `Synced ${result.totalSynced} items${result.totalErrors > 0 ? `, ${result.totalErrors} errors` : ""}`;
      setStatus({ type: result.totalErrors > 0 ? "error" : "success", message: msg });
    });
  }

  const busy = connecting || disconnecting || syncing;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Heart className="h-5 w-5 text-red-500" />
            <div>
              <CardTitle className="text-base">{source.displayName}</CardTitle>
              <CardDescription className="text-xs">
                Source: {source.sourceId}
                {source.lastCredentialUpdate && ` \u00b7 Last updated: ${new Date(source.lastCredentialUpdate).toLocaleDateString()}`}
              </CardDescription>
            </div>
          </div>
          <Badge
            className={
              source.connected
                ? "bg-green-100 text-green-700 border-green-200"
                : "bg-gray-100 text-gray-600 border-gray-200"
            }
          >
            {source.connected ? "Connected" : "Not Connected"}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Status message */}
        {status && (
          <div
            className={`flex items-center gap-2 text-sm px-3 py-2 rounded-md ${
              status.type === "success"
                ? "bg-green-50 text-green-700"
                : "bg-red-50 text-red-700"
            }`}
          >
            {status.type === "success" ? (
              <CheckCircle2 className="h-4 w-4 shrink-0" />
            ) : (
              <XCircle className="h-4 w-4 shrink-0" />
            )}
            {status.message}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2">
          {source.connected ? (
            <>
              <Button variant="outline" size="sm" onClick={handleSync} disabled={busy}>
                {syncing ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
                Sync Now
              </Button>
              <Button variant="outline" size="sm" onClick={handleDisconnect} disabled={busy} className="text-red-600 hover:text-red-700 hover:bg-red-50">
                {disconnecting ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Link2Off className="h-3.5 w-3.5 mr-1.5" />}
                Disconnect
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowConnect(!showConnect)}
              disabled={busy}
            >
              <Link2 className="h-3.5 w-3.5 mr-1.5" />
              Connect
            </Button>
          )}
        </div>

        {/* Connect form */}
        {showConnect && !source.connected && (
          <div className="border border-gray-200 rounded-md p-4 space-y-3">
            <p className="text-xs text-gray-500">
              Enter your {source.displayName} credentials. They will be encrypted and stored securely.
            </p>
            <div className="space-y-2">
              <Input
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-9"
              />
              <Input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-9"
                onKeyDown={(e) => e.key === "Enter" && email && password && handleConnect()}
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleConnect} disabled={!email || !password || connecting}>
                {connecting ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
                Connect
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setShowConnect(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function HealthSettingsView() {
  const [sources, setSources] = useState<HealthSource[]>([]);
  const [isPending, startTransition] = useTransition();

  const load = useCallback(() => {
    startTransition(async () => {
      const data = await fetchHealthSources();
      setSources(data);
    });
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Link href="/health">
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold">Health Settings</h1>
            <p className="text-sm text-gray-500 mt-1">
              Connect and manage health data sources
            </p>
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={load} disabled={isPending}>
          <RefreshCw className={`h-4 w-4 ${isPending ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* Sources */}
      {isPending && sources.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-8">Loading sources...</p>
      ) : sources.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <Heart className="h-8 w-8 text-gray-300 mx-auto mb-3" />
            <p className="text-sm text-gray-500">
              No health sources available. The health service may not be running.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {sources.map((source) => (
            <SourceCard key={source.sourceId} source={source} onRefresh={load} />
          ))}
        </div>
      )}

      {/* Info */}
      <div className="mt-8 p-4 bg-gray-50 rounded-lg border border-gray-200">
        <h3 className="text-sm font-medium text-gray-700 mb-2">About Health Data</h3>
        <ul className="text-xs text-gray-500 space-y-1 list-disc list-inside">
          <li>Credentials are encrypted before storage and never logged</li>
          <li>Data is synced on demand via the &quot;Sync Now&quot; button or by the agent</li>
          <li>All health data is stored locally in your system&apos;s Elasticsearch</li>
          <li>You can disconnect a source at any time without losing synced data</li>
        </ul>
      </div>
    </div>
  );
}
