// Cart, checkout, fraud checks, tracking and the SMS outbox against a real database.
// Needs a migrated + seeded database: TEST_DATABASE_URL=... npm run test:integration
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createPrisma } from '../../src/lib/prisma.js';
import { processOutbox } from '../../src/services/sms/outbox.js';

const url = process.env.TEST_DATABASE_URL;
const db = url ? createPrisma(url) : null;
type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;

// Variants these tests change; their stock is restored afterwards.
const SKUS = ['BN-J2-1', 'BN-M2-2', 'BN-C3-1'];
let savedStock: { sku: string; stock: number }[] = [];
let dhanmondi: number;
let savar: number;

// Each test uses its own phone numbers and IPs so fraud limits don't interfere.
let phoneSeq = 0;
const phone = () => `0171${String(9000000 + phoneSeq++).slice(-7)}`;
const usedPhones: string[] = [];
let ipSeq = 0;
const ip = () => `10.99.0.${++ipSeq}`;

async function call(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string>; ip?: string } = {},
) {
  const res = await app.inject({
    method,
    url: `/api/v1${path}`,
    remoteAddress: opts.ip ?? '10.98.0.1',
    headers: { ...(opts.token && { 'x-cart-token': opts.token }), ...opts.headers },
    ...(opts.body !== undefined && { payload: opts.body as object }),
  });
  return { status: res.statusCode, body: res.json() };
}

/** A new cart holding the given SKUs; returns its token. */
async function cartWith(items: [string, number][]) {
  let token: string | undefined;
  for (const [sku, qty] of items) {
    const r = await call('POST', '/cart/items', { token, body: { sku, qty } });
    expect(r.status).toBe(200);
    token ??= r.body.token;
  }
  return token!;
}

function checkout(
  token: string,
  fields: Partial<{ phone: string; areaId: number; paymentMethod: string }> = {},
  key = randomUUID(),
  fromIp = ip(),
) {
  const p = fields.phone ?? phone();
  usedPhones.push(p.replace(/^\+?88/, ''));
  return call('POST', '/checkout', {
    token,
    ip: fromIp,
    headers: { 'idempotency-key': key },
    body: {
      name: 'Test Buyer',
      phone: p,
      areaId: fields.areaId ?? dhanmondi,
      address: 'House 1, Road 2',
      paymentMethod: fields.paymentMethod ?? 'cod',
    },
  });
}

const stockOf = async (sku: string) => (await db!.productVariant.findUniqueOrThrow({ where: { sku } })).stock;
const setStock = (sku: string, stock: number) => db!.productVariant.update({ where: { sku }, data: { stock } });

