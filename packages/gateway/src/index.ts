import { loadEnv } from './utils/env.js';
import { setLogLevel } from './utils/logger.js';
import { logger } from './utils/logger.js';
import { startServer } from './server.js';

async function main(): Promise<void> {
  const config = loadEnv();
  setLogLevel(config.logLevel);

  logger.info('[startServer][init] Starting gateway service', {
    port: config.port,
    env: config.nodeEnv,
  });

  await startServer(config);
}

main().catch((err) => {
  logger.error('[startServer][init] Fatal error starting gateway', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
