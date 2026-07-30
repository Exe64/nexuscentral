import { pool, query } from '../../src/db/pool.js';
import { createApp } from '../../src/http/app.js';

export const app = createApp();

/**
 * Truncate every application table between tests.
 *
 * RESTART IDENTITY keeps ids predictable, and CASCADE follows the foreign keys
 * so the order of the list does not matter.
 */
export async function resetDatabase(): Promise<void> {
  await query(`
    TRUNCATE TABLE alerts, items, source_tags, sources, tags, widgets, dashboards
    RESTART IDENTITY CASCADE
  `);
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}

/** Read a single value straight from the database, to verify what the API did. */
export async function scalar<T>(
  sql: string,
  params: readonly (string | number)[] = [],
): Promise<T> {
  const { rows } = await query<Record<string, T>>(sql, params);
  const row = rows[0];
  if (row === undefined) throw new Error(`No row returned for: ${sql}`);
  return Object.values(row)[0] as T;
}
