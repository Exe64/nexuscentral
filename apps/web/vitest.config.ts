import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * Component-level tests only. There is deliberately no E2E suite -- not worth it
 * at this scale -- but a page that has never been rendered is a page that has
 * never been checked, and the translation helper throws on a missing key in DEV,
 * so rendering each page is what proves the copy contract holds.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    globals: false,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'test/**/*.test.ts', 'test/**/*.test.tsx'],
    setupFiles: ['./test/setup.ts'],
  },
});
