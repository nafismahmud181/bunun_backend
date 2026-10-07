// Part 5a against a real database: coupons at checkout, reviews by buyers with photos, the review
// approval queue, star ratings, and the wishlist product lookup. TEST_DATABASE_URL=... npm run test:integration
import { randomBytes, randomUUID } from 'node:crypto';
import sharp from 'sharp';
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
const store = memoryStore();
const tag = randomBytes(3).toString('hex').toUpperCase();
const SKU = 'BN-J1-1'; // Jute Wall Hanging, ৳1,100
let slug: string;
let owner: string;
let manager: string;
let handler: string;
let dhanmondi: number;
// Undefined until read, so a failed setup never "restores" a wrong stock level.
let savedStock: number | undefined;
const phones: string[] = [];
const newPhone = () => {
  const p = `0151${String(Date.now() + phones.length).slice(-7)}`;
  phones.push(p);
  return p;
};
const code = (name: string) => `${name}${tag}`;

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await app.inject({
    method: method as 'GET',
    url: `/api/v1${path}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body !== undefined && { payload: body as object }),
  });
  return { status: res.statusCode, body: res.statusCode === 204 ? null : res.json() };
}

async function cartWith(qty: number) {
  const cart = await call('POST', '/cart/items', undefined, { sku: SKU, qty });
  return cart.body.token as string;
}

/** Places a web order with 2 × ৳1,100 from its own IP (so the per-IP order limit never trips). */
async function checkout(phone: string, coupon?: string) {
  const token = await cartWith(2);
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/checkout',
    remoteAddress: `10.55.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
    headers: { 'x-cart-token': token, 'idempotency-key': randomUUID() },
    payload: {
      name: 'Rahima Begum',
      phone,
      areaId: dhanmondi,
      address: 'House 7, Road 3',
      paymentMethod: 'cod',
      ...(coupon && { coupon }),
    },
  });
  return { status: res.statusCode, body: res.json() };
}

