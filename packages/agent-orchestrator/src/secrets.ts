import { mkdir, writeFile, chmod, rm } from 'node:fs/promises';
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

export interface SecretEnv {
  userId: string;
  agentToken: string;
  /** The user's decrypted provider API key (Anthropic key or Zen/opencode key). */
  apiKey: string;
  gatewayUrl: string;
  mcpBaseDomain: string;
  /** Which runtime variant this user's container runs. */
  provider: AgentProvider;
  /** Per-tenant model id (e.g. "deepseek-v4-flash-free"). Optional → image default. */
  model?: string | null;
  /** opencode server URL / provider base. Optional → image default. */
  baseUrl?: string | null;
  /**
   * Per-agent/per-tool model overrides (opencode only). Keyed by slot id
   * (grounder/narrative/reconcile); each emits its OPENCODE_<SLOT>_MODEL env
   * the sub-agent reads at spawn. Absent slots inherit `model`.
   */
  modelOverrides?: Record<string, string> | null;
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
      lines.push(`OPENCODE_ZEN_API_KEY=${escapeValue(env.apiKey)}`);
      lines.push(`OPENCODE_PROVIDER_ID=${escapeValue('opencode')}`);
      if (env.model) lines.push(`OPENCODE_MODEL_ID=${escapeValue(env.model)}`);
      if (env.baseUrl) lines.push(`OPENCODE_SERVER_URL=${escapeValue(env.baseUrl)}`);
      // Per-slot model overrides → OPENCODE_<SLOT>_MODEL (sub-agents read these).
      for (const [slot, model] of Object.entries(env.modelOverrides ?? {})) {
        const key = SLOT_ENV[slot];
        if (key && model) lines.push(`${key}=${escapeValue(model)}`);
      }
    } else {
      lines.push(`ANTHROPIC_API_KEY=${escapeValue(env.apiKey)}`);
    }
    lines.push('');
    await writeFile(target, lines.join('\n'), { mode: 0o600, encoding: 'utf8' });
    await chmod(target, 0o600);
    return target;
  }

  async remove(userId: string): Promise<void> {
    await rm(this.hostPathFor(userId), { force: true });
  }
}
