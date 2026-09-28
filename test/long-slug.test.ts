import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/lib/prisma.js';

const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://test@localhost/test', LOG_LEVEL: 'silent' });

// No product exists, so a found route answers 404; the bug was Fastify answering 414 first.
const fakeDb = {
  product: { findFirst: async () => null },
  $disconnect: async () => {},
} as unknown as Db;

describe('long product slugs', () => {
  it('reaches the product route for slugs over 100 characters (Fastify’s default limit)', async () => {
    const app = await buildApp(config, fakeDb);
    const slug = 'handmade-'.repeat(13).slice(0, 120); // the longest slug the admin allows
    const res = await app.inject({ method: 'GET', url: `/api/v1/products/${slug}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
