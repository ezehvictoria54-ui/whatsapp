import pg from 'pg';
import { config } from '../config.js';

// pg returns bigint/numeric as strings by default; that's fine for our columns.
// Parse int8 counts (from COUNT(*)) into JS numbers for convenience.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number.parseInt(v, 10)));

export const pool = new pg.Pool({
  connectionString: config.db.url,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export type QueryParams = ReadonlyArray<unknown>;

/**
 * The minimal query surface services depend on. Satisfied by both the module
 * `query` helper and a `pg.PoolClient` (so the same service functions work
 * inside and outside a transaction).
 */
export interface Queryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: QueryParams,
  ): Promise<pg.QueryResult<T>>;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: QueryParams,
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as unknown[] | undefined);
}

/** Run a set of statements inside a single transaction. */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
