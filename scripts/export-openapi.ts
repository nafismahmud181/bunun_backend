// Writes openapi.json without starting a server or touching the database.
// The frontend and admin repos generate their typed API clients from this file.
import { writeFile } from 'node:fs/promises';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/lib/prisma.js';

const config = loadConfig({
  ...process.env,
  DATABASE_URL: 'postgresql://unused@localhost/unused',
  LOG_LEVEL: 'silent',
});
const app = await buildApp(config, { $disconnect: async () => {} } as unknown as Db);
await app.ready();
await writeFile('openapi.json', JSON.stringify(app.swagger(), null, 2) + '\n');
await app.close();
console.log('Wrote openapi.json');
