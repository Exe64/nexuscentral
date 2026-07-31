import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { pool, query } from '../../src/db/pool.js';
import { setPassword } from '../../src/auth/credential.js';
import { createApp } from '../../src/http/app.js';

export const app = createApp();

/** The password every authenticated integration test signs in with. */
export const TEST_PASSWORD = 'integration-test-password';

/**
 * A supertest agent with a cookie jar.
 *
 * Every route except `/health` and `/auth/*` now needs a session, so the default
 * for a test is to be signed in. `resetDatabase` re-creates the credential and
 * signs this agent in again, because the truncate takes both with it.
 *
 * Tests that are *about* authentication use `request(app)` directly and
 * `resetDatabaseRaw`, so they start from a genuinely anonymous state.
 */
export const agent: TestAgent = request.agent(app);

/**
 * `settings` is in here too, and that is not obvious.
 *
 * It is a singleton row created by the first migration, so truncating it looks
 * wrong -- but `getRawSettings` recreates it on demand with the column defaults,
 * and leaving it alone means a webhook or retention value set by one test leaks
 * into every test that runs after it. That leak cost an afternoon once already.
 */
const TABLES = `
  alerts, items, rules, source_tags, sources, tags, widgets, dashboards,
  sessions, auth_attempts, auth_credential, settings
`;

/** Truncate everything and leave no credential behind. */
export async function resetDatabaseRaw(): Promise<void> {
  await query(`TRUNCATE TABLE ${TABLES} RESTART IDENTITY CASCADE`);
}

/**
 * Truncate every application table between tests, then sign `agent` back in.
 *
 * RESTART IDENTITY keeps ids predictable, and CASCADE follows the foreign keys
 * so the order of the list does not matter.
 */
export async function resetDatabase(): Promise<void> {
  await resetDatabaseRaw();
  await setPassword(TEST_PASSWORD);

  const res = await agent.post('/api/auth/login').send({ password: TEST_PASSWORD });
  if (res.status !== 204) {
    throw new Error(`Test sign-in failed with ${res.status}: ${res.text}`);
  }
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
