"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { Check, Trash2 } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  fetchModelCatalog, fetchModelConfig, saveProviderKey, removeProviderKey, saveModelConfig, provisionRuntime,
  type ModelCatalog, type ModelConfig, type ModelRef, type CatalogSlot,
} from "./agent-server-actions";

const selectCls =
  "h-9 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring min-w-[9rem]";

const DEFAULT_CONFIG: ModelConfig = {
  variant: "opencode",
  default: { provider: "zen", model: "deepseek-v4-flash" },
  slots: {},
};
const CLAUDE_DEFAULT: ModelConfig = {
  variant: "claude",
  default: { provider: "claude-code", model: "default" },
  slots: {},
};

export function AgentModelsForm() {
  const [catalog, setCatalog] = useState<ModelCatalog>({ providers: [], slots: [] });
  const [keys, setKeys] = useState<Record<string, { configured: boolean; last4: string | null }>>({});
  const [config, setConfig] = useState<ModelConfig>(DEFAULT_CONFIG);
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    (async () => {
      const [cat, cfg] = await Promise.all([fetchModelCatalog(), fetchModelConfig()]);
      setCatalog(cat);
      setKeys(cfg.keys ?? {});
      if (cfg.config?.default) setConfig({ variant: cfg.config.variant ?? "opencode", default: cfg.config.default, slots: cfg.config.slots ?? {} });
    })();
  }, []);

  const providerLabel = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of catalog.providers) m[p.id] = p.label;
    return m;
  }, [catalog]);

  /** Models for a provider that satisfy a capability. */
  function modelsFor(provider: string, capability: "text" | "vision" | "audio"): string[] {
    const p = catalog.providers.find((x) => x.id === provider);
    if (!p) return [];
    return p.models.filter((m) => m.caps.includes(capability)).map((m) => m.id);
  }

  // ----- keys -----
  function onSaveKey(provider: string) {
    setErr(null); setMsg(null);
    const val = (keyInputs[provider] ?? "").trim();
    if (!val) return;
    startTransition(async () => {
      const r = await saveProviderKey(provider, val);
      if (r.ok) {
        setKeys((k) => ({ ...k, [provider]: { configured: true, last4: r.last4 ?? null } }));
        setKeyInputs((k) => ({ ...k, [provider]: "" }));
        setMsg(`${providerLabel[provider] ?? provider} key saved.`);
      } else setErr(r.error ?? "Save failed.");
    });
  }
  function onRemoveKey(provider: string) {
    startTransition(async () => {
      await removeProviderKey(provider);
      setKeys((k) => ({ ...k, [provider]: { configured: false, last4: null } }));
    });
  }

  // ----- model config -----
  function setDefault(ref: Partial<ModelRef>) {
    setConfig((c) => ({ ...c, default: { ...c.default, ...ref } }));
  }
  function setSlot(slot: string, ref: ModelRef | null) {
    setConfig((c) => ({ ...c, slots: { ...c.slots, [slot]: ref } }));
  }

  function onSaveConfig() {
    setErr(null); setMsg(null);
    startTransition(async () => {
      const r = await saveModelConfig(config);
      if (!r.ok) { setErr(r.error ?? "Save failed."); return; }
      setMsg("Saved. Re-provisioning to apply…");
      const p = await provisionRuntime();
      setMsg(p.ok ? "Saved + re-provisioned." : `Saved. ${p.error ?? "Re-provision manually to apply."}`);
    });
  }

  // A row: provider select + model select. `capability` filters the model list.
  // `allowDefault` adds a "Default" provider option (inherit the top default).
  function ProviderModelRow({
    value, capability, allowDefault, onChange,
  }: {
    value: ModelRef | null; capability: "text" | "vision" | "audio"; allowDefault: boolean;
    onChange: (ref: ModelRef | null) => void;
  }) {
    const provider = value?.provider ?? (allowDefault ? "" : "zen");
    const models = provider ? modelsFor(provider, capability) : [];
    return (
      <div className="flex flex-wrap gap-2">
        <select
          className={selectCls}
          value={provider}
          onChange={(e) => {
            const p = e.target.value;
            if (!p) { onChange(null); return; }
            const first = modelsFor(p, capability)[0] ?? "";
            onChange({ provider: p, model: value?.provider === p ? value.model : first });
          }}
        >
          {allowDefault && <option value="">Default</option>}
          {catalog.providers.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
        {provider && (
          <select
            className={selectCls}
            value={value?.model ?? ""}
            onChange={(e) => onChange({ provider, model: e.target.value })}
          >
            {models.length === 0 && <option value="">(no {capability} models)</option>}
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        )}
      </div>
    );
  }

  const variant = config.variant ?? "opencode";
  const keyProviders = catalog.providers.filter((p) =>
    variant === "claude" ? p.id === "claude-code" : p.id !== "claude-code",
  );
  const claudeModels = catalog.providers.find((p) => p.id === "claude-code")?.models ?? [];
  const tabCls = (on: boolean) =>
    `h-9 px-3 rounded-md text-sm border ${on ? "border-primary text-primary bg-primary/5" : "border-input text-ink-500 hover:text-ink-700"}`;

  return (
    <div className="space-y-5">
      {/* ---- Runtime variant ---- */}
      <section className="space-y-2 rounded-md border border-input p-3">
        <Label>Runtime</Label>
        <div className="flex gap-2">
          <button type="button" className={tabCls(variant === "opencode")} onClick={() => setConfig(DEFAULT_CONFIG)}>
            opencode (multi-provider)
          </button>
          <button type="button" className={tabCls(variant === "claude")} onClick={() => setConfig(CLAUDE_DEFAULT)}>
            Claude Code (subscription)
          </button>
        </div>
        <p className="text-xs text-gray-400">
          {variant === "claude"
            ? "Runs your Claude subscription — one Claude model, vision native. Sub-agents inherit it."
            : "Per-slot models across Zen / Groq / Anthropic. Cheapest + most flexible."}
        </p>
      </section>

      {/* ---- API keys (filtered by variant) ---- */}
      <section className="space-y-2 rounded-md border border-input p-3">
        <Label>{variant === "claude" ? "Claude Code token" : "API keys"}</Label>
        <p className="text-xs text-gray-400">
          {variant === "claude"
            ? "Your subscription token from `claude setup-token` (sk-ant-oat…). Write-only, stored encrypted."
            : "One key per provider. Write-only — stored encrypted, never shown."}
        </p>
        <div className="space-y-2">
          {keyProviders.map((p) => {
            const k = keys[p.id];
            return (
              <div key={p.id} className="flex flex-wrap items-center gap-2">
                <span className="w-40 text-sm">{p.label}</span>
                {k?.configured ? (
                  <>
                    <Badge variant="success" className="gap-1"><Check className="h-3 w-3" /> ••••{k.last4}</Badge>
                    <button type="button" onClick={() => onRemoveKey(p.id)} className="text-gray-400 hover:text-red-500" title="Remove key">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </>
                ) : (
                  <>
                    <Input
                      type="password" autoComplete="off" spellCheck={false}
                      placeholder={p.keyPrefix ? `${p.keyPrefix}…` : `${p.label} key`}
                      value={keyInputs[p.id] ?? ""}
                      onChange={(e) => setKeyInputs((s) => ({ ...s, [p.id]: e.target.value }))}
                      className="w-64 font-mono"
                    />
                    <Button size="sm" variant="outline" disabled={pending} onClick={() => onSaveKey(p.id)}>Save</Button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {variant === "opencode" ? (
        <>
          {/* ---- Default model ---- */}
          <section className="space-y-2 rounded-md border border-input p-3">
            <Label>Default model</Label>
            <p className="text-xs text-gray-400">Fills any slot left on “Default”.</p>
            <ProviderModelRow value={config.default} capability="text" allowDefault={false} onChange={(ref) => ref && setDefault(ref)} />
          </section>

          {/* ---- Per-slot rows ---- */}
          <section className="space-y-2 rounded-md border border-input p-3">
            <Label>Per-slot models</Label>
            <p className="text-xs text-gray-400">Each job can pick its own provider + model. “Default” inherits the default above.</p>
            <div className="space-y-2">
              {catalog.slots.map((s: CatalogSlot) => (
                <div key={s.slot} className="flex flex-wrap items-center gap-2">
                  <span className="w-40 text-sm" title={s.description}>{s.label}</span>
                  <ProviderModelRow value={config.slots[s.slot] ?? null} capability={s.capability} allowDefault={true} onChange={(ref) => setSlot(s.slot, ref)} />
                </div>
              ))}
            </div>
          </section>
        </>
      ) : (
        /* ---- Claude model picker ---- */
        <section className="space-y-2 rounded-md border border-input p-3">
          <Label>Claude model</Label>
          <p className="text-xs text-gray-400">Sub-agents (grounder/narrative/reconcile) inherit this; images are native to Claude.</p>
          <select
            className={selectCls}
            value={config.default.model}
            onChange={(e) => setDefault({ provider: "claude-code", model: e.target.value })}
          >
            {claudeModels.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
          </select>
        </section>
      )}

      <div className="flex items-center gap-3">
        <Button disabled={pending} onClick={onSaveConfig}>Save models</Button>
        {msg && <span className="text-sm text-emerald-600">{msg}</span>}
        {err && <span className="text-sm text-red-500">{err}</span>}
      </div>
    </div>
  );
}
