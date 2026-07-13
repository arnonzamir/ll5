// packages/gateway/src/agent-models.ts
//
// Multi-provider agent model catalog + per-slot config. Each slot (main /
// grounder / narrative / reconcile / image / audio) can pick its OWN provider
// (zen / groq / anthropic) + model; a top-level default fills any unset slot.
// Keys are stored per provider. This module owns the catalog the settings UI
// renders, the config shape persisted in agent_llm_credentials.model_config, and
// the validation/normalisation both the PUT endpoints and the orchestrator use.

// `claude-code` is the Claude-Code variant's subscription auth (an OAuth token),
// not a per-slot model provider — it selects the Claude-Code runtime image and
// carries the token. Zen/groq/anthropic are opencode-variant model providers.
export const AGENT_PROVIDERS = ['zen', 'groq', 'anthropic', 'claude-code'] as const;
export type AgentProviderId = (typeof AGENT_PROVIDERS)[number];

/** Which runtime image a config targets. */
export const AGENT_VARIANTS = ['opencode', 'claude'] as const;
export type AgentVariant = (typeof AGENT_VARIANTS)[number];

export type ModelCapability = 'text' | 'vision' | 'audio';

export interface CatalogModel {
  id: string;
  /** What the model can do — drives which slots may select it. */
  caps: ModelCapability[];
}
export interface CatalogProvider {
  id: AgentProviderId;
  label: string;
  /** The env var the agent container reads this provider's key from. */
  keyEnv: string;
  /** Anthropic keys have a fixed prefix; zen/groq accept any non-trivial token. */
  keyPrefix?: string;
  models: CatalogModel[];
}

const V = ['text', 'vision'] as ModelCapability[]; // text + vision
const T = ['text'] as ModelCapability[];
const A = ['audio'] as ModelCapability[];

// --- Zen (opencode) — the full catalog; claude-* are vision-capable via image_url.
const ZEN_MODELS: CatalogModel[] = [
  { id: 'deepseek-v4-flash', caps: T }, { id: 'deepseek-v4-flash-free', caps: T }, { id: 'deepseek-v4-pro', caps: T },
  { id: 'claude-opus-4-8', caps: V }, { id: 'claude-sonnet-5', caps: V }, { id: 'claude-haiku-4-5', caps: V },
  { id: 'claude-opus-4-5', caps: V }, { id: 'claude-sonnet-4-6', caps: V }, { id: 'claude-fable-5', caps: V },
  { id: 'gpt-5.6-sol', caps: T }, { id: 'gpt-5.5', caps: T }, { id: 'gpt-5.4', caps: T }, { id: 'gpt-5.4-mini', caps: T }, { id: 'gpt-5.4-nano', caps: T }, { id: 'gpt-5-nano', caps: T },
  { id: 'gemini-3.5-flash', caps: T }, { id: 'gemini-3.1-pro', caps: T }, { id: 'gemini-3-flash', caps: T },
  { id: 'glm-5.2', caps: T }, { id: 'glm-5', caps: T },
  { id: 'grok-4.5', caps: T },
  { id: 'kimi-k2.7-code', caps: T }, { id: 'kimi-k2.6', caps: T },
  { id: 'minimax-m3', caps: T }, { id: 'qwen3.6-plus', caps: T }, { id: 'qwen3.5-plus', caps: T },
  { id: 'nemotron-3-ultra-free', caps: T }, { id: 'mimo-v2.5-free', caps: T }, { id: 'big-pickle', caps: T },
];

// --- Groq — fast open models (LLM + vision via Llama-4) + Whisper for audio.
const GROQ_MODELS: CatalogModel[] = [
  { id: 'meta-llama/llama-4-maverick-17b-128e-instruct', caps: V },
  { id: 'meta-llama/llama-4-scout-17b-16e-instruct', caps: V },
  { id: 'moonshotai/kimi-k2-instruct', caps: T },
  { id: 'qwen/qwen3-32b', caps: T },
  { id: 'openai/gpt-oss-120b', caps: T },
  { id: 'openai/gpt-oss-20b', caps: T },
  { id: 'deepseek-r1-distill-llama-70b', caps: T },
  { id: 'llama-3.3-70b-versatile', caps: T },
  { id: 'whisper-large-v3', caps: A },
  { id: 'whisper-large-v3-turbo', caps: A },
  { id: 'distil-whisper-large-v3-en', caps: A },
];

