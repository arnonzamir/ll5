import type { LogLevel } from './logger.js';

export interface OrchestratorEnv {
  port: number;
  logLevel: LogLevel;
  databaseUrl: string;
  encryptionKey: string;
  orchestratorSecret: string;
  image: string;
  maxContainersPerHost: number;
  memoryBytes: number;
  restartPolicy: string;
  gatewayUrl: string;
  mcpBaseDomain: string;
  heartbeatTimeoutSec: number;
  restartCooldownSec: number;
  reconcileIntervalMs: number;
  dockerSocketPath: string;
  agentHostName: string;
  secretsDir: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number, got: ${v}`);
  return n;
}

export function loadEnv(): OrchestratorEnv {
  return {
    port: num('PORT', 3100),
    logLevel: (process.env.LOG_LEVEL as LogLevel) || 'info',
    databaseUrl: required('DATABASE_URL'),
    encryptionKey: required('ENCRYPTION_KEY'),
    orchestratorSecret: required('ORCHESTRATOR_SECRET'),
    image: process.env.AGENT_IMAGE || 'ghcr.io/arnonzamir/ll5-agent-tenant:latest',
    maxContainersPerHost: num('MAX_CONTAINERS_PER_HOST', 25),
    // 2 GiB default per agent container.
    memoryBytes: num('AGENT_MEMORY_BYTES', 2 * 1024 * 1024 * 1024),
    restartPolicy: process.env.AGENT_RESTART_POLICY || 'unless-stopped',
    gatewayUrl: process.env.LL5_GATEWAY_URL || 'https://ll5.noninoni.click',
    mcpBaseDomain: process.env.MCP_BASE_DOMAIN || 'noninoni.click',
    heartbeatTimeoutSec: num('HEARTBEAT_TIMEOUT_SEC', 180),
    restartCooldownSec: num('RESTART_COOLDOWN_SEC', 300),
    reconcileIntervalMs: num('RECONCILE_INTERVAL_MS', 60_000),
    dockerSocketPath: process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock',
    agentHostName: process.env.AGENT_HOST_NAME || 'agent-host-1',
    secretsDir: process.env.SECRETS_DIR || '/run/ll5',
  };
}
