import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Orchestrator client — talks to the SEPARATE agent-orchestrator service over
// HTTP. The orchestrator owns container placement/launch on the dedicated agent
// hosts (Docker Engine API); the gateway only asks it to provision/stop and
// reads back the resulting runtime state.
//
// Config via env:
//   ORCHESTRATOR_URL    — base URL of the orchestrator service (no trailing /).
//   ORCHESTRATOR_SECRET — bearer token sent as `Authorization: Bearer …`.
//
// If ORCHESTRATOR_URL is unset the feature degrades to a CLEAR error
// ("runtime not configured") rather than crashing — callers translate that to a
// user-facing "agent runtime not available yet" message.
//
// SECURITY: the agent token is a per-user secret. It is sent only in the
// provision request body (over the orchestrator's HTTP boundary) and is NEVER
// logged here — log lines carry user + status only.
// ---------------------------------------------------------------------------

/** Shape the orchestrator returns for a runtime status query. */
export interface OrchestratorRuntime {
  status: 'none' | 'provisioning' | 'running' | 'stopped' | 'error';
  container_id?: string | null;
  host?: string | null;
  last_seen_at?: string | null;
  last_error?: string | null;
}

/** The injectable surface — lets route handlers + tests swap the real client. */
export interface OrchestratorClient {
  provision(userId: string, agentToken: string): Promise<OrchestratorRuntime>;
  stop(userId: string): Promise<OrchestratorRuntime>;
  status(userId: string): Promise<OrchestratorRuntime>;
}

/** Thrown when ORCHESTRATOR_URL is not configured. Carries a clear message. */
export class OrchestratorNotConfiguredError extends Error {
  constructor() {
    super('runtime not configured');
    this.name = 'OrchestratorNotConfiguredError';
  }
}

function readConfig(): { url: string; secret: string } {
  const url = process.env.ORCHESTRATOR_URL;
  if (!url) {
    throw new OrchestratorNotConfiguredError();
  }
  return { url: url.replace(/\/+$/, ''), secret: process.env.ORCHESTRATOR_SECRET ?? '' };
}

async function call(
  path: string,
  body: Record<string, unknown> | undefined,
): Promise<OrchestratorRuntime> {
  const { url, secret } = readConfig();
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`orchestrator ${path} failed: HTTP ${res.status} ${text}`.trim());
  }
  return (await res.json()) as OrchestratorRuntime;
}

/**
 * Ask the orchestrator to provision (or re-provision) the user's agent
 * container, injecting the freshly-minted agent token. Returns the resulting
 * runtime state (typically {status:'provisioning'} or {status:'running'}).
 */
export async function orchestratorProvision(
  userId: string,
  agentToken: string,
): Promise<OrchestratorRuntime> {
  // agentToken is in the body only — never logged.
  const out = await call(`/runtimes/${encodeURIComponent(userId)}/provision`, {
    user_id: userId,
    agent_token: agentToken,
  });
  logger.info('[orchestrator][provision]', { userId, status: out.status });
  return out;
}

/** Ask the orchestrator to stop the user's agent container. */
export async function orchestratorStop(userId: string): Promise<OrchestratorRuntime> {
  const out = await call(`/runtimes/${encodeURIComponent(userId)}/stop`, { user_id: userId });
  logger.info('[orchestrator][stop]', { userId, status: out.status });
  return out;
}

/** Query the orchestrator for the user's current runtime status. */
export async function orchestratorStatus(userId: string): Promise<OrchestratorRuntime> {
  const out = await call(`/runtimes/${encodeURIComponent(userId)}/status`, { user_id: userId });
  return out;
}

/** The default, env-backed client used in production. */
export const defaultOrchestratorClient: OrchestratorClient = {
  provision: orchestratorProvision,
  stop: orchestratorStop,
  status: orchestratorStatus,
};
