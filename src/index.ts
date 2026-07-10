import { config } from './config.js';
import { log } from './logger.js';
import { migrate } from './db/migrate.js';
import { buildServer } from './server.js';
import { startWorker, stopWorker } from './worker/worker.js';
import { closePool } from './db/pool.js';

/**
 * Single-process entrypoint: runs migrations, starts the HTTP server (webhooks
 * + dashboard API) and the in-process cron worker. For higher volume the worker
 * can be split out via `npm run worker` (src/worker/standalone.ts).
 */
async function main() {
  await migrate();

  const app = await buildServer();
  await app.listen({ host: '0.0.0.0', port: config.app.port });
  log.info('server listening', { port: config.app.port, baseUrl: config.app.baseUrl, dryRun: config.dryRun });

  startWorker();

  const shutdown = async (signal: string) => {
    log.info('shutting down', { signal });
    stopWorker();
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error('fatal startup error', { error: (err as Error).message });
  process.exit(1);
});
