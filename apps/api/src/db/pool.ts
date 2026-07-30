/**
 * The single PostgreSQL connection pool.
 *
 * `numeric` columns come back from `pg` as strings to avoid silent float
 * precision loss. Every numeric in this schema (`weight`, `score`,
 * `accent_chroma`) is small and bounded, so parsing to a JS number is safe and
 * saves every call site from doing it. `bigint` is deliberately left as a
 * string: item and alert ids are `bigserial` and must survive JSON round-trips.
 */

import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

const { Pool, types } = pg;

const PG_TYPE_NUMERIC = 1700;
types.setTypeParser(PG_TYPE_NUMERIC, (value: string) => Number.parseFloat(value));

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: 'feedhub-api',
});

// An idle client erroring is not tied to any request; without this handler the
// `error` event on the pool would be unhandled and take the process down.
pool.on('error', (err) => {
  logger.error({ err }, 'Idle PostgreSQL client errored');
});

export type QueryParam = string | number | boolean | Date | null | readonly unknown[] | Buffer;

/** Run a query on the pool. Prefer this over reaching for `pool` directly. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: readonly QueryParam[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(sql, params as unknown[]);
}

/** Run `fn` inside a transaction, rolling back on any thrown error. */
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // Report it, but surface the original failure -- that is the real cause.
      logger.error({ err: rollbackErr }, 'Transaction rollback failed');
    }
    throw err;
  } finally {
    client.release();
  }
}

/** True when the database answers a trivial query. Backs `GET /api/health`. */
export async function isReachable(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (err) {
    logger.warn({ err }, 'Database unreachable');
    return false;
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
