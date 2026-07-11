"use server";

import { getToken } from "@/lib/auth";
import { env } from "@/lib/env";
import {
  isLikelyAnthropicApiKey,
  parseRuntime,
  type AgentCredential,
  type AgentModelsCatalog,
  type AgentRuntime,
  type ConnectionKit,
  type LlmCredentialStatus,
} from "./agent-types";

/* ---------- gateway helpers (mirror user-settings server actions) ---------- */

async function authHeaders(): Promise<Record<string, string> | null> {
  const token = await getToken();
  if (!token) return null;
  return { Authorization: `Bearer ${token}` };
}

/* ---------- Claude (LLM) credential ---------- */

/** GET /me/agent/llm-credential — status only (never the key, only last4). */
export async function fetchLlmCredential(): Promise<LlmCredentialStatus> {
  const headers = await authHeaders();
  if (!headers) return { configured: false };
  try {
    const res = await fetch(`${env.GATEWAY_URL}/me/agent/llm-credential`, {
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { configured: false };
    const raw = (await res.json()) as Record<string, unknown>;
    return {
      configured: raw.configured === true,
      kind: raw.kind as LlmCredentialStatus["kind"],
      last4: typeof raw.last4 === "string" ? raw.last4 : undefined,
      provider: raw.provider as LlmCredentialStatus["provider"],
      model: (raw.model as string | null) ?? null,
      base_url: (raw.base_url as string | null) ?? null,
      model_overrides:
        raw.model_overrides && typeof raw.model_overrides === "object"
          ? (raw.model_overrides as Record<string, string>)
          : {},
    };
  } catch (err) {
    // Never include the key in any log line.
    console.error("[agent] fetchLlmCredential failed:", err instanceof Error ? err.message : String(err));
    return { configured: false };
  }
}

/** GET /me/agent/models — provider + model catalog for the settings dropdowns. */
export async function fetchAgentModels(): Promise<AgentModelsCatalog> {
  const headers = await authHeaders();
  const empty: AgentModelsCatalog = { providers: [] };
  if (!headers) return empty;
  try {
    const res = await fetch(`${env.GATEWAY_URL}/me/agent/models`, { headers, cache: "no-store" });
    if (!res.ok) return empty;
    const raw = (await res.json()) as AgentModelsCatalog;
    return Array.isArray(raw.providers) ? raw : empty;
  } catch (err) {
    console.error("[agent] fetchAgentModels failed:", err instanceof Error ? err.message : String(err));
    return empty;
  }
}

/**
 * PUT /me/agent/llm-credential — store the user's Anthropic API key.
 * The key is write-only: it is sent once and never returned. We do a cheap
 * client-shape check first, but the gateway is the source of truth (400 if bad).
 * The raw key is NEVER logged.
 */
export async function saveLlmCredential(
  input:
    | string
    | {
        apiKey: string;
        provider?: "anthropic" | "opencode" | "opencode-go";
        model?: string | null;
        baseUrl?: string | null;
        modelOverrides?: Record<string, string>;
      },
): Promise<{ ok: boolean; status?: LlmCredentialStatus; error?: string }> {
  const headers = await authHeaders();
  if (!headers) return { ok: false, error: "Not authenticated" };

  // Back-compat: a bare string is an Anthropic key.
  const opts = typeof input === "string" ? { apiKey: input, provider: "anthropic" as const } : input;
  const provider = opts.provider ?? "anthropic";
  const trimmed = opts.apiKey.trim();
  // Empty key = keyless config update (retune model/overrides on an existing
  // credential). Only validate the key when one is actually being set.
  const keyless = trimmed.length === 0;
  if (!keyless) {
    if (provider === "anthropic" && !isLikelyAnthropicApiKey(trimmed)) {
      return { ok: false, error: "That doesn't look like an Anthropic API key (expected sk-ant-…)." };
    }
    if (trimmed.length < 8) {
      return { ok: false, error: "That key looks too short." };
    }
  }

  try {
    const res = await fetch(`${env.GATEWAY_URL}/me/agent/llm-credential`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: keyless ? undefined : trimmed,
        provider: keyless ? undefined : provider,
        model: opts.model ?? undefined,
        base_url: opts.baseUrl ?? undefined,
        model_overrides: opts.modelOverrides ?? undefined,
      }),
    });
    if (!res.ok) {
      if (res.status === 400) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        return { ok: false, error: body.error ?? "The key or model was rejected." };
      }
      console.error("[agent] saveLlmCredential failed:", res.status);
      return { ok: false, error: `Save failed (${res.status}).` };
    }
    const raw = (await res.json()) as Record<string, unknown>;
    return {
      ok: true,
      status: {
        configured: raw.configured === true,
        kind: raw.kind as LlmCredentialStatus["kind"],
        last4: typeof raw.last4 === "string" ? raw.last4 : undefined,
        provider: raw.provider as LlmCredentialStatus["provider"],
        model: (raw.model as string | null) ?? null,
        base_url: (raw.base_url as string | null) ?? null,
        model_overrides:
          raw.model_overrides && typeof raw.model_overrides === "object"
            ? (raw.model_overrides as Record<string, string>)
            : {},
      },
    };
  } catch (err) {
    console.error("[agent] saveLlmCredential failed:", err instanceof Error ? err.message : String(err));
    return { ok: false, error: "Network error while saving the key." };
  }
}