async function quote(coupon: string, phone?: string) {
  const token = await cartWith(2);
  const qs = new URLSearchParams({ areaId: String(dhanmondi), coupon, ...(phone && { phone }) });
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/cart/quote?${qs}`,
    headers: { 'x-cart-token': token },
  });
  return res.json();
}

const photo = () =>
  sharp({ create: { width: 500, height: 400, channels: 3, background: '#a0522d' } })
    .png()
    .toBuffer();

async function submitReview(fields: Record<string, string>, photos: Buffer[] = []) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  photos.forEach((p, i) => form.append('photo', new Blob([new Uint8Array(p)], { type: 'image/png' }), `p${i}.png`));
  const req = new Request('http://local/', { method: 'POST', body: form });
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/reviews',
    headers: { 'content-type': req.headers.get('content-type')! },
    payload: Buffer.from(await req.arrayBuffer()),
  });
  return { status: res.statusCode, body: res.json() };
}

describe.skipIf(!url)('part 5a: coupons, reviews, wishlist (database)', () => {
  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: url!,
      LOG_LEVEL: 'silent',
      RATE_LIMIT: 'off',
      ADMIN_ENCRYPTION_KEY: TEST_KEY,
    });
    app = await buildApp(config, db!, store);
    owner = await signedInAdmin(app, db!, `owner5a-${tag.toLowerCase()}@test.bunon`, 'owner');
    manager = await signedInAdmin(app, db!, `manager5a-${tag.toLowerCase()}@test.bunon`, 'manager');
    handler = await signedInAdmin(app, db!, `handler5a-${tag.toLowerCase()}@test.bunon`, 'order_handler');
    dhanmondi = (await db!.area.findFirstOrThrow({ where: { nameEn: 'Dhanmondi', districtId: 47 } })).id;
    const v = await db!.productVariant.findUniqueOrThrow({ where: { sku: SKU }, include: { product: true } });
    savedStock = v.stock;
    slug = v.product.slug;
    await db!.productVariant.update({ where: { sku: SKU }, data: { stock: 60 } });
  });

  afterAll(async () => {
    const orders = await db!.order.findMany({ where: { phone: { in: phones } }, select: { id: true, orderNo: true } });
    const ids = orders.map((o) => o.id);
    const reviews = await db!.review.findMany({ where: { orderId: { in: ids } }, select: { productId: true } });
    await db!.review.deleteMany({ where: { orderId: { in: ids } } });
    for (const productId of new Set(reviews.map((r) => r.productId))) {
      const agg = await db!.review.aggregate({
        where: { productId, status: 'approved' },
        _avg: { rating: true },
        _count: { _all: true },
      });
      await db!.product.update({
        where: { id: productId },
        data: { ratingAvg: agg._avg.rating, ratingCount: agg._count._all },
      });
    }
    await db!.smsMessage.deleteMany({ where: { orderId: { in: ids } } });
    await db!.inventoryMovement.deleteMany({ where: { orderId: { in: ids } } });
    await db!.order.deleteMany({ where: { id: { in: ids } } });
    await db!.customer.deleteMany({ where: { phone: { in: phones } } });
    await db!.coupon.deleteMany({ where: { code: { endsWith: tag } } });
    if (savedStock !== undefined) await db!.productVariant.update({ where: { sku: SKU }, data: { stock: savedStock } });
    const admins = await db!.adminUser.findMany({ where: { email: { contains: tag.toLowerCase() } } });
    await db!.auditLog.deleteMany({ where: { adminId: { in: admins.map((a) => a.id) } } });
    await db!.adminUser.deleteMany({ where: { id: { in: admins.map((a) => a.id) } } });
    await app.close();
  });

  describe('coupons', () => {
    it('lets owners and managers create coupons, with sensible rules', async () => {
      expect((await call('POST', '/admin/coupons', handler, { code: 'X1', type: 'fixed', value: 1 })).status).toBe(403);
      const pct = await call('POST', '/admin/coupons', manager, {
        code: code('eid').toLowerCase(),
        type: 'percent',
        value: 10,
        maxDiscount: 150,
        minSubtotal: 1000,
        description: 'Eid sale',
      });
      expect(pct.status).toBe(201);
      expect(pct.body).toMatchObject({ code: code('EID'), summary: '10% off (up to ৳150)', state: 'active' });
      for (const body of [
        { code: code('FLAT'), type: 'fixed', value: 200, perPhoneLimit: 5 },
        { code: code('SHIP'), type: 'free_delivery', value: 999 },
        { code: code('FIRST'), type: 'fixed', value: 100, firstOrderOnly: true },
        { code: code('ONCE'), type: 'fixed', value: 50, usageLimit: 1 },
        { code: code('BIG'), type: 'fixed', value: 50, minSubtotal: 5000 },
      ])
        expect((await call('POST', '/admin/coupons', owner, body)).status).toBe(201);
      const ship = await db!.coupon.findUniqueOrThrow({ where: { code: code('SHIP') } });
      expect(ship.value).toBe(0);
      expect(
        (await call('POST', '/admin/coupons', owner, { code: code('EID'), type: 'fixed', value: 5 })).body.code,
      ).toBe('CODE_TAKEN');
      expect(
        (await call('POST', '/admin/coupons', owner, { code: code('BAD'), type: 'percent', value: 150 })).status,
      ).toBe(400);
      const later = new Date(Date.now() + 86400_000).toISOString();
      const past = new Date(Date.now() - 86400_000).toISOString();
      await call('POST', '/admin/coupons', owner, { code: code('SOON'), type: 'fixed', value: 10, startsAt: later });
      await call('POST', '/admin/coupons', owner, { code: code('OLD'), type: 'fixed', value: 10, endsAt: past });
      const list = await call('GET', `/admin/coupons?q=${tag}`, owner);
      const state = (c: string) => list.body.find((x: { code: string }) => x.code === code(c))?.state;
      expect([state('SOON'), state('OLD'), state('EID')]).toEqual(['scheduled', 'expired', 'active']);
    });

    it('prices the cart quote with a coupon, or explains why not', async () => {
      // 2 × ৳1,100 = ৳2,200; 10% is ৳220, capped at ৳150; ৳2,050 is under ৳3,000 so delivery is ৳70.
      expect(await quote(code('eid'))).toMatchObject({
        subtotal: 2200,
        discount: 150,
        deliveryFee: 70,
        total: 2120,
        coupon: { code: code('EID'), saved: 150, description: 'Eid sale' },
      });
      expect(await quote(code('SHIP'))).toMatchObject({
        discount: 0,
        deliveryFee: 0,
        total: 2200,
        coupon: { saved: 70 },
      });
      const bad = await quote('NOPE123');
      expect(bad).toMatchObject({
        discount: 0,
        total: 2270,
        coupon: null,
        couponError: "That coupon code isn't valid.",
      });
      expect((await quote(code('BIG'))).couponError).toBe('This coupon needs items worth at least ৳5,000.');
      expect((await quote(code('SOON'))).couponError).toBe("That coupon isn't active yet.");
      expect((await quote(code('OLD'))).couponError).toBe('That coupon has expired.');
      // Before the shopper picks an area there is no delivery fee yet, but the coupon still applies.
      const token = await cartWith(2);
      const early = await app.inject({
        method: 'GET',
        url: `/api/v1/cart/quote?coupon=${code('EID')}`,
        headers: { 'x-cart-token': token },
      });
      expect(early.json()).toMatchObject({ discount: 150, deliveryFee: null, total: 2050, zone: null });
    });

    let orderNo: string;
    let buyer: string;
    it('applies a coupon at checkout, once per phone number', async () => {
      buyer = newPhone();
      const r = await checkout(buyer, code('eid'));
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({
        subtotal: 2200,
        discount: 150,
        deliveryFee: 70,
        total: 2120,
        couponCode: code('EID'),
      });
      orderNo = r.body.orderNo;
      const coupon = await db!.coupon.findUniqueOrThrow({
        where: { code: code('EID') },
        include: { redemptions: true },
      });
      expect(coupon.usedCount).toBe(1);
      expect(coupon.redemptions[0]).toMatchObject({ phone: buyer, amount: 150 });
      const again = await checkout(buyer, code('EID'));
      expect([again.status, again.body.message]).toEqual([400, "You've already used this coupon."]);
      // The quote doesn't take a phone (it would reveal who has ordered): its per-phone rules wait
      // for checkout, so the quote still shows the discount.
      expect((await quote(code('EID'), buyer)).couponError).toBeUndefined();
      // This phone has ordered before, so a first-order coupon doesn't apply.
      expect((await checkout(buyer, code('FIRST'))).body.message).toBe('This coupon is only for your first order.');
      expect((await checkout(newPhone(), code('FIRST'))).body).toMatchObject({ discount: 100, total: 2170 });
      // A failed coupon leaves the stock alone (the whole order rolled back).
      expect((await db!.productVariant.findUniqueOrThrow({ where: { sku: SKU } })).stock).toBe(56);
    });

    it('stops at the usage limit, and gives the use back when the order is cancelled', async () => {
      const first = await checkout(newPhone(), code('ONCE'));
      expect(first.status).toBe(201);
      expect((await checkout(newPhone(), code('ONCE'))).body.message).toBe('That coupon has been fully used.');

      const detail = await call('GET', `/admin/orders/${first.body.orderNo}`, handler);
      expect(detail.body).toMatchObject({ couponCode: code('ONCE'), discount: 50 });
      await call('POST', `/admin/orders/${first.body.orderNo}/status`, handler, { to: 'cancelled' });
      const once = await db!.coupon.findUniqueOrThrow({ where: { code: code('ONCE') } });
      expect(once.usedCount).toBe(0);
      expect((await checkout(newPhone(), code('ONCE'))).status).toBe(201);
    });

    it('keeps a used coupon’s discount fixed and only disables it', async () => {
      const eid = await db!.coupon.findUniqueOrThrow({ where: { code: code('EID') } });
      expect((await call('PATCH', `/admin/coupons/${eid.id}`, owner, { value: 20 })).body.code).toBe('COUPON_IN_USE');
      expect((await call('DELETE', `/admin/coupons/${eid.id}`, owner)).body.code).toBe('COUPON_IN_USE');
      const off = await call('PATCH', `/admin/coupons/${eid.id}`, owner, { active: false, usageLimit: 500 });
      expect(off.body).toMatchObject({ state: 'disabled', usageLimit: 500 });
      expect((await quote(code('EID'))).couponError).toBe("That coupon code isn't valid.");
      const detail = await call('GET', `/admin/coupons/${eid.id}`, owner);
      expect(detail.body.redemptions[0]).toMatchObject({ orderNo, phone: buyer, amount: 150, orderTotal: 2120 });
      const unused = await db!.coupon.findUniqueOrThrow({ where: { code: code('BIG') } });
      expect((await call('PATCH', `/admin/coupons/${unused.id}`, owner, { value: 75 })).body.value).toBe(75);
      expect((await call('DELETE', `/admin/coupons/${unused.id}`, owner)).status).toBe(204);
      const audit = await db!.auditLog.findMany({ where: { entityType: 'coupon', entityId: String(eid.id) } });
      expect(audit.map((a) => a.action).sort()).toEqual(['coupon.create', 'coupon.update']);
    });
  });

  describe('reviews', () => {
    let orderNo: string;
    let phone: string;
    let reviewId: number;
    it('lets buyers review a delivered order, with photos', async () => {
      phone = newPhone();
      orderNo = (await checkout(phone)).body.orderNo;
      const lookup = () => call('POST', '/reviews/lookup', undefined, { orderNo: orderNo.toLowerCase(), phone });
      expect((await lookup()).body.code).toBe('NOT_DELIVERED');
      expect((await call('POST', '/reviews/lookup', undefined, { orderNo, phone: '01999999999' })).status).toBe(404);
      await db!.order.update({ where: { orderNo }, data: { status: 'delivered' } });
      const found = await lookup();
      expect(found.body).toMatchObject({ orderNo, suggestedName: 'Rahima B.', items: [{ slug, reviewed: false }] });

      const fields = { orderNo, phone, slug, rating: '5', name: 'Rahima B.' };
      expect((await submitReview({ ...fields, body: 'Nice' })).body.code).toBe('INVALID_REVIEW');
      expect((await submitReview({ ...fields, slug: 'not-in-order', body: 'Lovely wall hanging.' })).body.code).toBe(
        'NOT_IN_ORDER',
      );
      const before = store.files.size;
      const ok = await submitReview(
        { ...fields, body: 'Beautiful jute work, even better than the photos. Arrived well packed in two days.' },
        [await photo(), await photo()],
      );
      expect(ok).toMatchObject({ status: 201, body: { status: 'pending' } });
      reviewId = ok.body.id;
      expect(store.files.size).toBe(before + 6); // 2 photos × 3 sizes
      expect((await submitReview({ ...fields, body: 'Second try at a review.' })).body.code).toBe('ALREADY_REVIEWED');
      expect((await lookup()).body.items[0].reviewed).toBe(true);
    });

    it('shows a review only after approval, and updates the star rating', async () => {
      const publicList = async () => (await call('GET', `/products/${slug}/reviews`)).body;
      const mine = (l: { items: { id: number }[] }) => l.items.find((r) => r.id === reviewId);
      expect(mine(await publicList())).toBeUndefined();
      expect((await call('GET', '/admin/reviews', handler)).status).toBe(403);
      const queue = await call('GET', '/admin/reviews?status=pending', manager);
      const item = queue.body.items.find((r: { id: number }) => r.id === reviewId);
      expect(item).toMatchObject({ orderNo, phone, rating: 5, city: 'Dhaka', product: { slug } });
      expect(item.images).toHaveLength(2);

      await call('PATCH', `/admin/reviews/${reviewId}`, manager, { status: 'approved' });
      const approved = await publicList();
      expect(mine(approved)).toMatchObject({ name: 'Rahima B.', city: 'Dhaka', rating: 5 });
      expect(approved.summary.breakdown['5']).toBeGreaterThanOrEqual(1);
      const product = (await call('GET', `/products/${slug}`)).body;
      expect(product.rating.count).toBe(approved.summary.count);
      const featured = (await call('GET', '/reviews/featured?limit=12')).body;
      expect(featured.items.map((r: { id: number }) => r.id)).toContain(reviewId);
      expect(featured.count).toBeGreaterThanOrEqual(1);

      await call('PATCH', `/admin/reviews/${reviewId}`, manager, { status: 'rejected' });
      expect(mine(await publicList())).toBeUndefined();
      const after = (await call('GET', `/products/${slug}`)).body;
      expect(after.rating?.count ?? 0).toBe(product.rating.count - 1);
      const log = await db!.auditLog.findMany({ where: { entityType: 'review', entityId: String(reviewId) } });
      expect(log.map((l) => l.action)).toEqual(['review.approve', 'review.reject']);
    });

    it('deletes a review with its photos', async () => {
      const before = store.files.size;
      expect((await call('DELETE', `/admin/reviews/${reviewId}`, owner)).status).toBe(204);
      expect(store.files.size).toBe(before - 6);
      expect(await db!.review.findUnique({ where: { id: reviewId } })).toBeNull();
    });
  });

  describe('wishlist', () => {
    it('looks up products by slug, leaving out unknown ones', async () => {
      const r = await call('GET', `/products?slugs=${slug},no-such-product`);
      expect(r.body.items.map((p: { slug: string }) => p.slug)).toEqual([slug]);
      expect((await call('GET', '/products?slugs=Bad Slug')).status).toBe(400);
    });
  });
});
