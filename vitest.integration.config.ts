import { defineConfig } from 'vitest/config';

// Runs against a migrated and seeded database given by TEST_DATABASE_URL.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
