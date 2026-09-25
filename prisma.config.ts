import { defineConfig, env } from 'prisma/config';

// Prisma 7 no longer reads .env by itself; load it when present (CI and production set real env vars).
try {
  process.loadEnvFile();
} catch {
  // no .env file
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: { url: env('DATABASE_URL') },
});
