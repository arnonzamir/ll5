// Types + pure helpers for the "/settings/agent" (Your Agent) page.
// No "use server" directive — this module exports non-async values (types,
// constants, pure functions) shared by the client view, the server actions,
// and the unit tests. (Next 15 only allows async exports from "use server"
// modules, so anything synchronous must live here.)

import type { BadgeProps } from "@/components/ui/badge";

type BadgeVariant = NonNullable<BadgeProps["variant"]>;

/** The Anthropic API-key prefix the UI accepts today. The backend also supports
 *  an oauth_setup_token kind, but that path is dormant (no UI). */
export const ANTHROPIC_API_KEY_PREFIX = "sk-ant-";

/** Status of the user's stored Claude (LLM) credential. Mirrors
 *  GET /me/agent/llm-credential. Never carries the key itself — only `last4`. */
export type AgentLlmProvider = "anthropic" | "opencode";

export interface LlmCredentialStatus {
  configured: boolean;
  /** Present only when configured. */
  kind?: "api_key" | "oauth_setup_token";
  /** Last 4 chars of the stored key — the only part ever shown. */
  last4?: string;
  /** Which runtime/provider this credential targets. */
  provider?: AgentLlmProvider;
  /** Selected model id (null = image/env default). */
  model?: string | null;
  /** opencode server URL / provider base (null = default). */
  base_url?: string | null;
}

/** Provider + model options for the settings dropdowns (GET /me/agent/models). */
export interface AgentModelsCatalog {
  providers: Array<{ provider: AgentLlmProvider; label: string; models: string[] }>;
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

/* ---------- Hosted agent runtime ---------- */

/** Lifecycle status of the LL5-hosted agent container. Mirrors
 *  `agent_runtimes.status` from GET /me/agent/runtime. */
export type AgentRuntimeStatus =
  | "none"
  | "provisioning"
  | "running"
  | "stopped"
  | "error";

/** The runtime state returned by GET /me/agent/runtime (`runtime` envelope) and
 *  by POST /me/agent/provision|stop. Tenant rows carry a trimmed subset
 *  (`status` + `last_seen_at`) under `agent_runtime`. */
export interface AgentRuntime {
  status: AgentRuntimeStatus;
  container_id?: string | null;
  host?: string | null;
  last_seen_at?: string | null;
  last_error?: string | null;
}

/** Coerce an unknown gateway runtime object into a typed AgentRuntime,
 *  defaulting to status 'none'. Pure + tolerant of missing fields. */
export function parseRuntime(raw: unknown): AgentRuntime {
  const row = (raw ?? {}) as Record<string, unknown>;
  return {
    status: normalizeRuntimeStatus(row.status),
    container_id: typeof row.container_id === "string" ? row.container_id : null,
    host: typeof row.host === "string" ? row.host : null,
    last_seen_at: typeof row.last_seen_at === "string" ? row.last_seen_at : null,
    last_error: typeof row.last_error === "string" ? row.last_error : null,
  };
}

/** Narrow an arbitrary value to a known runtime status, falling back to 'none'. */
export function normalizeRuntimeStatus(value: unknown): AgentRuntimeStatus {
  switch (value) {
    case "provisioning":
    case "running":
    case "stopped":
    case "error":
    case "none":
      return value;
    default:
      return "none";
  }
}

/** Badge variant + human label for a runtime status. Pure; unit-tested. */
export function runtimeStatusBadge(status: AgentRuntimeStatus): {
  variant: BadgeVariant;
  label: string;
} {
  switch (status) {
    case "running":
      return { variant: "success", label: "Running" };
    case "provisioning":
      return { variant: "warning", label: "Provisioning" };
    case "stopped":
      return { variant: "secondary", label: "Stopped" };
    case "error":
      return { variant: "destructive", label: "Error" };
    case "none":
    default:
      return { variant: "outline", label: "Not provisioned" };
  }
}

/** Whether the Provision action should be enabled: requires a configured Claude
 *  credential and a runtime that isn't already coming up / running. Pure. */
export function canProvision(
  llmConfigured: boolean,
  status: AgentRuntimeStatus
): boolean {
  if (!llmConfigured) return false;
  return status !== "provisioning" && status !== "running";
}

/** Whether the runtime is in a transient state worth polling on a timer. */
export function isTransientRuntime(status: AgentRuntimeStatus): boolean {
  return status === "provisioning";
}

/** Whether a Stop action makes sense (running or coming up). Pure. */
export function canStop(status: AgentRuntimeStatus): boolean {
  return status === "running" || status === "provisioning";
}
