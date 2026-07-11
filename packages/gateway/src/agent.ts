import { Router } from 'express';
import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import type { Pool } from 'pg';
import { generateToken } from '@ll5/shared';
import { chatAuthMiddleware } from './chat.js';
import { registerConsoleRoutes } from './console.js';
import { encryptSecret } from './utils/encryption.js';
import { logger } from './utils/logger.js';
import {
  defaultOrchestratorClient,
  OrchestratorNotConfiguredError,
  type OrchestratorClient,
  type OrchestratorRuntime,
} from './utils/orchestrator.js';

// ---------------------------------------------------------------------------
// Agent connection plane (P3) — the kit a per-user container needs to act as a
// tenant. All routes are self-scoped: the caller's user_id comes from the auth
// token claim (NEVER a param/body), and every query filters by it.
//
// SECURITY: secrets are never logged or returned, except the one-time raw
// credential return on mint. The agent token is stored only as sha256; the BYO
// Claude credential is stored AES-256-GCM-encrypted (encryptSecret).
// ---------------------------------------------------------------------------

const AGENT_TOKEN_TTL_DAYS = 90;

/** The 6 remote MCPs exposed to the agent container. Tuple: [mcp.json key,
 *  subdomain prefix]. The channel MCP is a local stdio bridge configured by
 *  ll5-run and is intentionally NOT included here. */
const MCP_ENDPOINTS: ReadonlyArray<readonly [string, string]> = [
  ['ll5-knowledge', 'mcp-knowledge'],
  ['ll5-gtd', 'mcp-gtd'],
  ['ll5-awareness', 'mcp-awareness'],
  ['ll5-calendar', 'mcp-google'],
  ['ll5-health', 'mcp-health'],
  ['ll5-messaging', 'mcp-messaging'],
];

interface McpServerEntry {
  type: 'http';
  url: string;
  headers: { Authorization: string };
}

/** Build a Claude Code .mcp.json object: the 6 remote MCP HTTPS endpoints,
 *  each authenticated with the freshly-minted agent token. */
