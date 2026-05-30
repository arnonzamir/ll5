// Types + pure helpers for the "/settings/agent" (Your Agent) page.
// No "use server" directive — this module exports non-async values (types,
// constants, pure functions) shared by the client view, the server actions,
// and the unit tests. (Next 15 only allows async exports from "use server"
// modules, so anything synchronous must live here.)

/** The Anthropic API-key prefix the UI accepts today. The backend also supports
 *  an oauth_setup_token kind, but that path is dormant (no UI). */
export const ANTHROPIC_API_KEY_PREFIX = "sk-ant-";

/** Status of the user's stored Claude (LLM) credential. Mirrors
 *  GET /me/agent/llm-credential. Never carries the key itself — only `last4`. */
export interface LlmCredentialStatus {
  configured: boolean;
  /** Present only when configured. */
  kind?: "api_key" | "oauth_setup_token";
  /** Last 4 chars of the stored key — the only part ever shown. */
  last4?: string;
}

/** One row in GET /me/agent/credentials. Hash-only on the backend; never a token. */
export interface AgentCredential {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/** The once-returned connection kit from POST /me/agent/connection.
 *  `token` and `mcp_config` are shown exactly once and never re-fetchable. */
export interface ConnectionKit {
  credential_id: string;
  name: string;
  created_at: string;
  token: string;
  /** The rendered .mcp.json the container needs (JSON object). */
  mcp_config: unknown;
}

/**
 * Client-side shape check for the Anthropic API key. This is a fast UX guard
 * only — the gateway re-validates and is the source of truth (400 if bad).
 * Pure + secret-safe: takes the raw key, returns a boolean, never logs it.
 */
export function isLikelyAnthropicApiKey(key: string): boolean {
  return key.trim().startsWith(ANTHROPIC_API_KEY_PREFIX) && key.trim().length > ANTHROPIC_API_KEY_PREFIX.length;
}

/**
 * Render the masked "ending ••••<last4>" suffix for a configured credential.
 * Returns just the bullet+last4 fragment; callers wrap it in their own copy.
 * Secret-safe by construction: it only ever receives the already-truncated
 * `last4` from the gateway, never the full key.
 */
export function maskedKeyDisplay(last4: string | undefined): string {
  const tail = (last4 ?? "").slice(-4);
  return `••••${tail}`;
}

/** Human "Connected — key ending ••••1234" / "Not connected" status line. */
export function llmStatusLabel(status: LlmCredentialStatus): string {
  if (!status.configured) return "Not connected";
  return `Connected — key ending ${maskedKeyDisplay(status.last4)}`;
}

/** Pretty-print the once-shown mcp_config for the copy/download box. */
export function formatMcpConfig(mcpConfig: unknown): string {
  try {
    return JSON.stringify(mcpConfig, null, 2);
  } catch {
    return String(mcpConfig);
  }
}
