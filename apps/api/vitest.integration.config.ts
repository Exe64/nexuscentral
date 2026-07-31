import { defineConfig } from 'vitest/config';
import { INTEGRATION_DATABASE_URL } from './test/integration/database-url.js';

/**
 * Integration tests run against a real PostgreSQL, because the things they check
 * -- ON CONFLICT deduplication, cascade deletes, index-backed full-text search,
 * cursor pagination -- have no meaning against a mock.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    globalSetup: ['./test/integration/global-setup.ts'],
    // Every test truncates shared tables, so they cannot run concurrently.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      WORKER_ENABLED: 'false',
      // The custom_api test target listens on loopback, which the SSRF guard
      // exists to block. The guard is proven two other ways: exhaustively in
      // test/customapi/ssrf.test.ts with DNS mocked, and end to end against the
      // built image with this unset -- see the Phase 6 e2e run. Setting it here
      // is what lets the mapping and caching be tested at all.
      ALLOW_PRIVATE_TARGETS: 'true',
      DATABASE_URL: INTEGRATION_DATABASE_URL,
    },
  },
});