function buildMcpConfig(token: string, baseDomain: string): { mcpServers: Record<string, McpServerEntry> } {
  const mcpServers: Record<string, McpServerEntry> = {};
  for (const [key, sub] of MCP_ENDPOINTS) {
    mcpServers[key] = {
      type: 'http',
      url: `https://${sub}.${baseDomain}/mcp`,
      headers: { Authorization: `Bearer ${token}` },
    };
  }
  return { mcpServers };
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** Anthropic API keys look like `sk-ant-...`. Validate the prefix and a
 *  reasonable length envelope without ever logging the value. */
function looksLikeAnthropicKey(key: string): boolean {
  return (
    typeof key === 'string' &&
    key.startsWith('sk-ant-') &&
    key.length >= 20 &&
    key.length <= 300
  );
}

// Per-provider agent LLM config: which key format is accepted and the models
// the UI offers. `opencode` and `opencode-go` are the same Zen provider with
// DIFFERENT accounts/keys (go = a separate Zen workspace); both resolve to the
// container-side provider id "opencode" with the same model catalog.
export const PROVIDERS = ['anthropic', 'opencode', 'opencode-go'] as const;
export type AgentLlmProvider = (typeof PROVIDERS)[number];

// The full opencode Zen model catalog (from `opencode models`). Offered for both
// opencode and opencode-go. Validation for these providers is permissive (any
// non-empty model is accepted) so newly-released Zen models work without a code
// change — this list drives the dropdown, not a hard allow-list.
const OPENCODE_MODELS = [
  'deepseek-v4-flash-free', 'deepseek-v4-flash', 'deepseek-v4-pro',
  'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5', 'claude-opus-4-1',
  'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4',
  'claude-haiku-4-5', 'claude-fable-5',
  'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.5-pro', 'gpt-5.5', 'gpt-5.4-pro',
  'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.3-codex', 'gpt-5.3-codex-spark',
  'gpt-5.2', 'gpt-5.2-codex', 'gpt-5.1', 'gpt-5.1-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini',
  'gpt-5', 'gpt-5-codex', 'gpt-5-nano',
  'gemini-3.5-flash', 'gemini-3.1-pro', 'gemini-3-flash',
  'glm-5.2', 'glm-5.1', 'glm-5',
  'grok-4.5', 'grok-build-0.1',
  'kimi-k2.7-code', 'kimi-k2.6', 'kimi-k2.5',
  'minimax-m3', 'minimax-m2.7', 'minimax-m2.5',
  'qwen3.6-plus', 'qwen3.5-plus',
  'big-pickle', 'hy3-free', 'mimo-v2.5-free', 'nemotron-3-ultra-free', 'north-mini-code-free',
];

export const MODEL_CATALOG: Record<AgentLlmProvider, { label: string; models: string[] }> = {
  anthropic: {
    label: 'Claude (Anthropic)',
    models: ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
  },
  opencode: {
    label: 'opencode Zen',
    models: OPENCODE_MODELS,
  },
  'opencode-go': {
    label: 'opencode Zen (Go account)',
    models: OPENCODE_MODELS,
  },
};

/** opencode-family providers share the Zen backend + permissive model validation. */
function isOpencodeProvider(p: AgentLlmProvider): boolean {
  return p === 'opencode' || p === 'opencode-go';
}

/** Validate a model for a provider. opencode/opencode-go accept any non-empty
 *  model (the catalog is a UI hint, not an allow-list); anthropic is strict. */
function modelValidForProvider(provider: AgentLlmProvider, model: string): boolean {
  if (isOpencodeProvider(provider)) return model.length > 0 && model.length <= 100;
  return MODEL_CATALOG[provider].models.includes(model);
}

// Per-agent/per-tool model slots the user can override independently of the main
// model. Each slot maps to a container env var the corresponding sub-agent reads
// at spawn time (auto-ground.ts / narrative-loop.ts / reconcile-loop.ts). An
// empty/absent override means the slot inherits the main `model`. Only the
// opencode runtime spawns these sub-agents, so slots are opencode-scoped.
export interface AgentModelSlot {
  slot: string;
  label: string;
  description: string;
  /** Container env var the orchestrator emits for this slot. */
  env: string;
}
export const AGENT_MODEL_SLOTS: AgentModelSlot[] = [
  {
    slot: 'grounder',
    label: 'Grounder (auto-recall)',
    description: 'Read-only context recall injected before proactive turns.',
    env: 'OPENCODE_GROUNDER_MODEL',
  },
  {
    slot: 'narrative',
    label: 'Narrative consolidator',
    description: 'Off-agent batch narrative maintenance loop.',
    env: 'OPENCODE_NARRATIVE_MODEL',
  },
  {
    slot: 'reconcile',
    label: 'Reconcile worker',
    description: 'Off-agent open-loop reconciliation loop.',
    env: 'OPENCODE_RECONCILE_MODEL',
  },
];
const AGENT_MODEL_SLOT_IDS = new Set(AGENT_MODEL_SLOTS.map((s) => s.slot));

/**
 * Validate + normalize a model_overrides map against a provider's catalog.
 * Returns the cleaned map, or an error string. Unknown slots and empty values
 * are dropped; every kept value must be in the provider's model list.
 */
export function sanitizeModelOverrides(
  provider: AgentLlmProvider,
  raw: unknown,
): { overrides: Record<string, string> } | { error: string } {
  if (raw == null) return { overrides: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'model_overrides must be an object' };
  }
  const out: Record<string, string> = {};
  for (const [slot, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!AGENT_MODEL_SLOT_IDS.has(slot)) continue;
    if (value == null || value === '') continue;
    if (typeof value !== 'string' || !modelValidForProvider(provider, value)) {
      return { error: `model_overrides.${slot} is not a valid model for ${provider}` };
    }
    out[slot] = value;
  }
  return { overrides: out };
}

/** Validate a key for the given provider without logging it. */
function keyValidForProvider(provider: AgentLlmProvider, key: string): boolean {
  if (typeof key !== 'string' || key.length < 8 || key.length > 400) return false;
  if (provider === 'anthropic') return looksLikeAnthropicKey(key);
  // opencode/Zen keys have no fixed public prefix — accept any non-trivial token.
  return isOpencodeProvider(provider);
}

