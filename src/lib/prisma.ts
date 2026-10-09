import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { assertDatabaseAllowed } from './db-guard.js';

export function createPrisma(databaseUrl: string) {
  assertDatabaseAllowed(databaseUrl);
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}

export type Db = ReturnType<typeof createPrisma>;
