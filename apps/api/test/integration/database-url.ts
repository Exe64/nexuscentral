/**
 * The integration test database, resolved in one place.
 *
 * `test.env` in the vitest config only reaches test workers, not `globalSetup`,
 * which runs in the main process -- so both import this instead.
 *
 * Point INTEGRATION_DATABASE_URL at a database you do not mind losing: the suite
 * truncates every table between tests.
 */
export const INTEGRATION_DATABASE_URL =
  process.env['INTEGRATION_DATABASE_URL'] ??
  'postgres://nexuscentral:local-dev-only@127.0.0.1:5432/nexuscentral_test';
