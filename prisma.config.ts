import { defineConfig } from 'prisma/config';
import { assertDatabaseAllowed } from './src/lib/db-guard.js';

// Prisma 7 no longer reads .env by itself; load it when present (CI and production set real env vars).
try {
  process.loadEnvFile();
} catch {
  // no .env file
}

const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
assertDatabaseAllowed(url);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  // Migrations need a direct or session connection; Supabase's transaction pooler (DATABASE_URL) can't run them.
  datasource: { url },
});
