import type { Pool } from 'pg';
import { logger } from './logger.js';
import type { Runtime, RuntimeSpec } from './runtime/runtime.js';
import { SecretsWriter, ENV_FILE_TARGET } from './secrets.js';
import { buildConsoleLabels } from './console-labels.js';
import type { Encryptor } from './encryption.js';

export interface AgentRuntimeRow {
  user_id: string;
  container_id: string | null;
  host: string | null;
  status: 'none' | 'provisioning' | 'running' | 'stopped' | 'error';
  last_seen_at: Date | null;
  last_error: string | null;
  updated_at: Date | null;
}

export interface OrchestratorConfig {
  /** Hex AES-256 key for decrypting agent_llm_credentials.ciphertext. */
  encryptionKey: string;
  /** Default container image to launch (fallback when no per-provider image). */
  image: string;
  /** Per-provider images (anthropic → Claude image, opencode → opencode image). */
  imagesByProvider?: Partial<Record<'anthropic' | 'opencode', string>>;
  /** Per-host container cap. */
  maxContainersPerHost: number;
  /** Per-container hard memory limit, bytes. */
  memoryBytes: number;
  /** Docker restart policy name. */
  restartPolicy: string;
  /** Injected into the env-file as LL5_GATEWAY_URL. */
  gatewayUrl: string;
  /** Injected into the env-file as MCP_BASE_DOMAIN. */
  mcpBaseDomain: string;
  /** Docker network to attach per-user containers to (the ll5 stack network). */
  agentNetwork?: string;
  /** Base domain for per-user console subdomains (agent-<uid>.<base>). Empty =
   *  console disabled (no Traefik labels emitted). */
  consoleDomainBase?: string;
  /** In-network gateway URL Traefik forwardAuth calls (defaults to gatewayUrl). */
  consoleForwardAuthUrl?: string;
  /** A 'running' row older than this (seconds) is stale. */
  heartbeatTimeoutSec: number;
  /** Don't restart the same user more than once per this many seconds. */
  restartCooldownSec: number;
}

export interface OrchestratorDeps {
  runtime: Runtime;
  pool: Pool;
  encryptor: Encryptor;
  secrets: SecretsWriter;
  config: OrchestratorConfig;
  /** Injectable clock for tests. */
  now?: () => Date;
  /**
   * Resolve the agent token used to restart a stale user during reconcile().
   * Tokens are not persisted in plaintext; the gateway re-mints them. If this
   * returns null (the default), a stale agent is marked 'error' but not
   * restarted (the gateway/admin re-provisions explicitly).
   */
  agentTokenResolver?: (userId: string) => Promise<string | null>;
}

export class CapacityError extends Error {
  constructor() {
    super('capacity');
    this.name = 'CapacityError';
  }
}

export class MissingCredentialError extends Error {
  constructor() {
    super('no_llm_credential');
    this.name = 'MissingCredentialError';
  }
}

export class Orchestrator {
  private readonly runtime: Runtime;
  private readonly pool: Pool;
  private readonly encryptor: Encryptor;
  private readonly secrets: SecretsWriter;
  private readonly config: OrchestratorConfig;
  private readonly now: () => Date;
  private readonly agentTokenResolver: (userId: string) => Promise<string | null>;
  /** userId -> last restart timestamp (ms), for anti-flap. */
  private readonly lastRestart = new Map<string, number>();

  constructor(deps: OrchestratorDeps) {
    this.runtime = deps.runtime;
    this.pool = deps.pool;
    this.encryptor = deps.encryptor;
    this.secrets = deps.secrets;
    this.config = deps.config;
    this.now = deps.now ?? (() => new Date());
    this.agentTokenResolver = deps.agentTokenResolver ?? (async () => null);
  }

  // --- decryption -------------------------------------------------------

  private async loadCredential(userId: string): Promise<{
    provider: 'anthropic' | 'opencode';
    model: string | null;
    baseUrl: string | null;
    modelOverrides: Record<string, string>;
    apiKey: string;
  }> {
    const res = await this.pool.query<{
      ciphertext: string;
      provider: string | null;
      model: string | null;
      base_url: string | null;
      model_overrides: Record<string, string> | null;
    }>(
      'SELECT ciphertext, provider, model, base_url, model_overrides FROM agent_llm_credentials WHERE user_id = $1',
      [userId],
    );
    const row = res.rows[0];
    if (!row || !row.ciphertext) {
      throw new MissingCredentialError();
    }
    const provider = row.provider === 'opencode' ? 'opencode' : 'anthropic';
    return {
      provider,
      model: row.model ?? null,
      baseUrl: row.base_url ?? null,
      modelOverrides: row.model_overrides ?? {},
      apiKey: this.encryptor.decrypt(row.ciphertext, this.config.encryptionKey),
    };
  }

  // --- agent_runtimes I/O ----------------------------------------------

  private async setStatus(
    userId: string,
    status: AgentRuntimeRow['status'],
    fields: { containerId?: string | null; host?: string | null; lastError?: string | null } = {},
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_runtimes (user_id, status, container_id, host, last_error, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (user_id) DO UPDATE SET
         status = EXCLUDED.status,
         container_id = COALESCE(EXCLUDED.container_id, agent_runtimes.container_id),
         host = COALESCE(EXCLUDED.host, agent_runtimes.host),
         last_error = EXCLUDED.last_error,
         updated_at = now()`,
      [
        userId,
        status,
        fields.containerId ?? null,
        fields.host ?? null,
        fields.lastError ?? null,
      ],
    );
  }

  async statusForUser(userId: string): Promise<AgentRuntimeRow | null> {
    const res = await this.pool.query<AgentRuntimeRow>(
      `SELECT user_id, container_id, host, status, last_seen_at, last_error, updated_at
         FROM agent_runtimes WHERE user_id = $1`,
      [userId],
    );
    return res.rows[0] ?? null;
  }

  // --- lifecycle --------------------------------------------------------

  /**
   * Count live containers on the host the next provision would land on.
   * Single-host model: cap against the count of currently-running runtimes.
   */
  private async runningContainerCount(): Promise<number> {
    const res = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM agent_runtimes WHERE status IN ('running','provisioning')`,
    );
    return Number(res.rows[0]?.n ?? '0');
  }