/**
 * Mint a fresh 90-day agent token for `userId`/`role` and record it (hash only)
 * in agent_credentials. Returns the raw token (caller must not store/log it
 * beyond handing it to the orchestrator). Shared by the connection-kit endpoint
 * and the provision endpoints so there is one mint path.
 */
export async function mintAgentToken(
  pool: Pool,
  authSecret: string,
  userId: string,
  role: string,
  name = 'agent',
): Promise<{ token: string; credentialId: string; createdAt: string }> {
  const token = generateToken(userId, authSecret, AGENT_TOKEN_TTL_DAYS, role);
  const tokenHash = sha256(token);
  const result = await pool.query<{ id: string; created_at: string }>(
    `INSERT INTO agent_credentials (user_id, name, token_hash)
     VALUES ($1, $2, $3)
     RETURNING id, created_at`,
    [userId, name, tokenHash],
  );
  return { token, credentialId: result.rows[0].id, createdAt: result.rows[0].created_at };
}

/**
 * Upsert the agent_runtimes row from an orchestrator result. Maps the
 * orchestrator's returned status/container/host into the row and returns the
 * console-shaped runtime view.
 */
export async function upsertRuntimeRow(
  pool: Pool,
  userId: string,
  runtime: OrchestratorRuntime,
): Promise<RuntimeView> {
  await pool.query(
    `INSERT INTO agent_runtimes (user_id, container_id, host, status, last_error, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (user_id) DO UPDATE SET
       container_id = EXCLUDED.container_id,
       host = EXCLUDED.host,
       status = EXCLUDED.status,
       last_error = EXCLUDED.last_error,
       updated_at = now()`,
    [
      userId,
      runtime.container_id ?? null,
      runtime.host ?? null,
      runtime.status,
      runtime.last_error ?? null,
    ],
  );
  return {
    status: runtime.status,
    container_id: runtime.container_id ?? null,
    host: runtime.host ?? null,
    last_seen_at: runtime.last_seen_at ?? null,
    last_error: runtime.last_error ?? null,
  };
}

/** The agent_runtimes view returned to the dashboard. */
export interface RuntimeView {
  status: string;
  container_id: string | null;
  host: string | null;
  last_seen_at: string | null;
  last_error: string | null;
}

/**
 * Create the agent-connection router. Mounted at the root; every route is
 * behind the chat auth middleware (self-scoped).
 *
 * @param orchestrator injectable orchestrator client (defaults to the env-backed
 *   real client; tests inject a mock).
 */
