import pg from 'pg';
import { loadEnv } from './env.js';
import { logger, setLogLevel } from './logger.js';
import { DockerRuntime } from './runtime/docker-runtime.js';
import { SecretsWriter } from './secrets.js';
import { encrypt, decrypt } from './encryption.js';
import { Orchestrator } from './orchestrator.js';
import { createApp } from './server.js';

async function main(): Promise<void> {
  const env = loadEnv();
  setLogLevel(env.logLevel);

  logger.info('[orchestrator][init] starting', {
    port: env.port,
    image: env.image,
    host: env.agentHostName,
    cap: env.maxContainersPerHost,
  });

  const pool = new pg.Pool({ connectionString: env.databaseUrl });
  const runtime = new DockerRuntime({
    socketPath: env.dockerSocketPath,
    host: env.agentHostName,
  });
  const secrets = new SecretsWriter({ dir: env.secretsDir });

  const orchestrator = new Orchestrator({
    runtime,
    pool,
    encryptor: { encrypt, decrypt },
    secrets,
    // Re-provision (image roll, stale-heartbeat restart) needs the tenant's agent
    // token; the last minted one lives in the secrets env-file we wrote.
    agentTokenResolver: (userId) => secrets.readAgentToken(userId),
    config: {
      encryptionKey: env.encryptionKey,
      image: env.image,
      imagesByProvider: env.imagesByProvider,
      maxContainersPerHost: env.maxContainersPerHost,
      memoryBytes: env.memoryBytes,
      restartPolicy: env.restartPolicy,
      gatewayUrl: env.gatewayUrl,
      mcpBaseDomain: env.mcpBaseDomain,
      agentNetwork: env.agentNetwork,
      consoleDomainBase: env.consoleDomainBase,
      consoleForwardAuthUrl: env.consoleForwardAuthUrl,
      heartbeatTimeoutSec: env.heartbeatTimeoutSec,
      restartCooldownSec: env.restartCooldownSec,
    },
  });

  const app = createApp({ orchestrator, orchestratorSecret: env.orchestratorSecret });

  const reconcileTimer = setInterval(() => {
    orchestrator.reconcile().catch((err) => {
      logger.error('[orchestrator][reconcile] failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, env.reconcileIntervalMs);
  reconcileTimer.unref();

  const server = app.listen(env.port, () => {
    logger.info('[orchestrator][init] listening', { port: env.port });
  });

  const shutdown = (): void => {
    logger.info('[orchestrator][shutdown] closing');
    clearInterval(reconcileTimer);
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.error('[orchestrator][init] fatal', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
