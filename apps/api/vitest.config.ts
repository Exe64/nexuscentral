import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      // Unit tests never open a connection -- the pool is stubbed. This value
      // exists only to satisfy env validation at import time. Integration tests
      // that need a real database read INTEGRATION_DATABASE_URL and skip
      // themselves when it is absent.
      DATABASE_URL: 'postgres://feedhub:feedhub@127.0.0.1:5432/feedhub_test',
    },
  },
});
