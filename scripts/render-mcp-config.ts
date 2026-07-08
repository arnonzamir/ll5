#!/usr/bin/env tsx
/**
 * Render variant-specific MCP configs from the shared source-of-truth
 * (packages/ll5-run-shared/mcp-endpoints.json).
 *
 * Usage:
 *   npx tsx scripts/render-mcp-config.ts \
 *     --format claude \
 *     --output /workspace/.claude/settings.json
 *
 *   npx tsx scripts/render-mcp-config.ts \
 *     --format opencode \
 *     --output /workspace/opencode-mcp-fragment.json
 *
 *   npx tsx scripts/render-mcp-config.ts \
 *     --format claude \
 *     --worker reconcile \
 *     --output /workspace/.mcp.reconcile.json
 *
 * Env:
 *   MCP_BASE_DOMAIN — base domain for MCP endpoints (e.g. "noninoni.click")
 *   MCP_API_KEY     — static bearer token (opencode format only; emitted as ${MCP_API_KEY} placeholder)
 */
import fs from 'node:fs';
import path from 'node:path';

type Format = 'claude' | 'opencode';

interface McpEndpoint {
  subdomain: string;
  path: string;
  auth: 'agent-token' | 'static' | 'none';
  correlationIds: boolean;
}

interface WorkerConfig {
  allow: string[];
}

interface McpEndpointsConfig {
  baseDomainEnv: string;
  endpoints: Record<string, McpEndpoint>;
  workers: Record<string, WorkerConfig>;
}

function loadConfig(configPath: string): McpEndpointsConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`MCP endpoints config not found: ${configPath}`);
  }
  const raw = fs.readFileSync(configPath, 'utf-8');
  return JSON.parse(raw) as McpEndpointsConfig;
}

function resolveBaseDomain(config: McpEndpointsConfig): string {
  const val = process.env[config.baseDomainEnv];
  if (!val) {
    throw new Error(
      `Environment variable ${config.baseDomainEnv} not set — cannot resolve MCP base domain`,
    );
  }
  return val;
}

function buildUrl(ep: McpEndpoint, baseDomain: string): string {
  return `https://${ep.subdomain}.${baseDomain}${ep.path}`;
}

function filterEndpointKeys(config: McpEndpointsConfig, worker?: string): string[] {
  if (!worker) return Object.keys(config.endpoints);
  const w = config.workers[worker];
  if (!w) throw new Error(`Unknown worker: ${worker}. Available: ${Object.keys(config.workers).join(', ')}`);
  return w.allow;
}

function renderClaude(
  config: McpEndpointsConfig,
  baseDomain: string,
  worker?: string,
): Record<string, unknown> {
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const key of filterEndpointKeys(config, worker)) {
    const ep = config.endpoints[key];
    if (!ep) throw new Error(`Endpoint "${key}" referenced by worker but not defined in endpoints`);
    mcpServers[key] = {
      type: 'streamable-http',
      url: buildUrl(ep, baseDomain),
      headersHelper: '/workspace/scripts/get-mcp-auth.sh',
    };
  }
  return { mcpServers };
}

function renderOpencode(
  config: McpEndpointsConfig,
  baseDomain: string,
  worker?: string,
): Record<string, unknown> {
  const mcp: Record<string, Record<string, unknown>> = {};
  for (const key of filterEndpointKeys(config, worker)) {
    const ep = config.endpoints[key];
    if (!ep) throw new Error(`Endpoint "${key}" referenced by worker but not defined in endpoints`);
    mcp[key] = {
      type: 'streamable-http',
      url: buildUrl(ep, baseDomain),
      headers: {
        Authorization: 'Bearer ${MCP_API_KEY}',
      },
    };
  }
  return { mcp };
}

function parseArgs(argv: string[]): {
  format: Format;
  output: string | null;
  worker: string | undefined;
  configPath: string;
} {
  let format: Format = 'claude';
  let output: string | null = null;
  let worker: string | undefined;
  let configPath = 'packages/ll5-run-shared/mcp-endpoints.json';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const getVal = (flag: string): string | undefined => {
      if (arg === flag) return argv[++i];
      if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
      return undefined;
    };
    const v: string | undefined = getVal('--format') ?? getVal('--output') ?? getVal('--worker') ?? getVal('--config');
    if (arg.startsWith('--format')) format = (v as Format) ?? format;
    else if (arg.startsWith('--output')) output = v ?? output;
    else if (arg.startsWith('--worker')) worker = v ?? worker;
    else if (arg.startsWith('--config')) configPath = v ?? configPath;
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: render-mcp-config.ts [options]

Options:
  --format <claude|opencode>  Output format (default: claude)
  --output <path>             Write to file (default: stdout)
  --worker <name>             Render only the allowlisted endpoints for this worker
  --config <path>             Path to mcp-endpoints.json (default: packages/ll5-run-shared/mcp-endpoints.json)
  --help                      Show this help

Env:
  MCP_BASE_DOMAIN  Base domain for MCP URLs (required)`);
      process.exit(0);
    }
  }

  if (format !== 'claude' && format !== 'opencode') {
    throw new Error(`Invalid format: ${format}. Must be "claude" or "opencode".`);
  }

  return { format, output, worker, configPath };
}

function main(): void {
  const { format, output, worker, configPath } = parseArgs(process.argv.slice(2));
  const config = loadConfig(configPath);
  const baseDomain = resolveBaseDomain(config);

  const rendered =
    format === 'claude'
      ? renderClaude(config, baseDomain, worker)
      : renderOpencode(config, baseDomain, worker);

  const json = JSON.stringify(rendered, null, 2) + '\n';

  if (output) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, json);
    console.error(
      `[render-mcp-config] Wrote ${format} config → ${output}${worker ? ` (worker: ${worker}, ${filterEndpointKeys(config, worker).length} endpoints)` : ` (${filterEndpointKeys(config).length} endpoints)`}`,
    );
  } else {
    process.stdout.write(json);
  }
}

main();
