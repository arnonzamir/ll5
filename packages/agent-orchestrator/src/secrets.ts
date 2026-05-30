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
 * The env-file contains exactly these keys (KEY=value, one per line):
 *   LL5_USER_ID, LL5_AGENT_TOKEN, ANTHROPIC_API_KEY, LL5_GATEWAY_URL, MCP_BASE_DOMAIN
 * Mounted read-only at the path the orchestrator passes as LL5_AGENT_ENV_FILE
 * (default /run/ll5/agent.env). The entrypoint MUST `set -a; . "$file"; set +a`
 * before launching Claude Code so the credential never appears in argv.
 */
export interface SecretEnv {
  userId: string;
  agentToken: string;
  anthropicApiKey: string;
  gatewayUrl: string;
  mcpBaseDomain: string;
}

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
    const lines = [
      `LL5_USER_ID=${escapeValue(env.userId)}`,
      `LL5_AGENT_TOKEN=${escapeValue(env.agentToken)}`,
      `ANTHROPIC_API_KEY=${escapeValue(env.anthropicApiKey)}`,
      `LL5_GATEWAY_URL=${escapeValue(env.gatewayUrl)}`,
      `MCP_BASE_DOMAIN=${escapeValue(env.mcpBaseDomain)}`,
      '',
    ];
    await writeFile(target, lines.join('\n'), { mode: 0o600, encoding: 'utf8' });
    await chmod(target, 0o600);
    return target;
  }

  async remove(userId: string): Promise<void> {
    await rm(this.hostPathFor(userId), { force: true });
  }
}
