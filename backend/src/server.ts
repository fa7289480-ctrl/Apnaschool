/**
 * Server entry point.
 *
 * Starts the HTTP server on the configured port. Exits gracefully on SIGTERM
 * or SIGINT so the process manager can restart cleanly.
 */

import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './middleware/requestLogger.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(`ApnaSchool API server running on port ${env.PORT} (${env.NODE_ENV})`);
});

// ── Graceful shutdown ────────────────────────────────────────────────────
async function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down...`);
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });

  // Force exit after 10 seconds if something is hanging
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
