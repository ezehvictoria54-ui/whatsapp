import { log } from '../logger.js';
import { migrate } from '../db/migrate.js';
import { startWorker, stopWorker } from './worker.js';
import { closePool } from '../db/pool.js';

/**
 * Standalone worker process for when you want to scale the sender independently
 * of the web server (§3 — "swap to BullMQ if volume demands"). Run with
 * `npm run worker`.
 */
async function main() {
  await migrate();
  startWorker();
  log.info('standalone worker running');

  const shutdown = async (signal: string) => {
    log.info('worker shutting down', { signal });
    stopWorker();
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error('worker fatal error', { error: (err as Error).message });
  process.exit(1);
});