// --- Anthropic-direct — Claude over a BYO ANTHROPIC_API_KEY (outside Zen billing).
// Model ids follow Anthropic's API naming; adjust when the key is added if a name
// 404s (the dropdown is a hint, not an allow-list).
const ANTHROPIC_MODELS: CatalogModel[] = [
  { id: 'claude-opus-4-8', caps: V }, { id: 'claude-sonnet-5', caps: V },
  { id: 'claude-haiku-4-5-20251001', caps: V }, { id: 'claude-fable-5', caps: V },
];

// --- Claude Code — the subscription-token variant. Models it can run (Claude
// only, vision native). The "key" is the OAuth token from `claude setup-token`.
const CLAUDE_CODE_MODELS: CatalogModel[] = [
  { id: 'default', caps: V }, { id: 'opus', caps: V }, { id: 'sonnet', caps: V }, { id: 'haiku', caps: V },
];

export const PROVIDER_CATALOG: Record<AgentProviderId, CatalogProvider> = {
  zen: { id: 'zen', label: 'OpenCode Zen', keyEnv: 'OPENCODE_ZEN_API_KEY', models: ZEN_MODELS },
  groq: { id: 'groq', label: 'Groq', keyEnv: 'GROQ_API_KEY', models: GROQ_MODELS },
  anthropic: { id: 'anthropic', label: 'Anthropic (direct)', keyEnv: 'ANTHROPIC_API_KEY', keyPrefix: 'sk-ant-', models: ANTHROPIC_MODELS },
  'claude-code': { id: 'claude-code', label: 'Claude Code (subscription)', keyEnv: 'CLAUDE_CODE_OAUTH_TOKEN', keyPrefix: 'sk-ant-oat', models: CLAUDE_CODE_MODELS },
};

// --- Slots. Each declares the capability its model must have, so the UI filters
// the model dropdown. `main` is the interactive agent; others are sub-agents/tools.
export interface SlotDef {
  slot: string;
  label: string;
  description: string;
  capability: ModelCapability;
}
export const MODEL_SLOTS: SlotDef[] = [
  { slot: 'main', label: 'Main agent', description: 'The interactive assistant.', capability: 'text' },
  { slot: 'grounder', label: 'Grounder', description: 'Read-only context recall before proactive turns.', capability: 'text' },
  { slot: 'narrative', label: 'Narrative consolidator', description: 'Off-agent batch narrative maintenance.', capability: 'text' },
  { slot: 'reconcile', label: 'Reconcile worker', description: 'Off-agent open-loop reconciliation.', capability: 'text' },
  { slot: 'image', label: 'Image analysis', description: 'Vision model for inspect_image.', capability: 'vision' },
  { slot: 'audio', label: 'Audio transcription', description: 'Speech-to-text for transcribe_audio.', capability: 'audio' },
];
export const SLOT_IDS = new Set(MODEL_SLOTS.map((s) => s.slot));
const SLOT_CAP = new Map(MODEL_SLOTS.map((s) => [s.slot, s.capability] as const));

export interface ModelRef { provider: AgentProviderId; model: string; }
export interface ModelConfig {
  /** Which runtime image. 'opencode' (default) uses the per-slot multi-provider
   *  config below; 'claude' runs the Claude-Code image (default is a Claude model
   *  via the claude-code subscription token; slots are ignored). */
  variant: AgentVariant;
  default: ModelRef;
  /** null / absent → inherit default. Only used by the opencode variant. */
  slots: Record<string, ModelRef | null>;
}

export function isProvider(p: unknown): p is AgentProviderId {
  return typeof p === 'string' && (AGENT_PROVIDERS as readonly string[]).includes(p);
}