export function createAgentRouter(
  pool: Pool,
  authSecret: string,
  encryptionKey: string | undefined,
  mcpBaseDomain: string,
  orchestrator: OrchestratorClient = defaultOrchestratorClient,
): Router {
  const router = Router();
  const authMw = chatAuthMiddleware(authSecret);

  // Per-user opencode console routes (enter handshake + Traefik forwardAuth).
  registerConsoleRoutes(router, authSecret);

  // POST /me/agent/connection — mint a long-TTL agent token + return the
  // one-time connection kit (token + .mcp.json). Stores only sha256(token).
  router.post('/me/agent/connection', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    const role = (req as Request & { userRole?: string }).userRole ?? 'user';
    const { name } = (req.body ?? {}) as { name?: string };

    const credName = typeof name === 'string' && name.trim().length > 0 ? name.trim().slice(0, 100) : 'agent';

    try {
      const { token, credentialId, createdAt } = await mintAgentToken(pool, authSecret, userId, role, credName);
      const mcpConfig = buildMcpConfig(token, mcpBaseDomain);

      logger.info('[agent][mintConnection] Agent credential minted', {
        userId,
        credentialId,
        name: credName,
      });

      // token + mcp_config returned ONCE here — never stored raw, never logged.
      res.status(201).json({
        credential_id: credentialId,
        name: credName,
        created_at: createdAt,
        token,
        mcp_config: mcpConfig,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[agent][mintConnection] Failed', { userId, error: message });
      res.status(500).json({ error: message });
    }
  });

  // GET /me/agent/credentials — list the caller's agent credentials.
  // Never returns token_hash or the raw token.
  router.get('/me/agent/credentials', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    try {
      const result = await pool.query(
        `SELECT id, name, last_used_at, revoked_at, created_at
         FROM agent_credentials
         WHERE user_id = $1
         ORDER BY created_at DESC`,
        [userId],
      );
      res.json({ credentials: result.rows });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[agent][listCredentials] Failed', { userId, error: message });
      res.status(500).json({ error: message });
    }
  });

  // DELETE /me/agent/credentials/:id — revoke a credential (scoped to caller).
  router.delete('/me/agent/credentials/:id', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    const id = req.params.id;
    try {
      const result = await pool.query<{ id: string }>(
        `UPDATE agent_credentials
         SET revoked_at = now()
         WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
         RETURNING id`,
        [id, userId],
      );
      if (result.rowCount === 0) {
        // Either not theirs, doesn't exist, or already revoked → 404 (no disclosure).
        res.status(404).json({ error: 'Not found' });
        return;
      }
      logger.info('[agent][revokeCredential] Agent credential revoked', { userId, credentialId: id });

      // P5 lifecycle: revoking the agent credential pulls the container's MCP
      // access on its next token refresh anyway, but stopping is immediate.
      // Best-effort — never fail the revoke on an orchestrator hiccup.
      try {
        const runtime = await orchestrator.stop(userId);
        await upsertRuntimeRow(pool, userId, runtime);
        logger.info('[agent][revokeCredential] runtime_stopped', {
          userId,
          reason: 'credential_revoked',
          status: runtime.status,
        });
      } catch (stopErr) {
        if (stopErr instanceof OrchestratorNotConfiguredError) {
          logger.info('[agent][revokeCredential] runtime stop skipped (orchestrator not configured)', { userId });
        } else {
          logger.warn('[agent][revokeCredential] runtime stop failed (non-fatal)', {
            userId,
            reason: 'credential_revoked',
            error: stopErr instanceof Error ? stopErr.message : String(stopErr),
          });
        }
      }

      res.json({ revoked: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[agent][revokeCredential] Failed', { userId, error: message });
      res.status(500).json({ error: message });
    }
  });

  // PUT /me/agent/llm-credential — store the user's BYO Anthropic API key,
  // encrypted at rest. Validates the prefix; NEVER logs or returns the key.
  // GET /me/agent/models — provider + model catalog for the settings UI.
  router.get('/me/agent/models', authMw, async (_req: Request, res: Response) => {
    res.json({
      providers: PROVIDERS.map((p) => ({
        provider: p,
        label: MODEL_CATALOG[p].label,
        models: MODEL_CATALOG[p].models,
      })),
      // Per-agent/per-tool slots (opencode only) the user can override.
      slots: AGENT_MODEL_SLOTS,
    });
  });

  router.put('/me/agent/llm-credential', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    const body = (req.body ?? {}) as {
      api_key?: string; provider?: string; model?: string; base_url?: string;
      model_overrides?: unknown;
    };
    const api_key = body.api_key;

    // Keyless model-config update: no new key, but a credential already exists.
    // Lets the user retune model / model_overrides / base_url without re-pasting
    // the key. Validates against the STORED provider; the key/ciphertext is left
    // untouched.
    if (!api_key) {
      if (!encryptionKey) {
        res.status(500).json({ error: 'Secret storage not configured' });
        return;
      }
      const existing = await pool.query<{ provider: string | null; last4: string | null }>(
        'SELECT provider, last4 FROM agent_llm_credentials WHERE user_id = $1',
        [userId],
      );
      if (existing.rows.length === 0) {
        res.status(400).json({ error: 'api_key required (no stored credential to update)' });
        return;
      }
      const storedProvider = (existing.rows[0].provider ?? 'anthropic') as AgentLlmProvider;
      const model2 = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null;
      if (model2 && !modelValidForProvider(storedProvider, model2)) {
        res.status(400).json({ error: `model is not valid for ${storedProvider}` });
        return;
      }
      const base_url2 = typeof body.base_url === 'string' && body.base_url.trim() ? body.base_url.trim() : null;
      const sane = sanitizeModelOverrides(storedProvider, body.model_overrides);
      if ('error' in sane) {
        res.status(400).json({ error: sane.error });
        return;
      }
      try {
        await pool.query(
          `UPDATE agent_llm_credentials
             SET model = $2, base_url = $3, model_overrides = $4, updated_at = now()
           WHERE user_id = $1`,
          [userId, model2, base_url2, JSON.stringify(sane.overrides)],
        );
        logger.info('[agent][putLlmCredential] model config updated (keyless)', { userId, provider: storedProvider, model: model2 });
        res.json({
          configured: true, kind: 'api_key', provider: storedProvider,
          model: model2, base_url: base_url2, model_overrides: sane.overrides,
          last4: existing.rows[0].last4,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('[agent][putLlmCredential] keyless update failed', { userId, error: message });
        res.status(500).json({ error: message });
      }
      return;
    }

    // Back-compat: default to anthropic (the old key-only contract).
    const provider = (body.provider ?? 'anthropic') as AgentLlmProvider;

    if (!PROVIDERS.includes(provider)) {
      res.status(400).json({ error: `provider must be one of: ${PROVIDERS.join(', ')}` });
      return;
    }
    if (!api_key || !keyValidForProvider(provider, api_key)) {
      res.status(400).json({
        error: provider === 'anthropic'
          ? 'api_key must be a valid Anthropic API key (sk-ant-…)'
          : 'api_key must be a valid opencode/Zen API key',
      });
      return;
    }
    const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : null;
    if (model && !modelValidForProvider(provider, model)) {
      res.status(400).json({ error: `model is not valid for ${provider}` });
      return;
    }
    const base_url = typeof body.base_url === 'string' && body.base_url.trim() ? body.base_url.trim() : null;

    const sanitized = sanitizeModelOverrides(provider, body.model_overrides);
    if ('error' in sanitized) {
      res.status(400).json({ error: sanitized.error });
      return;
    }
    const model_overrides = sanitized.overrides;

    if (!encryptionKey) {
      logger.error('[agent][putLlmCredential] ENCRYPTION_KEY not configured', { userId });
      res.status(500).json({ error: 'Secret storage not configured' });
      return;
    }

    const last4 = api_key.slice(-4);

    try {
      const ciphertext = encryptSecret(api_key, encryptionKey);
      await pool.query(
        `INSERT INTO agent_llm_credentials (user_id, kind, ciphertext, last4, provider, model, base_url, model_overrides, updated_at)
         VALUES ($1, 'api_key', $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (user_id) DO UPDATE SET
           kind = 'api_key',
           ciphertext = EXCLUDED.ciphertext,
           last4 = EXCLUDED.last4,
           provider = EXCLUDED.provider,
           model = EXCLUDED.model,
           base_url = EXCLUDED.base_url,
           model_overrides = EXCLUDED.model_overrides,
           updated_at = now()`,
        [userId, ciphertext, last4, provider, model, base_url, JSON.stringify(model_overrides)],
      );
      logger.info('[agent][putLlmCredential] LLM credential set', { userId, provider, model, last4 });
      res.json({ configured: true, kind: 'api_key', provider, model, base_url, model_overrides, last4 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[agent][putLlmCredential] Failed', { userId, error: message });
      res.status(500).json({ error: message });
    }
  });

  // GET /me/agent/llm-credential — status only (never the secret).
  router.get('/me/agent/llm-credential', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    try {
      const result = await pool.query<{
        kind: string; last4: string | null; provider: string | null; model: string | null;
        base_url: string | null; model_overrides: Record<string, string> | null;
      }>(
        `SELECT kind, last4, provider, model, base_url, model_overrides FROM agent_llm_credentials WHERE user_id = $1`,
        [userId],
      );
      if (result.rows.length === 0) {
        res.json({ configured: false });
        return;
      }
      const row = result.rows[0];
      res.json({
        configured: true,
        kind: row.kind,
        last4: row.last4,
        provider: row.provider ?? 'anthropic',
        model: row.model,
        base_url: row.base_url,
        model_overrides: row.model_overrides ?? {},
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[agent][getLlmCredential] Failed', { userId, error: message });
      res.status(500).json({ error: message });
    }
  });

  // DELETE /me/agent/llm-credential — remove the stored credential.
  router.delete('/me/agent/llm-credential', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    try {
      await pool.query('DELETE FROM agent_llm_credentials WHERE user_id = $1', [userId]);
      logger.info('[agent][deleteLlmCredential] LLM credential removed', { userId });
      res.json({ configured: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[agent][deleteLlmCredential] Failed', { userId, error: message });
      res.status(500).json({ error: message });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /me/agent/provision — provision the caller's agent container.
  // Requires a configured BYO Claude credential first. Mints a fresh agent
  // token, asks the orchestrator to launch, and records the runtime state.
  // ---------------------------------------------------------------------------
  router.post('/me/agent/provision', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    const role = (req as Request & { userRole?: string }).userRole ?? 'user';
    try {
      const cred = await pool.query(
        'SELECT 1 FROM agent_llm_credentials WHERE user_id = $1',
        [userId],
      );
      if (cred.rows.length === 0) {
        res.status(400).json({ error: 'connect your LLM API key first' });
        return;
      }

      const { token } = await mintAgentToken(pool, authSecret, userId, role);
      const runtime = await orchestrator.provision(userId, token);
      const view = await upsertRuntimeRow(pool, userId, runtime);
      logger.info('[agent][provision]', { userId, status: view.status });
      res.json({ runtime: view });
    } catch (err) {
      if (err instanceof OrchestratorNotConfiguredError) {
        logger.warn('[agent][provision] orchestrator not configured', { userId });
        res.status(503).json({ error: 'Agent runtime is not configured yet' });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[agent][provision] Failed', { userId, error: message });
      res.status(500).json({ error: message });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /me/agent/stop — stop the caller's agent container.
  // ---------------------------------------------------------------------------
  router.post('/me/agent/stop', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    try {
      const runtime = await orchestrator.stop(userId);
      const view = await upsertRuntimeRow(pool, userId, runtime);
      logger.info('[agent][stop]', { userId, status: view.status });
      res.json({ runtime: view });
    } catch (err) {
      if (err instanceof OrchestratorNotConfiguredError) {
        logger.warn('[agent][stop] orchestrator not configured', { userId });
        res.status(503).json({ error: 'Agent runtime is not configured yet' });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[agent][stop] Failed', { userId, error: message });
      res.status(500).json({ error: message });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /me/agent/runtime — the caller's agent_runtimes row (or {status:'none'}).
  // ---------------------------------------------------------------------------
  router.get('/me/agent/runtime', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    try {
      const result = await pool.query<RuntimeView>(
        `SELECT status, container_id, host, last_seen_at, last_error
         FROM agent_runtimes WHERE user_id = $1`,
        [userId],
      );
      if (result.rows.length === 0) {
        res.json({ runtime: { status: 'none', container_id: null, host: null, last_seen_at: null, last_error: null } });
        return;
      }
      res.json({ runtime: result.rows[0] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[agent][runtime] Failed', { userId, error: message });
      res.status(500).json({ error: message });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /me/agent/heartbeat — called BY the in-container channel MCP using its
  // own agent token. Marks the runtime running + bumps last_seen_at, scoped to
  // the caller's user_id (from the token claim, never a body field).
  // ---------------------------------------------------------------------------
  router.post('/me/agent/heartbeat', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    try {
      await pool.query(
        `INSERT INTO agent_runtimes (user_id, status, last_seen_at, updated_at)
         VALUES ($1, 'running', now(), now())
         ON CONFLICT (user_id) DO UPDATE SET
           last_seen_at = now(),
           status = 'running',
           updated_at = now()`,
        [userId],
      );
      logger.info('[agent][heartbeat]', { userId, status: 'running' });
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[agent][heartbeat] Failed', { userId, error: message });
      res.status(500).json({ error: message });
    }
  });

  return router;
}
