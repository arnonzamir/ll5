"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Check, Eye, EyeOff, Loader2, Trash2 } from "lucide-react";
import {
  fetchLlmCredential,
  saveLlmCredential,
  removeLlmCredential,
} from "./agent-server-actions";
import { llmStatusLabel, type LlmCredentialStatus } from "./agent-types";

const HELPER_COPY =
  "Your key is encrypted at rest and used only to run YOUR assistant. LL5 never sees your Claude conversations beyond the LL5 thread.";

interface ClaudeKeyFormProps {
  /** Current credential status (parent fetches once and passes down). */
  status: LlmCredentialStatus;
  /** Called whenever the status changes (save/remove) so the parent can react
   *  — e.g. mark the onboarding `agent_connected` step. */
  onStatusChange?: (status: LlmCredentialStatus) => void;
  /** Compact layout for the onboarding wizard (drops the Remove control). */
  compact?: boolean;
}

/**
 * Shared "Claude API key" capture control. The key is write-only: it is sent to
 * the gateway and never read back — status shows only the last 4 characters.
 * Reused by /settings/agent and the onboarding "agent" step.
 */
export function ClaudeKeyForm({ status, onStatusChange, compact = false }: ClaudeKeyFormProps) {
  const [local, setLocal] = useState<LlmCredentialStatus>(status);
  const [apiKey, setApiKey] = useState("");
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function applyStatus(next: LlmCredentialStatus) {
    setLocal(next);
    onStatusChange?.(next);
  }

  function handleSave() {
    setError(null);
    const key = apiKey;
    startTransition(async () => {
      const result = await saveLlmCredential(key);
      if (result.ok) {
        setApiKey(""); // never retain the raw key in component state after save
        setReveal(false);
        applyStatus(result.status ?? (await fetchLlmCredential()));
      } else {
        setError(result.error ?? "Failed to save the key.");
      }
    });
  }

  function handleRemove() {
    setError(null);
    startTransition(async () => {
      const result = await removeLlmCredential();
      if (result.ok) {
        applyStatus({ configured: false });
      } else {
        setError("Failed to remove the key.");
      }
    });
  }

  return (
    <div className="space-y-3">
      {/* Status line */}
      <div className="flex items-center gap-2">
        {local.configured ? (
          <Badge variant="success" className="gap-1">
            <Check className="h-3 w-3" /> {llmStatusLabel(local)}
          </Badge>
        ) : (
          <Badge variant="secondary">{llmStatusLabel(local)}</Badge>
        )}
      </div>

      {/* Masked input + Save */}
      <div className="space-y-2">
        <Label htmlFor="anthropic-api-key">Anthropic API key</Label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Input
              id="anthropic-api-key"
              type={reveal ? "text" : "password"}
              autoComplete="off"
              spellCheck={false}
              placeholder={local.configured ? "Enter a new key to replace" : "sk-ant-…"}
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setError(null);
              }}
              className="pr-9 font-mono"
            />
            <button
              type="button"
              onClick={() => setReveal((r) => !r)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              aria-label={reveal ? "Hide key" : "Show key"}
              tabIndex={-1}
            >
              {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <Button onClick={handleSave} disabled={isPending || apiKey.trim().length === 0}>
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
          </Button>
        </div>
        {error && <p className="text-xs text-red-600">{error}</p>}
        <p className="text-xs text-gray-400">{HELPER_COPY}</p>
        <p className="text-xs text-gray-400">
          Today the UI accepts an Anthropic <span className="font-medium">API key</span> (sk-ant-…).
        </p>
      </div>

      {/* Remove (full page only) */}
      {!compact && local.configured && (
        <Button variant="outline" size="sm" onClick={handleRemove} disabled={isPending} className="text-red-600">
          <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Remove key
        </Button>
      )}
    </div>
  );
}
