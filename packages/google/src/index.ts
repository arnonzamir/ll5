import { startServer } from './server.js';
import { logger } from './utils/logger.js';

startServer().catch((err) => {
  logger.error('Failed to start server', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
