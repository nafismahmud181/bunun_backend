// Part 6a against a real database, with an in-memory courier: booking (and never twice), a
// rejected or unanswered booking, status updates moving the order on, the webhook, the public
// track page, and the delivery-history risk. TEST_DATABASE_URL=... npm run test:integration
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createPrisma } from '../../src/lib/prisma.js';
import { fakeCourier } from '../../src/services/courier/index.js';
import { memoryStore } from '../../src/services/storage.js';
import { syncShipments } from '../../src/services/shipments.js';
import { TEST_KEY, signedInAdmin } from './helpers.js';

const url = process.env.TEST_DATABASE_URL;
const db = url ? createPrisma(url) : null;
type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
const courier = fakeCourier();
const tag = randomBytes(3).toString('hex');
const SKU = 'BN-J1-1';
let handler: string;
let savedStock: number | undefined;
let dhanmondi: number;
const phone = `0171${String(Date.now()).slice(-7)}`;

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await app.inject({
    method: method as 'GET',
    url: `/api/v1${path}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body !== undefined && { payload: body as object }),
  });
  return { status: res.statusCode, body: res.statusCode === 204 ? null : res.json(), headers: res.headers };
}

/** A confirmed web order for this test's phone number. */
async function confirmedOrder() {
  const cart = await call('POST', '/cart/items', undefined, { sku: SKU, qty: 1 });
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/checkout',
    remoteAddress: `10.66.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
    headers: { 'x-cart-token': cart.body.token, 'idempotency-key': randomUUID() },
    payload: { name: 'Rahima Begum', phone, areaId: dhanmondi, address: 'House 7, Road 3', paymentMethod: 'cod' },
  });
  const orderNo = res.json().orderNo as string;
  await call('POST', `/admin/orders/${orderNo}/status`, handler, { to: 'confirmed' });
  return orderNo;
}

