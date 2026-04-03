import { startServer } from './server.js';

startServer().catch((err) => {
  console.error('[index][main] Failed to start server', err);
  process.exit(1);
});
