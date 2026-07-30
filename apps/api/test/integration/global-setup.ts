/**
 * Create the test database if it does not exist, then bring the schema up to
 * date with the repository migrations.
 *
 * Running the real migrations rather than a hand-written DDL fixture is the
 * point: a migration that does not apply cleanly should fail the test run.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { INTEGRATION_DATABASE_URL } from './database-url.js';

const exec = promisify(execFile);
const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function maintenanceUrl(databaseUrl: string): { url: string; database: string } {
  const parsed = new URL(databaseUrl);
  const database = parsed.pathname.replace(/^\//, '');
  parsed.pathname = '/postgres';
  return { url: parsed.toString(), database };
}

export default async function setup(): Promise<void> {
  const databaseUrl = INTEGRATION_DATABASE_URL;
  const { url, database } = maintenanceUrl(databaseUrl);

  const admin = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `Cannot reach PostgreSQL at ${new URL(url).host}. Start it with:\n` +
        '  docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres\n' +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (existing.rowCount === 0) {
      // Identifier, so it cannot be parameterised; the name comes from our own
      // config rather than from a request.
      await admin.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`);
    }
  } finally {
    await admin.end();
  }

  await exec('pnpm', ['migrate', 'up'], {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    maxBuffer: 10 * 1024 * 1024,
  });
}