describe.skipIf(!url)('part 6a: courier booking and tracking (database)', () => {
  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: url!,
      LOG_LEVEL: 'silent',
      RATE_LIMIT: 'off',
      ADMIN_ENCRYPTION_KEY: TEST_KEY,
      PATHAO_WEBHOOK_SECRET: 'hook-secret',
    });
    app = await buildApp(config, db!, memoryStore(), courier);
    handler = await signedInAdmin(app, db!, `handler6a-${tag}@test.bunon`, 'order_handler');
    dhanmondi = (await db!.area.findFirstOrThrow({ where: { nameEn: 'Dhanmondi', districtId: 47 } })).id;
    savedStock = (await db!.productVariant.findUniqueOrThrow({ where: { sku: SKU } })).stock;
    await db!.productVariant.update({ where: { sku: SKU }, data: { stock: 50, weightGrams: 400 } });
  });

  afterAll(async () => {
    const orders = await db!.order.findMany({ where: { phone }, select: { id: true } });
    const ids = orders.map((o) => o.id);
    await db!.smsMessage.deleteMany({ where: { orderId: { in: ids } } });
    await db!.inventoryMovement.deleteMany({ where: { orderId: { in: ids } } });
    await db!.order.deleteMany({ where: { id: { in: ids } } }); // shipments cascade
    await db!.customer.deleteMany({ where: { phone } });
    if (savedStock !== undefined)
      await db!.productVariant.update({ where: { sku: SKU }, data: { stock: savedStock, weightGrams: null } });
    const admins = await db!.adminUser.findMany({ where: { email: { contains: tag } } });
    await db!.auditLog.deleteMany({ where: { adminId: { in: admins.map((a) => a.id) } } });
    await db!.adminUser.deleteMany({ where: { id: { in: admins.map((a) => a.id) } } });
    await app.close();
  });

  let orderNo: string;
  it('books a confirmed order once, with the weight and COD amount from the order', async () => {
    orderNo = await confirmedOrder();
    const parcel = (await call('GET', `/admin/orders/${orderNo}/parcel`, handler)).body;
    expect(parcel).toMatchObject({ weightKg: 0.5, weightKnown: true }); // 0.4 kg, Pathao's minimum is 0.5
    const booked = await call('POST', `/admin/orders/${orderNo}/shipments`, handler, { note: 'Fragile' });
    expect(booked.status).toBe(201);
    expect(booked.body.status).toBe('processing'); // confirmed → packed, waiting for the rider
    const s = booked.body.shipments[0];
    expect(s).toMatchObject({ state: 'active', statusLabel: 'Booked, waiting for pickup', deliveryFee: 60 });
    expect(s.codAmount).toBe(booked.body.total);
    expect(s.trackingUrl).toContain(s.consignmentId);
    expect(courier.parcels.get(s.consignmentId)).toMatchObject({ merchantOrderId: orderNo, phone });

    const again = await call('POST', `/admin/orders/${orderNo}/shipments`, handler, {});
    expect([again.status, again.body.code]).toEqual([409, 'ALREADY_BOOKED']);
    expect(courier.parcels.size).toBe(1);
  });

  it('moves the order on as the courier reports progress (sync and webhook)', async () => {
    const detail = (await call('GET', `/admin/orders/${orderNo}`, handler)).body;
    const consignmentId = detail.shipments[0].consignmentId as string;

    courier.setStatus(consignmentId, 'in_transit');
    await db!.shipment.updateMany({ where: { consignmentId }, data: { checkedAt: new Date(0) } });
    await syncShipments(db!, courier, 15, 'http://localhost:3000', app.log);
    let o = (await call('GET', `/admin/orders/${orderNo}`, handler)).body;
    expect(o.status).toBe('shipped');
    expect(o.history.at(-1)).toMatchObject({ to: 'shipped', by: 'Pathao (courier)', note: 'Pathao: In transit' });
    expect(await db!.smsMessage.count({ where: { order: { orderNo }, template: 'order_shipped' } })).toBe(1);

    // The webhook body is only a hint: the status comes from the courier's API.
    courier.setStatus(consignmentId, 'delivered');
    const hook = await call('POST', '/webhooks/pathao', undefined, {
      event: 'order.delivered',
      consignment_id: consignmentId,
      order_status: 'Returned', // ignored
    });
    expect(hook.status).toBe(202);
    expect(hook.headers['x-pathao-merchant-webhook-integration-secret']).toBe('hook-secret');
    await new Promise((r) => setTimeout(r, 500)); // the refresh runs after the reply
    o = (await call('GET', `/admin/orders/${orderNo}`, handler)).body;
    expect(o).toMatchObject({ status: 'delivered', paymentStatus: 'paid' });
    expect(o.shipments[0].state).toBe('delivered');
    expect(o.shipments[0].events.map((e: { source: string }) => e.source)).toEqual(['booking', 'sync', 'webhook']);

    const tracked = (await call('GET', `/orders/track?orderNo=${orderNo}&phone=${phone}`)).body;
    expect(tracked.courier).toMatchObject({ name: 'Pathao', consignmentId, status: 'Delivered' });
    const integration = await call('POST', '/webhooks/pathao', undefined, { event: 'webhook_integration' });
    expect(integration.status).toBe(202);
  });

  it('frees the order when the courier refuses, and holds it when the courier gives no answer', async () => {
    const second = await confirmedOrder();
    courier.failNext('rejected');
    const refused = await call('POST', `/admin/orders/${second}/shipments`, handler, {});
    expect([refused.status, refused.body.code]).toEqual([422, 'COURIER_REJECTED']);
    expect(refused.body.details.fields.recipient_phone).toMatch(/phone/);
    expect(await db!.shipment.count({ where: { order: { orderNo: second } } })).toBe(0);

    courier.failNext('unavailable');
    const unknown = await call('POST', `/admin/orders/${second}/shipments`, handler, {});
    expect([unknown.status, unknown.body.code]).toEqual([502, 'COURIER_UNKNOWN']);
    const blocked = await call('POST', `/admin/orders/${second}/shipments`, handler, {});
    expect(blocked.body.code).toBe('ALREADY_BOOKED'); // until staff check the courier's panel
    const waiting = (await call('GET', `/admin/orders/${second}`, handler)).body.shipments[0];
    expect(waiting).toMatchObject({ state: 'booking' });
    await call('POST', `/admin/orders/${second}/shipments/${waiting.id}/cancel`, handler);
    expect((await call('POST', `/admin/orders/${second}/shipments`, handler, {})).status).toBe(201);
  });

  it('rates the phone number from its delivered and returned orders', async () => {
    const third = await confirmedOrder();
    const risk = (await call('GET', `/admin/orders/${third}`, handler)).body.customer.risk;
    expect(risk).toEqual({ level: 'good', successRate: 100 }); // one delivered so far
  });
});
