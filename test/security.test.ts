import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { maskPhone } from '../src/lib/mask.js';
import type { Db } from '../src/lib/prisma.js';

const base = { DATABASE_URL: 'postgresql://test@localhost/test', LOG_LEVEL: 'silent' };
const config = loadConfig({ ...base, NODE_ENV: 'test' });

describe('unexpected errors', () => {
  it('answer 500 without the internal message', async () => {
    const fakeDb = {
      product: {
        findFirst: async () => {
          throw new Error('Invalid `prisma.product.findFirst()` invocation: column "secret_internal" missing');
        },
      },
      $disconnect: async () => {},
    } as unknown as Db;
    const app = await buildApp(config, fakeDb, null, null);
    const res = await app.inject({ method: 'GET', url: '/api/v1/products/anything' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: 'INTERNAL' });
    expect(res.body).not.toContain('prisma');
    expect(res.body).not.toContain('secret_internal');
    await app.close();
  });

  it('still explain client mistakes such as a page number out of range', async () => {
    const app = await buildApp(config, { $disconnect: async () => {} } as unknown as Db, null, null);
    const res = await app.inject({ method: 'GET', url: '/api/v1/products?page=999999999999' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('production settings', () => {
  const prod = { ...base, NODE_ENV: 'production', ADMIN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') };
  const exits = (env: Record<string, string>) => {
    const exit = process.exit;
    const error = console.error;
    let code: number | undefined;
    process.exit = ((c?: number) => {
      code = c;
      throw new Error('exit');
    }) as typeof process.exit;
    console.error = () => {};
    try {
      loadConfig(env);
    } catch {
      /* the stubbed exit */
    } finally {
      process.exit = exit;
      console.error = error;
    }
    return code === 1;
  };

  it('refuses rate limits off and trusting every proxy', () => {
    expect(exits({ ...prod, RATE_LIMIT: 'off' })).toBe(true);
    expect(exits({ ...prod, TRUST_PROXY: 'true' })).toBe(true);
    expect(exits(prod)).toBe(false);
  });
});

describe('maskPhone', () => {
  it('keeps the first and last three digits', () => {
    expect(maskPhone('01712345678')).toBe('017•••••678');
  });
});
