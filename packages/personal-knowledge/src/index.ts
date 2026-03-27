export * from './types/index.js';
export * from './repositories/interfaces/index.js';
export * from './repositories/elasticsearch/index.js';
export { ensureIndices } from './setup/indices.js';
export { startServer } from './server.js';

// Start the server when run directly
import { startServer } from './server.js';
import { logger } from './utils/logger.js';

startServer().catch((err) => {
  logger.error('Failed to start server', { error: String(err) });
  process.exit(1);
});