/** DELETE /me/agent/llm-credential — remove the stored Claude credential. */
export async function removeLlmCredential(): Promise<{ ok: boolean }> {
  const headers = await authHeaders();
  if (!headers) return { ok: false };
  try {
    const res = await fetch(`${env.GATEWAY_URL}/me/agent/llm-credential`, {
      method: "DELETE",
      headers,
    });
    return { ok: res.ok };
  } catch (err) {
    console.error("[agent] removeLlmCredential failed:", err instanceof Error ? err.message : String(err));
    return { ok: false };
  }
}

/* ---------- Connection kit (agent credential) ---------- */

/** GET /me/agent/credentials — list issued agent credentials (hash-only). */
export async function fetchAgentCredentials(): Promise<AgentCredential[]> {
  const headers = await authHeaders();
  if (!headers) return [];
  try {
    const res = await fetch(`${env.GATEWAY_URL}/me/agent/credentials`, {
      headers,
      cache: "no-store",
    });
    if (!res.ok) return [];
    const raw = (await res.json()) as { credentials?: unknown };
    const list = Array.isArray(raw.credentials) ? raw.credentials : [];
    return list.map((c) => {
      const row = c as Record<string, unknown>;
      return {
        id: String(row.id),
        name: typeof row.name === "string" ? row.name : "agent",
        created_at: String(row.created_at ?? ""),
        last_used_at: (row.last_used_at as string | null) ?? null,
        revoked_at: (row.revoked_at as string | null) ?? null,
      };
    });
  } catch (err) {
    console.error("[agent] fetchAgentCredentials failed:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

/**
 * POST /me/agent/connection — mint a new connection kit.
 * Returns the token + mcp_config exactly ONCE; they are never re-fetchable.
 * The token is returned to the client to display once, but is NEVER logged here.
 */
export async function generateConnection(
  name?: string,
): Promise<{ ok: boolean; kit?: ConnectionKit; error?: string }> {
  const headers = await authHeaders();
  if (!headers) return { ok: false, error: "Not authenticated" };
  try {
    const res = await fetch(`${env.GATEWAY_URL}/me/agent/connection`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(name && name.trim() ? { name: name.trim() } : {}),
    });
    if (!res.ok) {
      console.error("[agent] generateConnection failed:", res.status);
      return { ok: false, error: `Could not generate connection (${res.status}).` };
    }
    const raw = (await res.json()) as Record<string, unknown>;
    return {
      ok: true,
      kit: {
        credential_id: String(raw.credential_id ?? ""),
        name: typeof raw.name === "string" ? raw.name : "agent",
        created_at: String(raw.created_at ?? ""),
        token: String(raw.token ?? ""),
        mcp_config: raw.mcp_config ?? {},
      },
    };
  } catch (err) {
    console.error("[agent] generateConnection failed:", err instanceof Error ? err.message : String(err));
    return { ok: false, error: "Network error while generating the connection." };
  }
}

/** GET /me/agent/console/enter — mint a console URL (opencode web UI) for the
 *  caller's container. Returns { url } to open in a new tab, or an error (503 if
 *  the console feature isn't enabled server-side). */
export async function fetchConsoleUrl(): Promise<{ ok: boolean; url?: string; error?: string }> {
  const headers = await authHeaders();
  if (!headers) return { ok: false, error: "Not authenticated" };
  try {
    const res = await fetch(`${env.GATEWAY_URL}/me/agent/console/enter`, { headers, cache: "no-store" });
    if (!res.ok) {
      if (res.status === 503) return { ok: false, error: "Console isn't enabled yet." };
      return { ok: false, error: `Console unavailable (${res.status}).` };
    }
    const raw = (await res.json()) as { url?: string };
    if (!raw.url) return { ok: false, error: "No console URL returned." };
    return { ok: true, url: raw.url };
  } catch (err) {
    console.error("[agent] fetchConsoleUrl failed:", err instanceof Error ? err.message : String(err));
    return { ok: false, error: "Network error opening the console." };
  }
}

/** DELETE /me/agent/credentials/:id — revoke an agent credential. */
export async function revokeAgentCredential(id: string): Promise<{ ok: boolean }> {
  const headers = await authHeaders();
  if (!headers) return { ok: false };
  try {
    const res = await fetch(`${env.GATEWAY_URL}/me/agent/credentials/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers,
    });
    return { ok: res.ok };
  } catch (err) {
    console.error("[agent] revokeAgentCredential failed:", err instanceof Error ? err.message : String(err));
    return { ok: false };
  }
}

/* ---------- Agent sessions and workers ---------- */

/** GET /me/agent-sessions — session IDs + heartbeat timestamps for all workers. */
export async function fetchAgentSessions(): Promise<{
  agent_session_id: string | null;
  agent_sessions: Record<string, string>;
  agent_session_heartbeats: Record<string, string>;
}> {
  const headers = await authHeaders();
  if (!headers) return { agent_session_id: null, agent_sessions: {}, agent_session_heartbeats: {} };
  try {
    const res = await fetch(`${env.GATEWAY_URL}/me/agent-sessions`, {
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { agent_session_id: null, agent_sessions: {}, agent_session_heartbeats: {} };
    return (await res.json()) as { agent_session_id: string | null; agent_sessions: Record<string, string>; agent_session_heartbeats: Record<string, string>; };
  } catch (err) {
    console.error("[agent] fetchAgentSessions failed:", err instanceof Error ? err.message : String(err));
    return { agent_session_id: null, agent_sessions: {}, agent_session_heartbeats: {} };
  }
}

/* ---------- Hosted agent runtime (self) ---------- */

/** Pull the `{ runtime: {...} }` envelope (or a bare runtime object) out of a
 *  parsed gateway body. */
function unwrapRuntime(raw: unknown): AgentRuntime {
  const body = (raw ?? {}) as Record<string, unknown>;
  return parseRuntime("runtime" in body ? body.runtime : body);
}

/** GET /me/agent/runtime — current hosted-runtime state for the signed-in user. */
export async function fetchRuntime(): Promise<AgentRuntime> {
  const headers = await authHeaders();
  if (!headers) return { status: "none" };
  try {
    const res = await fetch(`${env.GATEWAY_URL}/me/agent/runtime`, {
      headers,
      cache: "no-store",
    });
    if (!res.ok) return { status: "none" };
    return unwrapRuntime(await res.json());
  } catch (err) {
    console.error("[agent] fetchRuntime failed:", err instanceof Error ? err.message : String(err));
    return { status: "none" };
  }
}

/**
 * POST /me/agent/provision — ask the orchestrator to provision the hosted agent.
 * 400 => Claude key missing; 503 => runtime not configured (no agent host yet).
 */
export async function provisionRuntime(): Promise<{
  ok: boolean;
  runtime?: AgentRuntime;
  error?: string;
}> {
  const headers = await authHeaders();
  if (!headers) return { ok: false, error: "Not authenticated" };
  try {
    const res = await fetch(`${env.GATEWAY_URL}/me/agent/provision`, {
      method: "POST",
      headers,
    });
    if (!res.ok) {
      if (res.status === 400) {
        return { ok: false, error: "Connect your Claude API key first." };
      }
      if (res.status === 503) {
        return {
          ok: false,
          error: "The hosted runtime isn't configured yet — contact your admin.",
        };
      }
      console.error("[agent] provisionRuntime failed:", res.status);
      return { ok: false, error: `Provision failed (${res.status}).` };
    }
    return { ok: true, runtime: unwrapRuntime(await res.json()) };
  } catch (err) {
    console.error("[agent] provisionRuntime failed:", err instanceof Error ? err.message : String(err));
    return { ok: false, error: "Network error while provisioning the runtime." };
  }
}

/** POST /me/agent/stop — stop the hosted agent container. 503 => not configured. */
export async function stopRuntime(): Promise<{
  ok: boolean;
  runtime?: AgentRuntime;
  error?: string;
}> {
  const headers = await authHeaders();
  if (!headers) return { ok: false, error: "Not authenticated" };
  try {
    const res = await fetch(`${env.GATEWAY_URL}/me/agent/stop`, {
      method: "POST",
      headers,
    });
    if (!res.ok) {
      if (res.status === 503) {
        return {
          ok: false,
          error: "The hosted runtime isn't configured yet — contact your admin.",
        };
      }
      console.error("[agent] stopRuntime failed:", res.status);
      return { ok: false, error: `Stop failed (${res.status}).` };
    }
    return { ok: true, runtime: unwrapRuntime(await res.json()) };
  } catch (err) {
    console.error("[agent] stopRuntime failed:", err instanceof Error ? err.message : String(err));
    return { ok: false, error: "Network error while stopping the runtime." };
  }
}
