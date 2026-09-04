import { mkdir, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The per-user secret env-file: the ONLY place the user's Claude API key and
 * agent token are materialized on the host. Written 0600 into SECRETS_DIR
 * (default /run/ll5 — a tmpfs/private dir), then bind-mounted read-only into the
 * container. The base-image entrypoint sources this file.
 *
 * NEVER pass these values via `-e VAR=...` or command args (would surface in
 * `ps`/`docker inspect`). NEVER log the values.
 *
 * --- ORCHESTRATOR ⇄ BASE-IMAGE CONTRACT ---
 * Common keys (always written): LL5_USER_ID, LL5_AGENT_TOKEN, LL5_GATEWAY_URL,
 * MCP_BASE_DOMAIN, AGENT_VARIANT.
 * Provider-specific keys:
 *   anthropic → ANTHROPIC_API_KEY
 *   opencode  → OPENCODE_ZEN_API_KEY, OPENCODE_MODEL_ID, OPENCODE_PROVIDER_ID,
 *               and OPENCODE_SERVER_URL when a base_url is set.
 * Mounted read-only at the path the orchestrator passes as LL5_AGENT_ENV_FILE
 * (default /run/ll5/agent.env). The entrypoint MUST `set -a; . "$file"; set +a`
 * before launching the agent so the credential never appears in argv.
 */
export type AgentProvider = 'anthropic' | 'opencode';

/** Abstract model provider a slot can point at (+ claude-code for the CC token). */
export type AgentProviderKey = 'zen' | 'groq' | 'anthropic' | 'claude-code';
export type AgentVariant = 'opencode' | 'claude';
export interface AgentModelRef { provider: AgentProviderKey; model: string }
export interface AgentModelConfig {
  variant?: AgentVariant;
  default: AgentModelRef;
  /** null/absent → inherit default. Keys: main/grounder/narrative/reconcile/image/audio. */
  slots: Record<string, AgentModelRef | null>;
}

/** Slots emitted as LL5_SLOT_<UPPER>_PROVIDER / _MODEL for the entrypoint. */
const EMIT_SLOTS = ['main', 'grounder', 'narrative', 'reconcile', 'image', 'audio'] as const;

export interface SecretEnv {
  userId: string;
  agentToken: string;
  gatewayUrl: string;
  mcpBaseDomain: string;
  /** Which runtime variant this user's container runs. */
  provider: AgentProvider;
  /** Decrypted per-provider API keys (only those configured). */
  keys: Partial<Record<AgentProviderKey, string>>;
  /** Resolved model config: default + per-slot {provider, model}. */
  config: AgentModelConfig;
}

/**
 * Slot id → container env var the corresponding opencode sub-agent reads. Mirror
 * of AGENT_MODEL_SLOTS in the gateway (packages/gateway/src/agent.ts) — keep in
 * sync. Only these slots are emitted; unknown keys are ignored.
 */
const SLOT_ENV: Record<string, string> = {
  grounder: 'OPENCODE_GROUNDER_MODEL',
  narrative: 'OPENCODE_NARRATIVE_MODEL',
  reconcile: 'OPENCODE_RECONCILE_MODEL',
  image: 'OPENCODE_IMAGE_MODEL',
  audio: 'OPENCODE_AUDIO_MODEL',
};

export interface SecretsWriterOptions {
  /** Directory secrets live in (should be tmpfs/private). */
  dir?: string;
}

const DEFAULT_DIR = process.env.SECRETS_DIR || '/run/ll5';

/** The fixed in-container mount target the entrypoint sources. */
export const ENV_FILE_TARGET = '/run/ll5/agent.env';

function escapeValue(v: string): string {
  // Single-quote and escape embedded single quotes so the entrypoint's
  // `. file` (POSIX sh source) reads the literal value safely.
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

export class SecretsWriter {
  private readonly dir: string;

  constructor(opts: SecretsWriterOptions = {}) {
    this.dir = opts.dir ?? DEFAULT_DIR;
  }

  hostPathFor(userId: string): string {
    return path.join(this.dir, `${userId}.env`);
  }

  /**
   * Write the 0600 env-file and return its host path. Order matters: we create
   * with mode 0600 from the start (no race window), then re-assert chmod.
   */
  async write(env: SecretEnv): Promise<string> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const target = this.hostPathFor(env.userId);
    const variant = env.provider === 'opencode' ? 'opencode' : 'claude';
    const lines = [
      `LL5_USER_ID=${escapeValue(env.userId)}`,
      `LL5_AGENT_TOKEN=${escapeValue(env.agentToken)}`,
      // Alias: the opencode entrypoint reads LL5_TOKEN (the Claude base-image uses
      // LL5_AGENT_TOKEN). Emit both so either variant's entrypoint finds the token.
      `LL5_TOKEN=${escapeValue(env.agentToken)}`,
      `LL5_GATEWAY_URL=${escapeValue(env.gatewayUrl)}`,
      `MCP_BASE_DOMAIN=${escapeValue(env.mcpBaseDomain)}`,
      `AGENT_VARIANT=${escapeValue(variant)}`,
    ];
    if (env.provider === 'opencode') {
      const { keys, config } = env;
      // Provider keys — STRICTLY per-tenant. Each tenant supplies their own key
      // per provider (no shared/system fallback); only configured keys are written.
      if (keys.zen) lines.push(`OPENCODE_ZEN_API_KEY=${escapeValue(keys.zen)}`);
      if (keys.groq) lines.push(`GROQ_API_KEY=${escapeValue(keys.groq)}`);
      if (keys.anthropic) lines.push(`ANTHROPIC_API_KEY=${escapeValue(keys.anthropic)}`);

      // Abstract default + per-slot {provider, model}; the entrypoint maps each
      // abstract provider (zen/groq/anthropic) to a runtime opencode provider.
      lines.push(`LL5_DEFAULT_PROVIDER=${escapeValue(config.default.provider)}`);
      lines.push(`LL5_DEFAULT_MODEL=${escapeValue(config.default.model)}`);
      const main = config.slots.main ?? config.default;
      lines.push(`LL5_SLOT_MAIN_PROVIDER=${escapeValue(main.provider)}`);
      lines.push(`LL5_SLOT_MAIN_MODEL=${escapeValue(main.model)}`);
      // Other slots: emit ONLY when explicitly set (unset → inherit default/main
      // at runtime, or the tool's own built-in default for image/audio).
      for (const slot of EMIT_SLOTS) {
        if (slot === 'main') continue;
        const ref = config.slots[slot];
        if (ref?.provider && ref?.model) {
          const up = slot.toUpperCase();
          lines.push(`LL5_SLOT_${up}_PROVIDER=${escapeValue(ref.provider)}`);
          lines.push(`LL5_SLOT_${up}_MODEL=${escapeValue(ref.model)}`);
        }
      }
    } else {
      // Claude-Code variant. Prefer the subscription OAuth token; fall back to a
      // plain Anthropic API key (the entrypoint accepts either). Emit the chosen
      // Claude model tier as ANTHROPIC_MODEL (skip the 'default' sentinel).
      if (env.keys['claude-code']) {
        lines.push(`CLAUDE_CODE_OAUTH_TOKEN=${escapeValue(env.keys['claude-code'])}`);
      } else if (env.keys.anthropic) {
        lines.push(`ANTHROPIC_API_KEY=${escapeValue(env.keys.anthropic)}`);
      }
      const m = env.config.default.model;
      if (m && m !== 'default') lines.push(`ANTHROPIC_MODEL=${escapeValue(m)}`);
    }
    lines.push('');
    await writeFile(target, lines.join('\n'), { mode: 0o600, encoding: 'utf8' });
    await chmod(target, 0o600);
    return target;
  }

  async remove(userId: string): Promise<void> {
    await rm(this.hostPathFor(userId), { force: true });
  }

  /**
   * Read the agent token back from the tenant's env-file (DECISION-027 follow-up).
   * The orchestrator can't MINT a token — the gateway does that at provision time —
   * but it already holds the last minted one on disk, and that is exactly what a
   * deploy-time image roll or a stale-heartbeat restart needs to re-provision the
   * same tenant. Until this existed, `agentTokenResolver` defaulted to `() => null`
   * and BOTH of those paths silently no-op'd ("no agent token"). Returns null when
   * there is no env-file (never provisioned / stopped) or no token line.
   */
  async readAgentToken(userId: string): Promise<string | null> {
    let text: string;
    try {
      text = await readFile(this.hostPathFor(userId), 'utf8');
    } catch {
      return null;
    }
    for (const line of text.split('\n')) {
      if (!line.startsWith('LL5_AGENT_TOKEN=')) continue;
      const raw = line.slice('LL5_AGENT_TOKEN='.length);
      const v = unescapeValue(raw);
      return v || null;
    }
    return null;
  }
}

/** Inverse of escapeValue: strip the single quotes and un-escape embedded ones. */
function unescapeValue(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1).replace(/'\\''/g, "'");
  }
  return t;
}
