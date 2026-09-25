import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/lib/prisma.js';

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test@localhost/test',
  LOG_LEVEL: 'silent',
  CORS_ORIGINS: 'http://localhost:3000',
});
const fakeDb = { $disconnect: async () => {} } as unknown as Db;

describe('CORS', () => {
  it('lets the storefront change and remove cart items from the browser', async () => {
    const app = await buildApp(config, fakeDb);
    const preflight = (method: string) =>
      app.inject({
        method: 'OPTIONS',
        url: '/api/v1/cart/items/BN-R1-1',
        headers: {
          origin: 'http://localhost:3000',
          'access-control-request-method': method,
          'access-control-request-headers': 'content-type,x-cart-token',
        },
      });
    for (const method of ['PUT', 'DELETE', 'POST']) {
      const res = await preflight(method);
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
      expect(String(res.headers['access-control-allow-methods'])).toContain(method);
    }
    await app.close();
  });

  it('does not allow other origins', async () => {
    const app = await buildApp(config, fakeDb);
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/cart',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });
});
