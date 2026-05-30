import { Router } from 'express';
import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import type { Pool } from 'pg';
import { generateToken } from '@ll5/shared';
import { chatAuthMiddleware } from './chat.js';
import { encryptSecret } from './utils/encryption.js';
import { logger } from './utils/logger.js';

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

/**
 * Create the agent-connection router. Mounted at the root; every route is
 * behind the chat auth middleware (self-scoped).
 */
export function createAgentRouter(
  pool: Pool,
  authSecret: string,
  encryptionKey: string | undefined,
  mcpBaseDomain: string,
): Router {
  const router = Router();
  const authMw = chatAuthMiddleware(authSecret);

  // POST /me/agent/connection — mint a long-TTL agent token + return the
  // one-time connection kit (token + .mcp.json). Stores only sha256(token).
  router.post('/me/agent/connection', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    const role = (req as Request & { userRole?: string }).userRole ?? 'user';
    const { name } = (req.body ?? {}) as { name?: string };

    const credName = typeof name === 'string' && name.trim().length > 0 ? name.trim().slice(0, 100) : 'agent';

    try {
      const token = generateToken(userId, authSecret, AGENT_TOKEN_TTL_DAYS, role);
      const tokenHash = sha256(token);

      const result = await pool.query<{ id: string; created_at: string }>(
        `INSERT INTO agent_credentials (user_id, name, token_hash)
         VALUES ($1, $2, $3)
         RETURNING id, created_at`,
        [userId, credName, tokenHash],
      );

      const row = result.rows[0];
      const mcpConfig = buildMcpConfig(token, mcpBaseDomain);

      logger.info('[agent][mintConnection] Agent credential minted', {
        userId,
        credentialId: row.id,
        name: credName,
      });

      // token + mcp_config returned ONCE here — never stored raw, never logged.
      res.status(201).json({
        credential_id: row.id,
        name: credName,
        created_at: row.created_at,
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
      res.json({ revoked: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[agent][revokeCredential] Failed', { userId, error: message });
      res.status(500).json({ error: message });
    }
  });

  // PUT /me/agent/llm-credential — store the user's BYO Anthropic API key,
  // encrypted at rest. Validates the prefix; NEVER logs or returns the key.
  router.put('/me/agent/llm-credential', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    const { api_key } = (req.body ?? {}) as { api_key?: string };

    if (!api_key || typeof api_key !== 'string' || !looksLikeAnthropicKey(api_key)) {
      res.status(400).json({ error: 'api_key must be a valid Anthropic API key (sk-ant-…)' });
      return;
    }

    if (!encryptionKey) {
      logger.error('[agent][putLlmCredential] ENCRYPTION_KEY not configured', { userId });
      res.status(500).json({ error: 'Secret storage not configured' });
      return;
    }

    const last4 = api_key.slice(-4);

    try {
      const ciphertext = encryptSecret(api_key, encryptionKey);
      await pool.query(
        `INSERT INTO agent_llm_credentials (user_id, kind, ciphertext, last4, updated_at)
         VALUES ($1, 'api_key', $2, $3, now())
         ON CONFLICT (user_id) DO UPDATE SET
           kind = 'api_key',
           ciphertext = EXCLUDED.ciphertext,
           last4 = EXCLUDED.last4,
           updated_at = now()`,
        [userId, ciphertext, last4],
      );
      logger.info('[agent][putLlmCredential] LLM credential set', { userId, kind: 'api_key', last4 });
      res.json({ configured: true, kind: 'api_key', last4 });
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
      const result = await pool.query<{ kind: string; last4: string | null }>(
        `SELECT kind, last4 FROM agent_llm_credentials WHERE user_id = $1`,
        [userId],
      );
      if (result.rows.length === 0) {
        res.json({ configured: false });
        return;
      }
      const row = result.rows[0];
      res.json({ configured: true, kind: row.kind, last4: row.last4 });
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

  return router;
}