/** A model is valid for a provider if non-empty (catalog is a hint) AND, when it
 *  IS in the catalog, satisfies the required capability for that slot. Unknown
 *  models (not in catalog) are allowed for text slots so new releases work, but
 *  vision/audio slots require a catalog model with that capability (safety —
 *  picking a text model for audio silently fails at runtime). */
export function modelOkForSlotCapability(provider: AgentProviderId, model: string, capability: ModelCapability): boolean {
  if (typeof model !== 'string' || model.length === 0 || model.length > 120) return false;
  const known = PROVIDER_CATALOG[provider].models.find((m) => m.id === model);
  if (capability === 'text') return true; // permissive for text
  if (!known) return false; // vision/audio must be a known capable model
  return known.caps.includes(capability);
}

/** Validate + normalise a ModelConfig from untrusted input. */
export function sanitizeModelConfig(raw: unknown): { config: ModelConfig } | { error: string } {
  if (raw == null || typeof raw !== 'object') return { error: 'model_config must be an object' };
  const r = raw as Record<string, unknown>;
  const variant: AgentVariant = r.variant === 'claude' ? 'claude' : 'opencode';
  const def = r.default as Record<string, unknown> | undefined;
  if (!def || !isProvider(def.provider) || typeof def.model !== 'string' || !def.model.trim()) {
    return { error: 'model_config.default must be { provider, model }' };
  }

  if (variant === 'claude') {
    // Claude-Code: default provider must be claude-code; model is a Claude tier.
    if (def.provider !== 'claude-code') {
      return { error: "claude variant default.provider must be 'claude-code'" };
    }
    const known = PROVIDER_CATALOG['claude-code'].models.some((m) => m.id === def.model);
    if (!known) return { error: `claude default model must be one of: ${PROVIDER_CATALOG['claude-code'].models.map((m) => m.id).join(', ')}` };
    // Slots are ignored for the claude variant — normalise to empty.
    return { config: { variant, default: { provider: 'claude-code', model: String(def.model) }, slots: {} } };
  }

  // opencode variant: default must be a text model on a model provider.
  if (def.provider === 'claude-code') return { error: 'claude-code provider requires the claude variant' };
  if (!modelOkForSlotCapability(def.provider, def.model.trim(), 'text')) {
    return { error: 'default model is invalid' };
  }
  const outSlots: Record<string, ModelRef | null> = {};
  const rawSlots = (r.slots ?? {}) as Record<string, unknown>;
  for (const [slot, val] of Object.entries(rawSlots)) {
    if (!SLOT_IDS.has(slot)) continue;
    if (val == null) { outSlots[slot] = null; continue; }
    const v = val as Record<string, unknown>;
    if (!isProvider(v.provider) || typeof v.model !== 'string' || !v.model.trim()) {
      return { error: `model_config.slots.${slot} must be { provider, model } or null` };
    }
    if (v.provider === 'claude-code') return { error: `model_config.slots.${slot}: claude-code is not a slot provider` };
    const cap = SLOT_CAP.get(slot) ?? 'text';
    if (!modelOkForSlotCapability(v.provider, v.model.trim(), cap)) {
      return { error: `model_config.slots.${slot}: ${v.model} is not a valid ${cap} model for ${v.provider}` };
    }
    outSlots[slot] = { provider: v.provider, model: v.model.trim() };
  }
  return { config: { variant, default: { provider: def.provider, model: def.model.trim() }, slots: outSlots } };
}

/** Resolve a slot to its effective ModelRef (slot override else default). */
export function resolveSlot(config: ModelConfig, slot: string): ModelRef {
  return config.slots[slot] ?? config.default;
}

/** Validate a provider key's shape without logging it. */
export function keyOkForProvider(provider: AgentProviderId, key: string): boolean {
  if (typeof key !== 'string' || key.length < 8 || key.length > 400) return false;
  const prefix = PROVIDER_CATALOG[provider].keyPrefix;
  return prefix ? key.startsWith(prefix) : true;
}
