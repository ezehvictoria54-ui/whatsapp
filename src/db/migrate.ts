import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';
import { log } from '../logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

/**
 * Dead-simple forward-only migration runner. Each .sql file in migrations/ is
 * applied once, in filename order, tracked in a schema_migrations table.
 */
export async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = new Set(
    (await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(
      (r) => r.name,
    ),
  );

  for (const file of files) {
    if (applied.has(file)) {
      log.debug('migration already applied', { file });
      continue;
    }
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      log.info('migration applied', { file });
    } catch (err) {
      await client.query('ROLLBACK');
      log.error('migration failed', { file, error: (err as Error).message });
      throw err;
    } finally {
      client.release();
    }
  }
}

// Allow `npm run migrate` to invoke this file directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => {
      log.info('migrations complete');
      return pool.end();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      log.error('migration runner crashed', { error: (err as Error).message });
      process.exit(1);
    });
}
