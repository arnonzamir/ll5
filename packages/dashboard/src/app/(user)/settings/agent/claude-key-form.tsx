"use client";

import { useEffect, useState, useTransition } from "react";
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
import {
  llmStatusLabel,
  type AgentLlmProvider,
  type AgentModelsCatalog,
  type LlmCredentialStatus,
} from "./agent-types";

const HELPER_COPY =
  "Your key is encrypted at rest and used only to run YOUR assistant. LL5 never sees your conversations beyond the LL5 thread.";

const PLACEHOLDER: Record<AgentLlmProvider, string> = {
  anthropic: "sk-ant-…",
  opencode: "your opencode / Zen API key",
};

interface ClaudeKeyFormProps {
  /** Current credential status (parent fetches once and passes down). */
  status: LlmCredentialStatus;
  /** Provider + model catalog for the dropdowns (parent fetches once). */
  catalog?: AgentModelsCatalog;
  /** Called whenever the status changes (save/remove) so the parent can react
   *  — e.g. mark the onboarding `agent_connected` step. */
  onStatusChange?: (status: LlmCredentialStatus) => void;
  /** Compact layout for the onboarding wizard (drops the Remove control). */
  compact?: boolean;
}

/**
 * Agent LLM credential control. Pick a provider (Claude / opencode), a model,
 * and paste the API key. The key is write-only: sent to the gateway and never
 * read back — status shows only the last 4 characters.
 */
export function ClaudeKeyForm({ status, catalog, onStatusChange, compact = false }: ClaudeKeyFormProps) {
  const providers = catalog?.providers ?? [];
  const slots = catalog?.slots ?? [];
  const [local, setLocal] = useState<LlmCredentialStatus>(status);
  const [provider, setProvider] = useState<AgentLlmProvider>(status.provider ?? "anthropic");
  const [model, setModel] = useState<string>(status.model ?? "");
  const [overrides, setOverrides] = useState<Record<string, string>>(status.model_overrides ?? {});
  const [apiKey, setApiKey] = useState("");
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  const modelsForProvider = providers.find((p) => p.provider === provider)?.models ?? [];
  // Per-agent/per-tool overrides are opencode-only (only that runtime spawns
  // the grounder / narrative / reconcile sub-agents).
  const showSlots = provider === "opencode" && slots.length > 0;

  // Sync display state when the parent delivers a new status. The parent fetches
  // the credential ASYNChronously, so the FIRST status this component sees is the
  // pre-fetch {configured:false}; `useState(status)` would latch that forever and
  // show "Not connected" even after the real status loads (the "key disappears on
  // refresh" bug). Re-seed whenever the status object changes (load or save).
  useEffect(() => {
    setLocal(status);
    setProvider(status.provider ?? "anthropic");
    setModel(status.model ?? "");
    setOverrides(status.model_overrides ?? {});
  }, [status]);

  function applyStatus(next: LlmCredentialStatus) {
    setLocal(next);
    onStatusChange?.(next);
  }

  function onProviderChange(next: AgentLlmProvider) {
    setProvider(next);
    // Reset the model to the first option of the new provider.
    const firstModel = providers.find((p) => p.provider === next)?.models[0] ?? "";
    setModel(firstModel);
    setOverrides({}); // slots are provider-specific
    setError(null);
  }

  function setSlot(slot: string, value: string) {
    setOverrides((prev) => {
      const next = { ...prev };
      if (value) next[slot] = value;
      else delete next[slot];
      return next;
    });
    setSaved(false);
  }

  function handleSave() {
    setError(null);
    setSaved(false);
    const key = apiKey;
    startTransition(async () => {
      const result = await saveLlmCredential({
        apiKey: key,
        provider,
        model: model || null,
        modelOverrides: showSlots ? overrides : {},
      });
      if (result.ok) {
        setApiKey(""); // never retain the raw key in component state after save
        setReveal(false);
        setSaved(true);
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

  const selectCls =
    "h-9 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

  return (
    <div className="space-y-3">
      {/* Status line */}
      <div className="flex items-center gap-2">
        {local.configured ? (
          <Badge variant="success" className="gap-1">
            <Check className="h-3 w-3" /> {llmStatusLabel(local)}
            {local.provider ? <span className="opacity-80">· {local.provider}</span> : null}
            {local.model ? <span className="opacity-80">· {local.model}</span> : null}
          </Badge>
        ) : (
          <Badge variant="secondary">{llmStatusLabel(local)}</Badge>
        )}
      </div>

      {/* Provider + model selectors */}
      {providers.length > 0 && (
        <div className="flex flex-wrap gap-3">
          <div className="space-y-1">
            <Label htmlFor="agent-provider">Provider</Label>
            <select
              id="agent-provider"
              className={selectCls}
              value={provider}
              onChange={(e) => onProviderChange(e.target.value as AgentLlmProvider)}
            >
              {providers.map((p) => (
                <option key={p.provider} value={p.provider}>{p.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="agent-model">Model</Label>
            <select
              id="agent-model"
              className={selectCls}
              value={model}
              onChange={(e) => { setModel(e.target.value); setSaved(false); }}
            >
              {modelsForProvider.length === 0 && <option value="">(default)</option>}
              {modelsForProvider.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Per-agent / per-tool model overrides (opencode only) */}
      {showSlots && (
        <div className="space-y-2 rounded-md border border-input p-3">
          <div>
            <Label>Per-tool models</Label>
            <p className="text-xs text-gray-400">
              Override the model for specific sub-agents. Leave on “Default” to inherit the main model above.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            {slots.map((s) => (
              <div key={s.slot} className="space-y-1">
                <Label htmlFor={`slot-${s.slot}`} title={s.description}>{s.label}</Label>
                <select
                  id={`slot-${s.slot}`}
                  className={selectCls}
                  value={overrides[s.slot] ?? ""}
                  onChange={(e) => setSlot(s.slot, e.target.value)}
                >
                  <option value="">Default (main model)</option>
                  {modelsForProvider.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Masked key input + Save */}
      <div className="space-y-2">
        <Label htmlFor="agent-api-key">API key</Label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Input
              id="agent-api-key"
              type={reveal ? "text" : "password"}
              autoComplete="off"
              spellCheck={false}
              placeholder={local.configured ? "Enter a new key to replace" : PLACEHOLDER[provider]}
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
          <Button
            onClick={handleSave}
            disabled={isPending || (apiKey.trim().length === 0 && !local.configured)}
          >
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
          </Button>
        </div>
        {local.configured && apiKey.trim().length === 0 && (
          <p className="text-xs text-gray-400">
            Saving with the key field empty updates the model settings only — your stored key is kept.
          </p>
        )}
        {saved && !error && <p className="text-xs text-green-600">Saved.</p>}
        {error && <p className="text-xs text-red-600">{error}</p>}
        <p className="text-xs text-gray-400">{HELPER_COPY}</p>
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
