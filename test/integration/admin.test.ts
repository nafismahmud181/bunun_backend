// Admin sign-in (password + TOTP), permissions and the orders workflow against a real database.
// Needs a migrated + seeded database: TEST_DATABASE_URL=... npm run test:integration
import { randomBytes, randomUUID } from 'node:crypto';
import { generate } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createPrisma } from '../../src/lib/prisma.js';
import { hashPassword } from '../../src/services/admin-auth.js';

const url = process.env.TEST_DATABASE_URL;
const db = url ? createPrisma(url) : null;
type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;

const PASSWORD = 'correct horse battery staple';
const tag = randomBytes(3).toString('hex');
const email = (who: string) => `${who}-${tag}@test.bunon`;
const SKU = 'BN-B1-1'; // Kantha Stitch Throw, ৳3,800
const BOM = String.fromCharCode(0xfeff);
const SMALL_SKU = 'BN-C3-1'; // Jute Blend Cushion Cover, ৳650
let savedStock: { sku: string; stock: number }[] = [];
const phones: string[] = [];
let phoneSeq = 0;
const newPhone = () => {
  const p = `0181${String(7000000 + phoneSeq++).slice(-7)}`;
  phones.push(p);
  return p;
};

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const res = await app.inject({
    method,
    url: `/api/v1${path}`,
    headers: { ...(opts.token && { authorization: `Bearer ${opts.token}` }), ...opts.headers },
    ...(opts.body !== undefined && { payload: opts.body as object }),
  });
  let body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    body = res.json();
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body, headers: res.headers };
}

/** Password step, then the authenticator code; returns the session token and the TOTP secret. */
async function signIn(who: string, secret?: string, epochOffset = 0) {
  const first = await call('POST', '/admin/auth/login', { body: { email: email(who), password: PASSWORD } });
  expect(first.status).toBe(200);
  const s = secret ?? first.body.setup.secret;
  const code = await generate({ secret: s, epoch: Math.floor(Date.now() / 1000) + epochOffset });
  const second = await call('POST', '/admin/auth/2fa', { token: first.body.token, body: { code } });
  expect(second.status).toBe(200);
  return { token: second.body.token as string, secret: s };
}

/** A storefront COD order for the given SKU and quantity; returns the order number. */
async function placeOrder(sku = SKU, qty = 1, name = 'Admin Test') {
  const cart = await call('POST', '/cart/items', { body: { sku, qty } });
  const token = cart.body.token as string;
  const dhanmondi = await db!.area.findFirstOrThrow({ where: { nameEn: 'Dhanmondi', districtId: 47 } });
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/checkout',
    remoteAddress: `10.77.0.${(phoneSeq % 250) + 1}`,
    headers: { 'x-cart-token': token, 'idempotency-key': randomUUID() },
    payload: { name, phone: newPhone(), areaId: dhanmondi.id, address: 'House 1, Road 2', paymentMethod: 'cod' },
  });
  expect(res.statusCode).toBe(201);
  return res.json().orderNo as string;
}

const stockOf = async (sku: string) => (await db!.productVariant.findUniqueOrThrow({ where: { sku } })).stock;

let owner: string;
let handler: string;
let editor: string;

