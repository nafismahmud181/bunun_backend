import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/lib/prisma.js';

// Sign-in is limited to 5 attempts a minute per IP. The 6th must be a clean 429, not a 500.
// A fake database that finds no admin keeps this test free of a real database.
const fakeDb = {
  adminUser: { findUnique: async () => null },
  $disconnect: async () => {},
} as unknown as Db;

describe('rate limits', () => {
  it('answer 429 with the usual error body', async () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://t@localhost/t', LOG_LEVEL: 'silent' });
    const app = await buildApp(config, fakeDb);
    const attempt = () =>
      app.inject({ method: 'POST', url: '/api/v1/admin/auth/login', payload: { email: 'a@b.c', password: 'x' } });
    for (let i = 0; i < 5; i++) expect((await attempt()).statusCode).toBe(401);
    const limited = await attempt();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ statusCode: 429, error: 'Too Many Requests', code: 'RATE_LIMITED' });
    await app.close();
  });

  it('are off when RATE_LIMIT=off', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://t@localhost/t',
      LOG_LEVEL: 'silent',
      RATE_LIMIT: 'off',
    });
    const app = await buildApp(config, fakeDb);
    for (let i = 0; i < 8; i++)
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/admin/auth/login',
            payload: { email: 'a@b.c', password: 'x' },
          })
        ).statusCode,
      ).toBe(401);
    await app.close();
  });
});
