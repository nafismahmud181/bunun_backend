// Part 3c against a real database: manual orders, customers, settings and zones, block list,
// staff management, dashboard and audit log. TEST_DATABASE_URL=... npm run test:integration
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createPrisma } from '../../src/lib/prisma.js';
import { memoryStore } from '../../src/services/storage.js';
import { TEST_KEY, signedInAdmin } from './helpers.js';

const url = process.env.TEST_DATABASE_URL;
const db = url ? createPrisma(url) : null;
type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
const tag = randomBytes(3).toString('hex');
const SKU = 'BN-J1-1'; // Jute Wall Hanging, ৳1,100
let owner: string;
let handler: string;
let manager: string;
let dhanmondi: number;
let savedStock = 0;
let savedSettings: { key: string; value: unknown }[] = [];
const phone = `0161${String(Date.now()).slice(-7)}`;

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await app.inject({
    method: method as 'GET',
    url: `/api/v1${path}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body !== undefined && { payload: body as object }),
  });
  return { status: res.statusCode, body: res.statusCode === 204 ? null : res.json() };
}
const manual = (over: Record<string, unknown> = {}) => ({
  source: 'facebook',
  name: 'Facebook Buyer',
  phone,
  areaId: dhanmondi,
  address: 'Flat 3B, Road 27',
  items: [{ sku: SKU, qty: 2 }],
  discount: 0,
  idempotencyKey: randomUUID(),
  ...over,
});

describe.skipIf(!url)('admin part 3c (database)', () => {
  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: url!,
      LOG_LEVEL: 'silent',
      RATE_LIMIT: 'off',
      ADMIN_ENCRYPTION_KEY: TEST_KEY,
    });
    app = await buildApp(config, db!, memoryStore());
    owner = await signedInAdmin(app, db!, `owner-${tag}@test.bunon`, 'owner');
    handler = await signedInAdmin(app, db!, `handler-${tag}@test.bunon`, 'order_handler');
    manager = await signedInAdmin(app, db!, `manager-${tag}@test.bunon`, 'manager');
    dhanmondi = (await db!.area.findFirstOrThrow({ where: { nameEn: 'Dhanmondi', districtId: 47 } })).id;
    savedStock = (await db!.productVariant.findUniqueOrThrow({ where: { sku: SKU } })).stock;
    await db!.productVariant.update({ where: { sku: SKU }, data: { stock: 30 } });
    savedSettings = await db!.setting.findMany();
  });

  afterAll(async () => {
    const orders = await db!.order.findMany({ where: { phone }, select: { id: true, orderNo: true } });
    const ids = orders.map((o) => o.id);
    await db!.smsMessage.deleteMany({ where: { orderId: { in: ids } } });
    await db!.inventoryMovement.deleteMany({ where: { orderId: { in: ids } } });
    await db!.order.deleteMany({ where: { id: { in: ids } } });
    await db!.blockedContact.deleteMany({ where: { OR: [{ value: phone }, { reason: { contains: tag } }] } });
    await db!.customer.deleteMany({ where: { phone } });
    await db!.area.updateMany({ where: { zoneKey: `suburbs-${tag}` }, data: { zoneKey: null } });
    await db!.deliveryZone.deleteMany({ where: { key: `suburbs-${tag}` } });
    await db!.productVariant.update({ where: { sku: SKU }, data: { stock: savedStock } });
    await db!.setting.deleteMany({ where: { key: { notIn: savedSettings.map((s) => s.key) } } });
    for (const s of savedSettings)
      await db!.setting.update({ where: { key: s.key }, data: { value: s.value as never } });
    const admins = await db!.adminUser.findMany({ where: { email: { contains: tag } }, select: { id: true } });
    await db!.auditLog.deleteMany({
      where: { OR: [{ adminId: { in: admins.map((a) => a.id) } }, { entityId: { in: orders.map((o) => o.orderNo) } }] },
    });
    await db!.order.updateMany({
      where: { createdById: { in: admins.map((a) => a.id) } },
      data: { createdById: null },
    });
    await db!.adminUser.deleteMany({ where: { id: { in: admins.map((a) => a.id) } } });
    await app.close();
  });

  describe('manual orders', () => {
    let orderNo: string;
    it('creates a confirmed order with catalogue prices, a discount and the zone fee', async () => {
      const r = await call('POST', '/admin/orders', handler, manual({ discount: 200 }));
      expect(r.status).toBe(201);
      // 2 × 1,100 = 2,200 − 200 = 2,000 (below ৳3,000, so ৳70 delivery inside Dhaka)
      expect(r.body).toMatchObject({ status: 'confirmed', subtotal: 2200, deliveryFee: 70, total: 2070, phone });
      orderNo = r.body.orderNo;
      const o = await db!.order.findUniqueOrThrow({
        where: { orderNo },
        include: { history: true, smsMessages: true, createdBy: true },
      });
      expect(o).toMatchObject({ source: 'facebook', discount: 200 });
      expect(o.createdBy?.email).toBe(`handler-${tag}@test.bunon`);
      expect(o.history[0]).toMatchObject({ toStatus: 'confirmed', note: 'Manual order (facebook), discount ৳200' });
      expect(o.smsMessages[0]!.template).toBe('order_manual');
      expect((await db!.productVariant.findUniqueOrThrow({ where: { sku: SKU } })).stock).toBe(28);
    });

    it('is not created twice with the same key, and checks its input', async () => {
      const key = randomUUID();
      const [a, b] = [
        await call('POST', '/admin/orders', handler, manual({ idempotencyKey: key })),
        await call('POST', '/admin/orders', handler, manual({ idempotencyKey: key })),
      ];
      expect([a.status, b.status]).toEqual([201, 200]);
      expect(b.body.orderNo).toBe(a.body.orderNo);
      expect(
        (await call('POST', '/admin/orders', handler, manual({ items: [{ sku: 'NOPE-1', qty: 1 }] }))).body.code,
      ).toBe('UNKNOWN_SKU');
      expect((await call('POST', '/admin/orders', handler, manual({ discount: 99999 }))).body.code).toBe(
        'BAD_DISCOUNT',
      );
      expect(
        (await call('POST', '/admin/orders', handler, manual({ items: [{ sku: SKU, qty: 100 }] }))).body.code,
      ).toBe('OUT_OF_STOCK');
    });
  });

  describe('customers', () => {
    it('lists customers with stats, keeps notes and blocks online orders', async () => {
      const list = await call('GET', `/admin/customers?q=${phone}`, handler);
      const c = list.body.items[0];
      expect(c).toMatchObject({ phone, name: 'Facebook Buyer', orders: 2, delivered: 0, blocked: false });

      const noted = await call('PATCH', `/admin/customers/${c.id}`, handler, { notes: 'Prefers evening delivery' });
      expect(noted.body.notes).toBe('Prefers evening delivery');
      expect(noted.body.recentOrders).toHaveLength(2);

      const blocked = await call('POST', `/admin/customers/${c.id}/block`, handler, {
        reason: `Refused two parcels ${tag}`,
      });
      expect(blocked.body.blocked).toMatchObject({ reason: `Refused two parcels ${tag}` });
      // The website refuses orders from that number now.
      const cart = await call('POST', '/cart/items', undefined, { sku: SKU, qty: 1 });
      const web = await app.inject({
        method: 'POST',
        url: '/api/v1/checkout',
        headers: { 'x-cart-token': cart.body.token, 'idempotency-key': randomUUID() },
        payload: { name: 'X Y', phone, areaId: dhanmondi, address: 'House 1', paymentMethod: 'cod' },
      });
      expect(web.json().code).toBe('ORDER_BLOCKED');
      expect(
        (await call('GET', '/admin/customers?blocked=true', handler)).body.items.map((x: { phone: string }) => x.phone),
      ).toContain(phone);
      expect((await call('DELETE', `/admin/customers/${c.id}/block`, handler)).body.blocked).toBeNull();
    });
  });

  describe('settings and delivery zones', () => {
    it('only lets owners change settings', async () => {
      expect((await call('PATCH', '/admin/settings', manager, { hotline: '01700000000' })).status).toBe(403);
      const r = await call('PATCH', '/admin/settings', owner, {
        free_delivery_threshold: 2500,
        store_name: 'Bunon Test',
      });
      expect(r.body).toMatchObject({ free_delivery_threshold: 2500, store_name: 'Bunon Test' });
      const pub = await call('GET', '/settings');
      expect(pub.body).toMatchObject({ freeDeliveryThreshold: 2500, store: { name: 'Bunon Test' } });
      expect((await call('PATCH', '/admin/settings', owner, { store_email: 'not-an-email' })).status).toBe(400);
    });

    it('adds a zone, moves areas into it and prices delivery by it', async () => {
      const key = `suburbs-${tag}`;
      const zones = await call('POST', '/admin/delivery-zones', owner, {
        key,
        name: 'Dhaka suburbs',
        fee: 100,
        estimate: '2–3 days',
      });
      expect(zones.body.map((z: { key: string }) => z.key)).toContain(key);
      const savar = await db!.area.findFirstOrThrow({ where: { nameEn: 'Savar' } });
      const moved = await call('PUT', '/admin/delivery-zones/areas', owner, { areaIds: [savar.id], zoneKey: key });
      expect(moved.body.find((z: { key: string }) => z.key === key).areas).toBe(1);
      const loc = await call('GET', '/locations');
      const dhaka = loc.body
        .flatMap((d: { districts: unknown[] }) => d.districts)
        .find((d: { id: number }) => d.id === 47);
      expect(dhaka.areas.find((a: { id: number }) => a.id === savar.id).zone).toBe(key);
      const r = await call(
        'POST',
        '/admin/orders',
        handler,
        manual({ areaId: savar.id, items: [{ sku: SKU, qty: 1 }] }),
      );
      expect(r.body).toMatchObject({ deliveryFee: 100 });

      expect((await call('DELETE', `/admin/delivery-zones/${key}`, owner)).body.code).toBe('ZONE_IN_USE');
      expect((await call('DELETE', '/admin/delivery-zones/outside-dhaka', owner)).body.code).toBe('DEFAULT_ZONE');
      await call('PUT', '/admin/delivery-zones/areas', owner, { areaIds: [savar.id], zoneKey: null });
      expect((await call('DELETE', `/admin/delivery-zones/${key}`, owner)).status).toBe(200);
    });

    it('keeps a block list of phone numbers and IPs', async () => {
      const added = await call('POST', '/admin/blocked', owner, {
        kind: 'ip',
        value: '203.0.113.7',
        reason: `Test ${tag}`,
      });
      const entry = added.body.find((b: { value: string }) => b.value === '203.0.113.7');
      expect(entry).toMatchObject({ kind: 'ip' });
      expect(
        (await call('POST', '/admin/blocked', owner, { kind: 'phone', value: '123', reason: `Test ${tag}` })).body.code,
      ).toBe('BAD_PHONE');
      const removed = await call('DELETE', `/admin/blocked/${entry.id}`, owner);
      expect(removed.body.some((b: { id: number }) => b.id === entry.id)).toBe(false);
    });
  });

  describe('staff', () => {
    it('invites, changes roles, resets and signs people out', async () => {
      const invited = await call('POST', '/admin/staff', owner, {
        email: `new-${tag}@test.bunon`,
        name: 'New Person',
        role: 'order_handler',
      });
      expect(invited.body.password).toMatch(/^[A-Za-z0-9]{16}$/);
      expect(invited.body.member).toMatchObject({ role: 'order_handler', twoFactorSetUp: false, active: true });
      const id = invited.body.member.id;
      expect(
        (await call('POST', '/admin/staff', owner, { email: `new-${tag}@test.bunon`, name: 'Dup', role: 'manager' }))
          .body.code,
      ).toBe('EMAIL_TAKEN');
      // They can sign in with the one-time password (and must set up two-factor).
      const login = await call('POST', '/admin/auth/login', undefined, {
        email: `new-${tag}@test.bunon`,
        password: invited.body.password,
      });
      expect(login.body.stage).toBe('two_factor_setup');

      expect((await call('PATCH', `/admin/staff/${id}`, owner, { role: 'manager' })).body.role).toBe('manager');
      const reset = await call('POST', `/admin/staff/${id}/reset`, owner);
      expect(reset.body.password).not.toBe(invited.body.password);
      expect(
        (
          await call('POST', '/admin/auth/login', undefined, {
            email: `new-${tag}@test.bunon`,
            password: invited.body.password,
          })
        ).status,
      ).toBe(401);

      // Disabling signs the person out at once.
      const handlerId = (await db!.adminUser.findUniqueOrThrow({ where: { email: `handler-${tag}@test.bunon` } })).id;
      const other = await signedInAdmin(app, db!, `victim-${tag}@test.bunon`, 'order_handler');
      const victimId = (await db!.adminUser.findUniqueOrThrow({ where: { email: `victim-${tag}@test.bunon` } })).id;
      await call('PATCH', `/admin/staff/${victimId}`, owner, { active: false });
      expect((await call('GET', '/admin/auth/me', other)).status).toBe(401);
      expect((await call('GET', '/admin/staff', handler)).status).toBe(403);
      expect(handlerId).toBeGreaterThan(0);
    });

    it('always keeps an active owner, and nobody disables themselves', async () => {
      const me = await db!.adminUser.findUniqueOrThrow({ where: { email: `owner-${tag}@test.bunon` } });
      expect((await call('PATCH', `/admin/staff/${me.id}`, owner, { active: false })).body.code).toBe('SELF_CHANGE');
      expect((await call('PATCH', `/admin/staff/${me.id}`, owner, { role: 'manager' })).body.code).toBe('SELF_CHANGE');

      // Through the API the last owner can't be the target (only owners manage staff, and not
      // themselves), so the guard is a safety net. Check it directly: make `me` the only active owner.
      const others = await db!.adminUser.findMany({ where: { role: 'owner', active: true, id: { not: me.id } } });
      await db!.adminUser.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { active: false } });
      try {
        const actor = await db!.adminUser.findUniqueOrThrow({ where: { email: `manager-${tag}@test.bunon` } });
        const { updateStaff } = await import('../../src/services/admin-staff.js');
        await expect(
          updateStaff(db!, me.id, { role: 'manager' }, { admin: actor, ip: '127.0.0.1' }),
        ).rejects.toMatchObject({ code: 'LAST_OWNER' });
        await expect(
          updateStaff(db!, me.id, { active: false }, { admin: actor, ip: '127.0.0.1' }),
        ).rejects.toMatchObject({ code: 'LAST_OWNER' });
      } finally {
        await db!.adminUser.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { active: true } });
      }
    });

    it('changes your own password and signs out your other sessions', async () => {
      const email = `pw-${tag}@test.bunon`;
      const first = await signedInAdmin(app, db!, email, 'order_handler');
      expect(
        (await call('POST', '/admin/auth/password', first, { current: 'wrong', next: 'a-much-longer-password' })).body
          .code,
      ).toBe('WRONG_PASSWORD');
      expect(
        (await call('POST', '/admin/auth/password', first, { current: 'test-password', next: 'short' })).status,
      ).toBe(400);
      expect(
        (
          await call('POST', '/admin/auth/password', first, {
            current: 'test-password',
            next: 'a-much-longer-password',
          })
        ).status,
      ).toBe(204);
      expect((await call('GET', '/admin/auth/me', first)).status).toBe(200); // this session stays
      expect((await call('POST', '/admin/auth/login', undefined, { email, password: 'test-password' })).status).toBe(
        401,
      );
      expect(
        (await call('POST', '/admin/auth/login', undefined, { email, password: 'a-much-longer-password' })).status,
      ).toBe(200);
    });
  });

  describe('dashboard and audit log', () => {
    it("reports today's and this month's sales, top products and low stock", async () => {
      const d = await call('GET', '/admin/dashboard', handler);
      expect(d.status).toBe(200);
      expect(d.body.today.orders).toBeGreaterThanOrEqual(3); // the manual orders above
      expect(d.body.today.revenue).toBeGreaterThanOrEqual(2070);
      expect(d.body.month.orders).toBeGreaterThanOrEqual(d.body.today.orders);
      expect(d.body.last30Days).toHaveLength(30);
      expect(d.body.last30Days.at(-1).orders).toBe(d.body.today.orders);
      expect(d.body.topProducts.map((p: { name: string }) => p.name)).toContain('Jute Wall Hanging');
      expect(d.body.lowStockThreshold).toBe(5);
    });

    it('filters the audit log by person, action prefix and entity', async () => {
      expect((await call('GET', '/admin/audit', handler)).status).toBe(403); // audit:read
      const ownerId = (await db!.adminUser.findUniqueOrThrow({ where: { email: `owner-${tag}@test.bunon` } })).id;
      const mine = await call('GET', `/admin/audit?adminId=${ownerId}&action=zone.`, manager);
      expect(mine.body.items.length).toBeGreaterThanOrEqual(3);
      expect(
        mine.body.items.every(
          (i: { action: string; admin: string }) => i.action.startsWith('zone.') && i.admin === 'Test owner',
        ),
      ).toBe(true);
      expect(mine.body.admins.map((a: { id: number }) => a.id)).toContain(ownerId);
      const settingsLog = await call('GET', '/admin/audit?action=settings.update', manager);
      expect(settingsLog.body.items[0].data).toMatchObject({ free_delivery_threshold: { to: 2500 } });
    });
  });
});
