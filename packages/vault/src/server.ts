import express from 'express';
import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  runWithRequestContext,
  getContextUserId,
  tokenAuthMiddleware,
  initAppLog,
  initAudit,
  withToolLogging,
  type AuthenticatedRequest,
} from '@ll5/shared';
import { loadEnv } from './utils/env.js';
import { logger, setLogLevel, type LogLevel } from './utils/logger.js';
import { BwSidecar } from './bw/sidecar.js';
import { BwClient } from './bw/client.js';
import { createGatewayClient } from './gateway.js';
import { createLoginRunner } from './browser/login.js';
import { TenantProvisioner } from './provision.js';
import { createTenancyService } from './tenancy.js';
import { createInternalRouter } from './admin.js';
import { registerAllTools, type ToolDependencies } from './tools/index.js';

function getUserId(): string {
  const uid = getContextUserId();
  if (!uid) throw new Error('No user context — request not wrapped in runWithRequestContext()');
  return uid;
}

export async function startServer(): Promise<void> {
  const env = loadEnv();
  setLogLevel(env.logLevel as LogLevel);

  // app_log/audit rows for this service are name-only by design: tool args are
  // {site} and results are status/URL (DECISION-022 §5) — nothing sensitive
  // ever reaches the ledger.
  initAppLog({
    elasticsearchUrl: process.env.ELASTICSEARCH_URL ?? '',
    service: 'vault',
    level: (env.logLevel ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
  });
  initAudit(process.env.ELASTICSEARCH_URL ?? '');

  logger.info('[startServer][init] Starting Vault MCP server', { port: env.port });

  // ---------------------------------------------------------------------------
  // bw serve sidecar (login + unlock + supervise)
  // ---------------------------------------------------------------------------
  const sidecar = new BwSidecar({
    vaultUrl: env.vaultUrl,
    clientId: env.bwClientId,
    clientSecret: env.bwClientSecret,
    password: env.bwPassword,
    servePort: env.bwServePort,
  });
  const bwConfigured = Boolean(env.bwClientId && env.bwClientSecret && env.bwPassword);
  if (bwConfigured) {
    // Boot the sidecar in the background: the HTTP surface must come up even if
    // Vaultwarden is briefly unreachable (tools report "locked/down" until then).
    void sidecar.start().catch((err) => {
      logger.error('[startServer][sidecar] initial start failed — tools will report vault down', {
        error: err instanceof Error ? err.message : 'unknown',
      });
    });
  } else {
    // Never silent (feedback_no_silent_errors) — but also never crash-loop:
    // on a first deploy the BW_* secrets land only after bootstrap + CI inject.
    logger.error('[startServer][sidecar] BW_CLIENTID/BW_CLIENTSECRET/BW_PASSWORD not set — vault UNCONFIGURED. Run packages/vault/scripts/bootstrap.ts and set the secrets (GitHub secrets → deploy inject).');
  }

  // Tenant provisioning (DECISION-022 tenant addendum): the machine account
  // creates one org PER TENANT ("LL5 <first8>", collection "agent") and owner-
  // invites/confirms the tenant's human. Needs BW_EMAIL + BW_PASSWORD for the
  // client-side Bitwarden KDF; when unset, lifecycle tools report unconfigured
  // while login tools keep working.
  const provisioner = new TenantProvisioner({
    vaultUrl: env.vaultUrl,
    machineEmail: env.bwEmail,
    machinePassword: env.bwPassword,
    orgNamePrefix: env.vaultOrgName,
    collectionName: env.vaultCollectionName,
  });
  if (!provisioner.configured) {
    logger.warn('[startServer][provisioner] BW_EMAIL/BW_PASSWORD not set — tenant provisioning disabled (logins unaffected)');
  }

  const bw = new BwClient(sidecar.baseUrl, env.vaultCollectionName);
  const gateway = createGatewayClient(env.gatewayUrl, env.authSecret);
  const tenancy = createTenancyService({ gateway, provisioner, bw, sidecar });

  const deps: ToolDependencies = {
    bw,
    gateway,
    login: createLoginRunner(env.browserCdpUrl),
    sidecar,
    tenancy,
  };

  // ---------------------------------------------------------------------------
  // Express app — token auth via the shared middleware (ll5.* + legacy API key)
  // ---------------------------------------------------------------------------
  const app = express();
  app.use(express.json());

  const authMiddleware = tokenAuthMiddleware({
    authSecret: env.authSecret,
    legacy: { apiKey: env.apiKey, userId: env.userId },
  });

  // Health endpoint (no auth): 200 only when the bw sidecar answers /status.
  // "unconfigured" (no BW_* secrets yet) reports 200 so a pre-bootstrap deploy
  // isn't paged as an outage — the error is loud in the logs and tool results.
  app.get('/health', async (_req: Request, res: Response) => {
    if (!bwConfigured) {
      res.json({ status: 'ok', service: 'll5-vault', bw: 'unconfigured' });
      return;
    }
    const bwStatus = await sidecar.status();
    if (bwStatus === 'down') {
      res.status(503).json({ status: 'unhealthy', service: 'll5-vault', bw: bwStatus });
      return;
    }
    res.json({ status: 'ok', service: 'll5-vault', bw: bwStatus });
  });

  // Internal tenant-lifecycle surface (/internal/tenant/*) — service-to-service
  // routes for the gateway's /me/vault/* wrappers. Same auth as /mcp; strictly
  // self-scoped (acting user = token claim). NOT MCP tools.
  app.use(createInternalRouter({
    authSecret: env.authSecret,
    apiKey: env.apiKey,
    userId: env.userId,
    tenancy,
  }));

  // MCP endpoint (stateless — new server+transport per request)
  app.all('/mcp', authMiddleware, async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    await runWithRequestContext({
      userId,
      sessionId: (req.headers['x-ll5-session-id'] as string) || undefined,
      traceId: (req.headers['x-ll5-trace-id'] as string) || undefined,
    }, async () => {
      try {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const mcpServer = new McpServer({ name: 'll5-vault', version: '0.1.0' });
        withToolLogging(mcpServer, getUserId);
        registerAllTools(mcpServer, deps, getUserId);
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('[startServer][mcp] MCP request failed', { error: message });
        if (!res.headersSent) {
          res.status(500).json({ error: 'Internal server error' });
        }
      }
    });
  });

  const server = app.listen(env.port, () => {
    logger.info(`[startServer][init] Vault MCP server listening on port ${env.port}`);
  });

  const shutdown = async (signal: string) => {
    logger.info(`[startServer][shutdown] Received ${signal}, shutting down gracefully`);
    server.close(() => {
      logger.info('[startServer][shutdown] HTTP server closed');
    });
    await sidecar.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
}