describe.skipIf(!url)('orders API (database)', () => {
  beforeAll(async () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: url!, LOG_LEVEL: 'silent', RATE_LIMIT: 'off' });
    app = await buildApp(config, db!);
    savedStock = await db!.productVariant.findMany({
      where: { sku: { in: SKUS } },
      select: { sku: true, stock: true },
    });
    for (const sku of SKUS) await setStock(sku, 20);
    dhanmondi = (await db!.area.findFirstOrThrow({ where: { nameEn: 'Dhanmondi', districtId: 47 } })).id;
    savar = (await db!.area.findFirstOrThrow({ where: { nameEn: 'Savar' } })).id;
  });

  afterAll(async () => {
    const orders = await db!.order.findMany({ where: { phone: { in: usedPhones } }, select: { id: true } });
    const ids = orders.map((o) => o.id);
    await db!.smsMessage.deleteMany({ where: { orderId: { in: ids } } });
    await db!.inventoryMovement.deleteMany({ where: { orderId: { in: ids } } });
    await db!.order.deleteMany({ where: { id: { in: ids } } });
    await db!.customer.deleteMany({ where: { phone: { in: usedPhones } } });
    await db!.blockedContact.deleteMany({ where: { reason: 'integration test' } });
    for (const s of savedStock) await setStock(s.sku, s.stock);
    await app.close();
  });

  describe('store data', () => {
    it('serves the location tree with delivery zones', async () => {
      const { status, body } = await call('GET', '/locations');
      expect(status).toBe(200);
      expect(body).toHaveLength(8);
      const dhakaDistrict = body
        .flatMap((d: { districts: { id: number }[] }) => d.districts)
        .find((d: { id: number }) => d.id === 47);
      expect(dhakaDistrict.areas[0]).toMatchObject({ name: 'Adabor', zone: 'inside-dhaka' });
      expect(dhakaDistrict.areas.find((a: { name: string }) => a.name === 'Savar').zone).toBe('outside-dhaka');
    });

    it('serves public settings', async () => {
      const { body } = await call('GET', '/settings');
      expect(body.freeDeliveryThreshold).toBe(3000);
      expect(body.zones.map((z: { key: string; fee: number }) => [z.key, z.fee])).toEqual([
        ['inside-dhaka', 70],
        ['outside-dhaka', 130],
      ]);
    });
  });

  describe('cart', () => {
    it('creates a cart on the first add and returns its token once', async () => {
      const first = await call('POST', '/cart/items', { body: { sku: 'BN-J2-1', qty: 1 } });
      expect(first.status).toBe(200);
      expect(first.body.token).toEqual(expect.any(String));
      const again = await call('POST', '/cart/items', { token: first.body.token, body: { sku: 'BN-J2-1', qty: 2 } });
      expect(again.body.token).toBeUndefined();
      expect(again.body).toMatchObject({ itemCount: 3, subtotal: 3 * 1350 });
      expect(again.body.items[0]).toMatchObject({
        sku: 'BN-J2-1',
        qty: 3,
        unitPrice: 1350,
        lineTotal: 4050,
        available: true,
      });
    });

    it('sets, caps and removes quantities', async () => {
      const token = await cartWith([['BN-J2-1', 1]]);
      expect((await call('PUT', '/cart/items/BN-J2-1', { token, body: { qty: 5 } })).body.itemCount).toBe(5);
      await setStock('BN-C3-1', 3);
      const capped = await call('POST', '/cart/items', { token, body: { sku: 'BN-C3-1', qty: 10 } });
      expect(capped.body.items.find((i: { sku: string }) => i.sku === 'BN-C3-1').qty).toBe(3); // capped at stock
      expect(
        (await call('DELETE', '/cart/items/BN-J2-1', { token })).body.items.map((i: { sku: string }) => i.sku),
      ).toEqual(['BN-C3-1']);
      await setStock('BN-C3-1', 20);
    });

    it('rejects unknown and sold-out variants', async () => {
      expect((await call('POST', '/cart/items', { body: { sku: 'NOPE-1', qty: 1 } })).body.code).toBe('UNKNOWN_SKU');
      await setStock('BN-C3-1', 0);
      const r = await call('POST', '/cart/items', { body: { sku: 'BN-C3-1', qty: 1 } });
      expect([r.status, r.body.code]).toEqual([409, 'OUT_OF_STOCK']);
      await setStock('BN-C3-1', 20);
    });

    it('quotes the delivery fee by area, free from the threshold', async () => {
      const small = await cartWith([['BN-J2-1', 1]]); // 1350
      expect((await call('GET', `/cart/quote?areaId=${dhanmondi}`, { token: small })).body).toMatchObject({
        deliveryFee: 70,
        total: 1420,
      });
      expect((await call('GET', `/cart/quote?areaId=${savar}`, { token: small })).body).toMatchObject({
        deliveryFee: 130,
        total: 1480,
      });
      const big = await cartWith([['BN-J2-1', 3]]); // 4050
      expect((await call('GET', `/cart/quote?areaId=${savar}`, { token: big })).body).toMatchObject({
        deliveryFee: 0,
        freeDelivery: true,
      });
      expect((await call('GET', '/cart/quote?areaId=999999', { token: big })).body.code).toBe('UNKNOWN_AREA');
    });
  });

  describe('checkout', () => {
    it('places a COD order: server prices, stock, SMS, empty cart', async () => {
      const token = await cartWith([['BN-J2-1', 2]]);
      const before = await stockOf('BN-J2-1');
      const { status, body } = await checkout(token, { phone: '+8801719999001', areaId: savar });
      expect(status).toBe(201);
      expect(body.orderNo).toMatch(/^BN-\d{4}-\d{6,}$/);
      expect(body).toMatchObject({
        status: 'pending',
        paymentMethod: 'cod',
        phone: '01719999001',
        subtotal: 2700,
        deliveryFee: 130,
        total: 2830,
      });
      expect(await stockOf('BN-J2-1')).toBe(before - 2);

      const order = await db!.order.findUniqueOrThrow({
        where: { orderNo: body.orderNo },
        include: { history: true, smsMessages: true, movements: true, customer: true },
      });
      expect(order).toMatchObject({
        districtName: 'Dhaka',
        areaName: 'Savar',
        zoneKey: 'outside-dhaka',
        ip: expect.stringMatching(/^10\.99\./),
      });
      expect(order.history.map((h) => h.toStatus)).toEqual(['pending']);
      expect(order.movements.map((m) => m.change)).toEqual([-2]);
      expect(order.smsMessages[0]).toMatchObject({ to: '01719999001', status: 'queued', template: 'order_placed' });
      expect(order.smsMessages[0]!.body).toContain(body.orderNo);
      expect(order.customer.phone).toBe('01719999001');
      expect((await call('GET', '/cart', { token })).body.items).toEqual([]);
    });

    it('returns the same order when the idempotency key is repeated', async () => {
      const token = await cartWith([['BN-J2-1', 1]]);
      const key = randomUUID();
      const p = phone();
      const first = await checkout(token, { phone: p }, key);
      const stockAfterFirst = await stockOf('BN-J2-1');
      const second = await checkout(token, { phone: p }, key);
      expect([first.status, second.status]).toEqual([201, 200]);
      expect(second.body.orderNo).toBe(first.body.orderNo);
      expect(await stockOf('BN-J2-1')).toBe(stockAfterFirst);
    });

    it('creates one order when the same key arrives twice at once', async () => {
      const token = await cartWith([['BN-J2-1', 1]]);
      const key = randomUUID();
      const p = phone();
      const results = await Promise.all([checkout(token, { phone: p }, key), checkout(token, { phone: p }, key)]);
      const numbers = new Set(results.map((r) => r.body.orderNo));
      expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
      expect(numbers.size).toBe(1);
      expect(await db!.order.count({ where: { idempotencyKey: key } })).toBe(1);
    });

    it('never oversells: two shoppers, one unit left', async () => {
      await setStock('BN-M2-2', 1);
      const [a, b] = [await cartWith([['BN-M2-2', 1]]), await cartWith([['BN-M2-2', 1]])];
      const results = await Promise.all([checkout(a), checkout(b)]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.status === 409)!.body).toMatchObject({
        code: 'OUT_OF_STOCK',
        details: { skus: ['BN-M2-2'] },
      });
      expect(await stockOf('BN-M2-2')).toBe(0);
      await setStock('BN-M2-2', 20);
    });

    it('validates the request', async () => {
      const token = await cartWith([['BN-J2-1', 1]]);
      expect((await checkout(token, { phone: '12345' })).status).toBe(400);
      expect((await checkout(token, { paymentMethod: 'bkash' })).status).toBe(400);
      expect((await checkout(token, { areaId: 999999 })).body.code).toBe('UNKNOWN_AREA');
      const noKey = await call('POST', '/checkout', {
        token,
        body: { name: 'A B', phone: phone(), areaId: dhanmondi, address: 'House 1', paymentMethod: 'cod' },
      });
      expect(noKey.status).toBe(400);
      const empty = await cartWith([['BN-J2-1', 1]]);
      await call('DELETE', '/cart/items/BN-J2-1', { token: empty });
      expect((await checkout(empty)).body.code).toBe('CART_EMPTY');
      expect((await checkout('not-a-real-token')).body.code).toBe('CART_EMPTY');
    });

    it('blocks listed phone numbers and IPs', async () => {
      const p = phone();
      await db!.blockedContact.create({ data: { kind: 'phone', value: p, reason: 'integration test' } });
      const r = await checkout(await cartWith([['BN-J2-1', 1]]), { phone: p });
      expect([r.status, r.body.code]).toEqual([403, 'ORDER_BLOCKED']);
      await db!.blockedContact.create({ data: { kind: 'ip', value: '10.97.0.1', reason: 'integration test' } });
      const byIp = await checkout(await cartWith([['BN-J2-1', 1]]), {}, randomUUID(), '10.97.0.1');
      expect(byIp.body.code).toBe('ORDER_BLOCKED');
    });

    it('limits orders per phone number', async () => {
      await db!.setting.upsert({
        where: { key: 'order_limit_per_phone_24h' },
        create: { key: 'order_limit_per_phone_24h', value: 1 },
        update: { value: 1 },
      });
      try {
        const p = phone();
        expect((await checkout(await cartWith([['BN-J2-1', 1]]), { phone: p })).status).toBe(201);
        const second = await checkout(await cartWith([['BN-J2-1', 1]]), { phone: p });
        expect([second.status, second.body.code]).toEqual([429, 'TOO_MANY_ORDERS']);
      } finally {
        await db!.setting.update({ where: { key: 'order_limit_per_phone_24h' }, data: { value: 5 } });
      }
    });
  });

  describe('tracking', () => {
    it('finds an order only with the matching phone number, without personal details', async () => {
      const p = phone();
      const placed = await checkout(await cartWith([['BN-J2-1', 1]]), { phone: p });
      const ok = await call('GET', `/orders/track?orderNo=${placed.body.orderNo.toLowerCase()}&phone=${p}`);
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({
        orderNo: placed.body.orderNo,
        status: 'pending',
        district: 'Dhaka',
        area: 'Dhanmondi',
      });
      expect(ok.body.history).toHaveLength(1);
      expect(JSON.stringify(ok.body)).not.toMatch(/Test Buyer|House 1/);
      const wrong = await call('GET', `/orders/track?orderNo=${placed.body.orderNo}&phone=01799999999`);
      expect([wrong.status, wrong.body.code]).toEqual([404, 'ORDER_NOT_FOUND']);
    });
  });

  describe('SMS outbox', () => {
    const log = pino({ level: 'silent' }) as unknown as FastifyBaseLogger;

    it('sends queued messages once, and retries failures with a delay', async () => {
      const ok = await db!.smsMessage.create({ data: { to: '01700000001', body: 'hello', template: 'test' } });
      const bad = await db!.smsMessage.create({ data: { to: '01700000002', body: 'fails', template: 'test' } });
      const sent: string[] = [];
      const driver = {
        name: 'fake',
        send: async (to: string) => {
          if (to === '01700000002') throw new Error('provider down');
          sent.push(to);
          return { providerRef: 'ref-1' };
        },
      };
      // Drain everything due (earlier tests also queued messages).
      while ((await processOutbox(db!, driver, log)) > 0);
      expect(sent.filter((t) => t === '01700000001')).toHaveLength(1);
      expect(await db!.smsMessage.findUniqueOrThrow({ where: { id: ok.id } })).toMatchObject({
        status: 'sent',
        providerRef: 'ref-1',
      });
      const failed = await db!.smsMessage.findUniqueOrThrow({ where: { id: bad.id } });
      expect(failed).toMatchObject({ status: 'queued', attempts: 1, lastError: 'provider down' });
      expect(failed.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

      // After the last allowed attempt it is marked failed.
      await db!.smsMessage.update({ where: { id: bad.id }, data: { attempts: 4, nextAttemptAt: new Date(0) } });
      await processOutbox(db!, driver, log);
      expect((await db!.smsMessage.findUniqueOrThrow({ where: { id: bad.id } })).status).toBe('failed');
      await db!.smsMessage.deleteMany({ where: { id: { in: [ok.id, bad.id] } } });
    });
  });
});
