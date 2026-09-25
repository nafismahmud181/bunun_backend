import { defineConfig } from 'vitest/config';

// Unit tests only; they need no database. Integration tests: vitest.integration.config.ts.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**'],
    testTimeout: 15_000,
  },
});