  async provisionForUser(
    userId: string,
    agentToken: string,
  ): Promise<{ status: string; containerId: string; host: string }> {
    // (1) load + decrypt the user's LLM credential (errors if none).
    const cred = await this.loadCredential(userId);

    // (2) enforce the per-host container cap.
    const live = await this.runningContainerCount();
    const existing = await this.statusForUser(userId);
    const alreadyCounts = existing?.status === 'running' || existing?.status === 'provisioning';
    if (!alreadyCounts && live >= this.config.maxContainersPerHost) {
      await this.setStatus(userId, 'error', { lastError: 'capacity' });
      logger.warn('[orchestrator] capacity cap reached', {
        userId,
        live,
        cap: this.config.maxContainersPerHost,
      });
      throw new CapacityError();
    }

    // Mark provisioning before doing host work.
    await this.setStatus(userId, 'provisioning');

    // (3) write the 0600 secret env-file (host) — secrets never hit argv.
    const envFilePath = await this.secrets.write({
      userId,
      agentToken,
      apiKey: cred.apiKey,
      gatewayUrl: this.config.gatewayUrl,
      mcpBaseDomain: this.config.mcpBaseDomain,
      provider: cred.provider,
      model: cred.model,
      baseUrl: cred.baseUrl,
      modelOverrides: cred.modelOverrides,
    });

    // Per-provider image: opencode and Claude ship as separate images.
    const image = this.config.imagesByProvider?.[cred.provider] ?? this.config.image;

    // Per-user console route (Traefik). Only for the opencode variant (it serves
    // the web UI on :4096) and only when CONSOLE_DOMAIN_BASE is configured — else
    // buildConsoleLabels returns {} and no router is created.
    const consoleLabels =
      cred.provider === 'opencode'
        ? buildConsoleLabels(userId, this.config.consoleDomainBase, this.config.consoleForwardAuthUrl ?? this.config.gatewayUrl)
        : {};

    const spec: RuntimeSpec = {
      userId,
      image,
      envFilePath,
      envFileTarget: ENV_FILE_TARGET,
      memoryBytes: this.config.memoryBytes,
      labels: { 'll5.user_id': userId, ...consoleLabels },
      restartPolicy: this.config.restartPolicy,
      network: this.config.agentNetwork,
    };

    let result;
    try {
      result = await this.runtime.provision(spec);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.setStatus(userId, 'error', { lastError: msg });
      throw err;
    }

    // (4) upsert running.
    await this.setStatus(userId, 'running', {
      containerId: result.containerId,
      host: result.host,
      lastError: null,
    });
    logger.info('[orchestrator] provisioned', {
      userId,
      containerId: result.containerId,
      host: result.host,
    });
    return { status: 'running', containerId: result.containerId, host: result.host };
  }

  async stopForUser(userId: string): Promise<{ status: 'stopped' }> {
    await this.runtime.stop(userId);
    await this.secrets.remove(userId);
    await this.setStatus(userId, 'stopped', { containerId: null });
    logger.info('[orchestrator] stopped', { userId });
    return { status: 'stopped' };
  }

  // --- reconciliation ---------------------------------------------------

  /**
   * Mark 'running' rows whose heartbeat is stale as 'error', and restart them
   * (anti-flap: at most once per RESTART_COOLDOWN_SEC). Returns the userIds
   * that were acted on.
   */
  async reconcile(): Promise<{ stale: string[]; restarted: string[] }> {
    const timeoutMs = this.config.heartbeatTimeoutSec * 1000;
    const cooldownMs = this.config.restartCooldownSec * 1000;
    const nowMs = this.now().getTime();

    const res = await this.pool.query<AgentRuntimeRow>(
      `SELECT user_id, container_id, host, status, last_seen_at, last_error, updated_at
         FROM agent_runtimes WHERE status = 'running'`,
    );

    const stale: string[] = [];
    const restarted: string[] = [];

    for (const row of res.rows) {
      const lastSeen = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
      if (nowMs - lastSeen <= timeoutMs) continue;

      stale.push(row.user_id);
      await this.setStatus(row.user_id, 'error', { lastError: 'heartbeat_stale' });

      const last = this.lastRestart.get(row.user_id) ?? 0;
      if (nowMs - last < cooldownMs) {
        logger.warn('[orchestrator] stale but in restart cooldown', { userId: row.user_id });
        continue;
      }

      try {
        const token = await this.agentTokenResolver(row.user_id);
        if (token === null) {
          logger.warn('[orchestrator] cannot restart, no agent token', { userId: row.user_id });
          continue;
        }
        this.lastRestart.set(row.user_id, nowMs);
        await this.provisionForUser(row.user_id, token);
        restarted.push(row.user_id);
        logger.info('[orchestrator] restarted stale agent', { userId: row.user_id });
      } catch (err) {
        logger.error('[orchestrator] restart failed', {
          userId: row.user_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { stale, restarted };
  }
}
