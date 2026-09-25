import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/lib/prisma.js';

const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://test@localhost/test', LOG_LEVEL: 'silent' });

// A stand-in for Prisma: only the methods the health route and shutdown hook use.
const fakeDb = (dbUp: boolean) =>
  ({
    $queryRaw: async () => {
      if (!dbUp) throw new Error('connection refused');
      return [{ '?column?': 1 }];
    },
    $disconnect: async () => {},
  }) as unknown as Db;

describe('GET /health', () => {
  it('returns 200 when the database answers', async () => {
    const app = await buildApp(config, fakeDb(true));
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', database: 'up' });
    await app.close();
  });

  it('returns 503 when the database is down', async () => {
    const app = await buildApp(config, fakeDb(false));
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'degraded', database: 'down' });
    await app.close();
  });
});
