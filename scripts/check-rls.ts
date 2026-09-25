// Fails if any table in the public schema has row-level security turned off.
// Run after migrations (npm run db:check-rls); CI runs it against a fresh database.
import { createPrisma } from '../src/lib/prisma.js';

try {
  process.loadEnvFile();
} catch {
  // no .env file
}

const db = createPrisma(process.env.DATABASE_URL!);
try {
  const rows = await db.$queryRaw<{ tablename: string }[]>`
    SELECT c.relname AS tablename
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
    ORDER BY 1`;
  if (rows.length) {
    console.error('Tables without row-level security:', rows.map((r) => r.tablename).join(', '));
    console.error('Add `ALTER TABLE "<table>" ENABLE ROW LEVEL SECURITY;` to the migration that creates them.');
    process.exitCode = 1;
  } else {
    console.log('Row-level security is on for every public table.');
  }
} finally {
  await db.$disconnect();
}