describe.skipIf(!url)('admin API (database)', () => {
  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: url!,
      LOG_LEVEL: 'silent',
      RATE_LIMIT: 'off',
      ADMIN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    });
    app = await buildApp(config, db!);
    savedStock = await db!.productVariant.findMany({
      where: { sku: { in: [SKU, SMALL_SKU] } },
      select: { sku: true, stock: true },
    });
    await db!.productVariant.updateMany({ where: { sku: { in: [SKU, SMALL_SKU] } }, data: { stock: 50 } });
    const passwordHash = await hashPassword(PASSWORD);
    for (const [who, role] of [
      ['owner', 'owner'],
      ['handler', 'order_handler'],
      ['editor', 'content_editor'],
      ['locked', 'order_handler'],
      ['disabled', 'order_handler'],
    ] as const)
      await db!.adminUser.create({
        data: { email: email(who), name: `Test ${who}`, role, passwordHash, active: who !== 'disabled' },
      });
    owner = (await signIn('owner')).token;
    handler = (await signIn('handler')).token;
    editor = (await signIn('editor')).token;
  });

  afterAll(async () => {
    const admins = await db!.adminUser.findMany({
      where: { email: { endsWith: `-${tag}@test.bunon` } },
      select: { id: true },
    });
    const adminIds = admins.map((a) => a.id);
    const orders = await db!.order.findMany({ where: { phone: { in: phones } }, select: { id: true, orderNo: true } });
    const orderIds = orders.map((o) => o.id);
    await db!.auditLog.deleteMany({
      where: {
        OR: [{ adminId: { in: adminIds } }, { entityType: 'order', entityId: { in: orders.map((o) => o.orderNo) } }],
      },
    });
    await db!.smsMessage.deleteMany({ where: { orderId: { in: orderIds } } });
    await db!.inventoryMovement.deleteMany({ where: { orderId: { in: orderIds } } });
    await db!.order.deleteMany({ where: { id: { in: orderIds } } });
    await db!.customer.deleteMany({ where: { phone: { in: phones } } });
    await db!.adminUser.deleteMany({ where: { id: { in: adminIds } } });
    for (const s of savedStock) await db!.productVariant.update({ where: { sku: s.sku }, data: { stock: s.stock } });
    await app.close();
  });

  describe('sign-in', () => {
    it('rejects a wrong password and an unknown email the same way', async () => {
      const wrong = await call('POST', '/admin/auth/login', { body: { email: email('owner'), password: 'nope' } });
      const unknown = await call('POST', '/admin/auth/login', { body: { email: email('nobody'), password: 'nope' } });
      expect([wrong.status, wrong.body.code]).toEqual([401, 'INVALID_LOGIN']);
      expect([unknown.status, unknown.body.message]).toEqual([401, wrong.body.message]);
    });

    it('locks the account after 10 wrong passwords', async () => {
      for (let i = 0; i < 10; i++)
        await call('POST', '/admin/auth/login', { body: { email: email('locked'), password: 'nope' } });
      const r = await call('POST', '/admin/auth/login', { body: { email: email('locked'), password: PASSWORD } });
      expect([r.status, r.body.code]).toEqual([423, 'ACCOUNT_LOCKED']);
    });

    it('refuses disabled accounts', async () => {
      const r = await call('POST', '/admin/auth/login', { body: { email: email('disabled'), password: PASSWORD } });
      expect([r.status, r.body.code]).toEqual([403, 'ACCOUNT_DISABLED']);
    });

    it('stores the TOTP secret encrypted and enables it after the first code', async () => {
      const a = await db!.adminUser.findUniqueOrThrow({ where: { email: email('owner') } });
      expect(a.totpEnabled).toBe(true);
      expect(a.totpSecret).toBeTruthy();
      expect(a.totpSecret).not.toMatch(/^[A-Z2-7]+=*$/); // not the plain base32 secret
    });

    it('drops the half-signed-in session after 5 wrong codes', async () => {
      await db!.adminUser.create({
        data: {
          email: email('codes'),
          name: 'Codes',
          role: 'order_handler',
          passwordHash: await hashPassword(PASSWORD),
        },
      });
      const first = await call('POST', '/admin/auth/login', { body: { email: email('codes'), password: PASSWORD } });
      expect(first.body.stage).toBe('two_factor_setup');
      expect(first.body.setup.otpauthUrl).toMatch(/^otpauth:\/\/totp\/Bunon%20Admin:/);
      const codes = [];
      for (let i = 0; i < 5; i++)
        codes.push(await call('POST', '/admin/auth/2fa', { token: first.body.token, body: { code: '000000' } }));
      expect(codes[0]!.body.code).toBe('INVALID_CODE');
      expect(codes[4]!.body.code).toBe('SESSION_EXPIRED');
      const code = await generate({ secret: first.body.setup.secret });
      expect((await call('POST', '/admin/auth/2fa', { token: first.body.token, body: { code } })).status).toBe(401);
    });

    it('does not accept the same code twice', async () => {
      const { token, secret } = await signIn('handler2-setup').catch(async () => {
        await db!.adminUser.create({
          data: {
            email: email('handler2-setup'),
            name: 'H2',
            role: 'order_handler',
            passwordHash: await hashPassword(PASSWORD),
          },
        });
        return signIn('handler2-setup');
      });
      expect(token).toBeTruthy();
      // Same time step again: refused. The next step's code is accepted (clock tolerance).
      const again = await call('POST', '/admin/auth/login', {
        body: { email: email('handler2-setup'), password: PASSWORD },
      });
      const sameCode = await generate({ secret });
      const replay = await call('POST', '/admin/auth/2fa', { token: again.body.token, body: { code: sameCode } });
      expect(replay.body.code).toBe('INVALID_CODE');
      const next = await generate({ secret, epoch: Math.floor(Date.now() / 1000) + 30 });
      expect((await call('POST', '/admin/auth/2fa', { token: again.body.token, body: { code: next } })).status).toBe(
        200,
      );
    });

    it('only full sessions reach the API, and logout ends them', async () => {
      const half = await call('POST', '/admin/auth/login', { body: { email: email('owner'), password: PASSWORD } });
      expect((await call('GET', '/admin/auth/me', { token: half.body.token })).status).toBe(401);
      const me = await call('GET', '/admin/auth/me', { token: owner });
      expect(me.body).toMatchObject({ email: email('owner'), role: 'owner' });
      expect(me.body.permissions).toContain('staff:manage');

      const temp = await call('POST', '/admin/auth/login', { body: { email: email('editor'), password: PASSWORD } });
      const a = await db!.adminUser.findUniqueOrThrow({ where: { email: email('editor') } });
      expect(temp.body.stage).toBe('two_factor');
      expect(a.totpEnabled).toBe(true);
      await call('POST', '/admin/auth/logout', { token: editor });
      expect((await call('GET', '/admin/auth/me', { token: editor })).status).toBe(401);
    });
  });

  describe('permissions', () => {
    it('requires a session', async () => {
      expect((await call('GET', '/admin/orders')).status).toBe(401);
      expect((await call('GET', '/admin/orders', { token: 'not-a-session' })).status).toBe(401);
    });

    it('lets each role do only its own work', async () => {
      await db!.adminUser.create({
        data: {
          email: email('editor2'),
          name: 'Editor 2',
          role: 'content_editor',
          passwordHash: await hashPassword(PASSWORD),
        },
      });
      const { token: contentEditor } = await signIn('editor2');
      const no = await placeOrder(SKU, 1);
      const denied = await call('GET', '/admin/orders', { token: contentEditor });
      expect([denied.status, denied.body.code]).toEqual([403, 'FORBIDDEN']);
      expect((await call('GET', `/admin/orders/${no}`, { token: contentEditor })).status).toBe(403);
      expect(
        (await call('POST', `/admin/orders/${no}/status`, { token: contentEditor, body: { to: 'confirmed' } })).status,
      ).toBe(403);
      expect((await call('GET', '/admin/orders', { token: handler })).status).toBe(200);
      const me = await call('GET', '/admin/auth/me', { token: contentEditor });
      expect(me.body.permissions).toEqual(['products:read', 'products:write']);
    });
  });

  describe('orders', () => {
    it('finds orders by phone, name or number, with status counts', async () => {
      const no = await placeOrder(SKU, 1, 'Searchable Person');
      const order = await db!.order.findUniqueOrThrow({ where: { orderNo: no } });
      for (const q of [order.phone, 'searchable person', no.toLowerCase()]) {
        const r = await call('GET', `/admin/orders?q=${encodeURIComponent(q)}`, { token: owner });
        expect(r.body.items.map((i: { orderNo: string }) => i.orderNo)).toContain(no);
      }
      const open = await call('GET', `/admin/orders?status=open&q=${order.phone}`, { token: owner });
      expect(open.body).toMatchObject({ total: 1, counts: { pending: 1 } });
      expect(open.body.items[0]).toMatchObject({ orderNo: no, itemCount: 1, total: 3800, status: 'pending' });
    });

    it('walks an order through confirmed → processing → shipped → delivered', async () => {
      const no = await placeOrder(SMALL_SKU, 2); // ৳1,300 + ৳70 delivery
      const detail = await call('GET', `/admin/orders/${no}`, { token: handler });
      expect(detail.body).toMatchObject({
        allowedTransitions: ['confirmed', 'cancelled'],
        editable: true,
        total: 1370,
      });
      expect(detail.body.customer).toMatchObject({ orders: 1, delivered: 0 });

      const bad = await call('POST', `/admin/orders/${no}/status`, { token: handler, body: { to: 'shipped' } });
      expect([bad.status, bad.body.code]).toEqual([409, 'INVALID_TRANSITION']);

      const confirmed = await call('POST', `/admin/orders/${no}/status`, {
        token: handler,
        body: { to: 'confirmed', note: 'Called, confirmed' },
      });
      expect(confirmed.body.status).toBe('confirmed');
      expect(confirmed.body.history.at(-1)).toMatchObject({
        from: 'pending',
        to: 'confirmed',
        by: 'Test handler',
        note: 'Called, confirmed',
      });
      expect(confirmed.body.sms.map((s: { template: string }) => s.template)).toEqual([
        'order_placed',
        'order_confirmed',
      ]);

      // Moving to an outside-Dhaka area re-prices delivery (still below the free-delivery threshold).
      const savar = await db!.area.findFirstOrThrow({ where: { nameEn: 'Savar' } });
      const edited = await call('PATCH', `/admin/orders/${no}`, {
        token: handler,
        body: { areaId: savar.id, addressLine: 'Bazar Road 9' },
      });
      expect(edited.body).toMatchObject({
        deliveryFee: 130,
        total: 1430,
        address: { area: 'Savar', line: 'Bazar Road 9' },
      });

      for (const to of ['processing', 'shipped'] as const)
        expect((await call('POST', `/admin/orders/${no}/status`, { token: handler, body: { to } })).body.status).toBe(
          to,
        );
      const late = await call('PATCH', `/admin/orders/${no}`, { token: handler, body: { name: 'Too Late' } });
      expect([late.status, late.body.code]).toEqual([409, 'NOT_EDITABLE']);
      const shippedSms = await db!.smsMessage.findFirstOrThrow({
        where: { template: 'order_shipped', order: { orderNo: no } },
      });
      expect(shippedSms.body).toContain('Tk 1,430 ready');

      const delivered = await call('POST', `/admin/orders/${no}/status`, { token: handler, body: { to: 'delivered' } });
      expect(delivered.body).toMatchObject({
        status: 'delivered',
        paymentStatus: 'paid',
        allowedTransitions: ['returned'],
      });
      expect(await db!.auditLog.count({ where: { entityType: 'order', entityId: no, action: 'order.status' } })).toBe(
        4,
      );
    });

    it('puts stock back when an order is cancelled', async () => {
      const before = await stockOf(SKU);
      const no = await placeOrder(SKU, 3);
      expect(await stockOf(SKU)).toBe(before - 3);
      const r = await call('POST', `/admin/orders/${no}/status`, {
        token: owner,
        body: { to: 'cancelled', note: 'Customer changed mind' },
      });
      expect(r.body.status).toBe('cancelled');
      expect(await stockOf(SKU)).toBe(before);
      const owners = await db!.adminUser.findUniqueOrThrow({ where: { email: email('owner') } });
      const movement = await db!.inventoryMovement.findFirstOrThrow({ where: { order: { orderNo: no }, change: 3 } });
      expect(movement).toMatchObject({ reason: 'order cancelled', adminId: owners.id });
      expect(r.body.sms.at(-1).template).toBe('order_cancelled');
    });

    it('can take back a damaged return without restocking', async () => {
      const no = await placeOrder(SKU, 1);
      for (const to of ['confirmed', 'processing', 'shipped', 'delivered'] as const)
        await call('POST', `/admin/orders/${no}/status`, { token: owner, body: { to } });
      const before = await stockOf(SKU);
      const r = await call('POST', `/admin/orders/${no}/status`, {
        token: owner,
        body: { to: 'returned', restock: false, note: 'Damaged' },
      });
      expect(r.body.status).toBe('returned');
      expect(await stockOf(SKU)).toBe(before);
      expect(r.body.allowedTransitions).toEqual(['refunded']); // it was paid on delivery
    });

    it('lets only one of two simultaneous changes win', async () => {
      const no = await placeOrder(SKU, 1);
      const results = await Promise.all([
        call('POST', `/admin/orders/${no}/status`, { token: owner, body: { to: 'confirmed' } }),
        call('POST', `/admin/orders/${no}/status`, { token: handler, body: { to: 'cancelled' } }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await db!.orderStatusHistory.count({ where: { order: { orderNo: no } } })).toBe(2); // placed + one change
    });

    it('keeps internal notes', async () => {
      const no = await placeOrder(SKU, 1);
      const r = await call('POST', `/admin/orders/${no}/notes`, {
        token: handler,
        body: { body: 'Wants delivery after 5pm' },
      });
      expect(r.body.staffNotes[0]).toMatchObject({ body: 'Wants delivery after 5pm', by: 'Test handler' });
    });

    it('exports CSV that spreadsheets open safely', async () => {
      const no = await placeOrder(SKU, 1, '=HYPERLINK("http://x")');
      const order = await db!.order.findUniqueOrThrow({ where: { orderNo: no } });
      const r = await call('GET', `/admin/orders/export.csv?q=${order.phone}`, { token: owner });
      expect(r.headers['content-type']).toMatch(/^text\/csv/);
      expect(r.headers['content-disposition']).toMatch(/attachment; filename="bunon-orders-\d{4}-\d{2}-\d{2}\.csv"/);
      const lines = String(r.body).replace(BOM, '').trim().split('\r\n');
      expect(lines[0]).toBe(
        '"Order","Placed","Name","Phone","District","Area","Items","Total","Status","Payment","Method","Source"',
      );
      expect(lines[1]).toContain(`"${no}"`);
      expect(lines[1]).toContain(`"'=HYPERLINK(""http://x"")"`);
    });
  });
});
