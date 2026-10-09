// Development and tests use the local Docker database. Outside production, refuse any database that
// isn't on this computer, so a stray `npm run dev`, seed or migration can't write to the live store.
// A deliberate job against production (admin:create, loadtest:prep, db:check-rls) sets
// ALLOW_REMOTE_DATABASE=true for that one command.
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

export function assertDatabaseAllowed(databaseUrl: string | undefined, env: NodeJS.ProcessEnv = process.env): void {
  if (!databaseUrl || env.NODE_ENV === 'production' || env.ALLOW_REMOTE_DATABASE === 'true') return;
  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    // not a URL; let the driver report it
    return;
  }
  if (LOCAL_HOSTS.includes(host)) return;
  throw new Error(
    `Refusing to use the database at "${host}" outside production (NODE_ENV=${env.NODE_ENV ?? 'unset'}). ` +
      'Development uses the local Docker database (npm run db:up). For a deliberate job against this ' +
      'database, set ALLOW_REMOTE_DATABASE=true for that one command.',
  );
}
