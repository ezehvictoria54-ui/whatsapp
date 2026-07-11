import { config } from './config.js';
import { log } from './logger.js';
import { migrate } from './db/migrate.js';
import { seedDatabase } from './db/seed.js';
import { ensureDefaultOffer } from './services/offers.js';
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

  // Ensure a default offer exists and every lead is attributed to one (§Feature A).
  await ensureDefaultOffer();

  // One-switch demo data: set SEED_ON_BOOT=true in the Railway dashboard to
  // populate the dashboard, then remove the variable. Idempotent + never touches
  // real leads, so it's safe if left on, but off by default.
  if (config.app.seedOnBoot) {
    log.info('SEED_ON_BOOT enabled — inserting demo data');
    await seedDatabase();
  }

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
