// Admin categories, products, variants, images and inventory against a real database, with an
// in-memory image store. TEST_DATABASE_URL=... npm run test:integration
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createPrisma } from '../../src/lib/prisma.js';
import { memoryStore } from '../../src/services/storage.js';
import { TEST_KEY, multipart, signedInAdmin } from './helpers.js';

const url = process.env.TEST_DATABASE_URL;
const db = url ? createPrisma(url) : null;
type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
const store = memoryStore();
const tag = randomBytes(3).toString('hex');
let manager: string;
let editor: string;
let handler: string;

async function call(method: string, path: string, token: string | undefined, body?: unknown) {
  const res = await app.inject({
    method: method as 'GET',
    url: `/api/v1${path}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body !== undefined && { payload: body as object }),
  });
  return { status: res.statusCode, body: res.json() };
}
async function uploadTo(
  path: string,
  token: string,
  file: Buffer,
  type = 'image/png',
  fields: Record<string, string> = {},
) {
  const { payload, headers } = multipart(file, 'photo.png', type, fields);
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1${path}`,
    payload,
    headers: { ...headers, authorization: `Bearer ${token}` },
  });
  return { status: res.statusCode, body: res.json() };
}
const png = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 120, g: 40, b: 50 } } })
    .png()
    .toBuffer();

describe.skipIf(!url)('admin catalogue API (database)', () => {
  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: url!,
      LOG_LEVEL: 'silent',
      RATE_LIMIT: 'off',
      ADMIN_ENCRYPTION_KEY: TEST_KEY,
    });
    app = await buildApp(config, db!, store);
    manager = await signedInAdmin(app, db!, `manager-${tag}@test.bunon`, 'manager');
    editor = await signedInAdmin(app, db!, `editor-${tag}@test.bunon`, 'content_editor');
    handler = await signedInAdmin(app, db!, `handler-${tag}@test.bunon`, 'order_handler');
  });

  afterAll(async () => {
    const products = await db!.product.findMany({ where: { slug: { contains: tag } }, select: { id: true } });
    const ids = products.map((p) => p.id);
    await db!.inventoryMovement.deleteMany({ where: { variant: { productId: { in: ids } } } });
    await db!.product.deleteMany({ where: { id: { in: ids } } });
    await db!.category.deleteMany({ where: { slug: { contains: tag } } });
    const admins = await db!.adminUser.findMany({
      where: { email: { endsWith: `-${tag}@test.bunon` } },
      select: { id: true },
    });
    await db!.auditLog.deleteMany({ where: { adminId: { in: admins.map((a) => a.id) } } });
    await db!.adminUser.deleteMany({ where: { id: { in: admins.map((a) => a.id) } } });
    await app.close();
  });

  it('checks permissions per role', async () => {
    expect((await call('GET', '/admin/products', handler)).status).toBe(200); // products:read
    expect((await call('POST', '/admin/categories', handler, { name: 'Nope' })).status).toBe(403);
    expect(
      (await call('POST', '/admin/inventory/adjust', editor, { sku: 'BN-R1-1', change: 1, reason: 'test' })).status,
    ).toBe(403);
  });

  let categoryId: number;
  it('creates, renames, orders, hides and deletes categories', async () => {
    const created = await call('POST', '/admin/categories', editor, { name: `Wall Art ${tag}` });
    expect(created.status).toBe(200);
    const cat = created.body.find((c: { slug: string }) => c.slug === `wall-art-${tag}`);
    expect(cat).toMatchObject({ name: `Wall Art ${tag}`, active: true, productCount: 0 });
    categoryId = cat.id;
    expect(
      (await call('POST', '/admin/categories', editor, { name: 'Another', slug: `wall-art-${tag}` })).body.code,
    ).toBe('SLUG_TAKEN');

    const ids = created.body.map((c: { id: number }) => c.id);
    const reordered = await call('PUT', '/admin/categories/order', editor, {
      ids: [categoryId, ...ids.filter((i: number) => i !== categoryId)],
    });
    expect(reordered.body[0].id).toBe(categoryId);
    await call('PUT', '/admin/categories/order', editor, { ids }); // put it back

    await call('PATCH', `/admin/categories/${categoryId}`, editor, { active: false });
    const publicList = (await call('GET', '/categories', undefined)).body.map((c: { slug: string }) => c.slug);
    expect(publicList).not.toContain(`wall-art-${tag}`);
    await call('PATCH', `/admin/categories/${categoryId}`, editor, { active: true, nameBn: 'দেয়ালের সাজ' });

    const temp = await call('POST', '/admin/categories', editor, { name: `Temp ${tag}` });
    const tempId = temp.body.find((c: { slug: string }) => c.slug === `temp-${tag}`).id;
    expect((await call('DELETE', `/admin/categories/${tempId}`, editor)).status).toBe(200);
  });

  it('uploads a category image at three sizes', async () => {
    const r = await uploadTo(`/admin/categories/${categoryId}/image`, editor, await png(900, 600));
    expect(r.status).toBe(200);
    const cat = r.body.find((c: { id: number }) => c.id === categoryId);
    expect(cat.imageUrl).toMatch(new RegExp(`^https://storage.test/categories/${categoryId}/[0-9a-f-]+-1200\\.webp$`));
    const base = cat.imageUrl.replace('https://storage.test/', '').replace(/-1200\.webp$/, '');
    for (const w of [400, 800, 1200]) {
      const meta = await sharp(store.files.get(`${base}-${w}.webp`)!).metadata();
      expect(meta.format).toBe('webp');
      expect(meta.width).toBe(Math.min(w, 900)); // never enlarged
    }
  });

  let productId: number;
  let slug: string;
  it('creates a draft, adds variants and publishes it on the storefront', async () => {
    const created = await call('POST', '/admin/products', editor, {
      nameEn: `Brass Wall Plate ${tag}`,
      categoryId,
      descriptionEn: 'Hand-beaten brass.',
    });
    expect(created.body).toMatchObject({ status: 'draft', slug: `brass-wall-plate-${tag}`, variants: [] });
    productId = created.body.id;
    slug = created.body.slug;

    const early = await call('PATCH', `/admin/products/${productId}`, editor, { status: 'active' });
    expect([early.status, early.body.code]).toEqual([409, 'NO_VARIANTS']);

    const bad = await call('POST', `/admin/products/${productId}/variants`, editor, {
      label: 'Small',
      price: 900,
      compareAtPrice: 800,
    });
    expect(bad.body.code).toBe('BAD_COMPARE_PRICE');
    const small = await call('POST', `/admin/products/${productId}/variants`, editor, {
      label: 'Small',
      price: 900,
      compareAtPrice: 1100,
      openingStock: 10,
    });
    expect(small.body.variants[0]).toMatchObject({ sku: `BN-P${productId}-1`, stock: 10, price: 900 });
    const large = await call('POST', `/admin/products/${productId}/variants`, editor, {
      label: 'Large',
      price: 1500,
      sku: `BN-${tag.toUpperCase()}-L`,
    });
    expect(large.body).toMatchObject({ priceFrom: 900 });
    const dupSku = await call('POST', `/admin/products/${productId}/variants`, editor, {
      label: 'X',
      price: 1,
      sku: `BN-${tag.toUpperCase()}-L`,
    });
    expect(dupSku.body.code).toBe('SKU_TAKEN');
    expect(await db!.inventoryMovement.count({ where: { variant: { productId }, reason: 'opening stock' } })).toBe(1);

    expect((await call('GET', `/products/${slug}`, undefined)).status).toBe(404); // still a draft
    await call('PATCH', `/admin/products/${productId}`, editor, { status: 'active' });
    const live = await call('GET', `/products/${slug}`, undefined);
    expect(live.body).toMatchObject({
      name: `Brass Wall Plate ${tag}`,
      price: 900,
      category: { slug: `wall-art-${tag}` },
    });
    expect(live.body.variants.map((v: { label: string }) => v.label)).toEqual(['Small', 'Large']);

    const smallId = small.body.variants[0].id;
    const cheaper = await call('PATCH', `/admin/products/${productId}/variants/${smallId}`, editor, { price: 850 });
    expect(cheaper.body.priceFrom).toBe(850);
    expect(
      await db!.auditLog.count({ where: { entityType: 'product', entityId: String(productId) } }),
    ).toBeGreaterThanOrEqual(5);
  });

  it('checks uploads and manages photos', async () => {
    const notImage = await uploadTo(`/admin/products/${productId}/images`, editor, Buffer.from('hello'), 'image/png');
    expect([notImage.status, notImage.body.code]).toEqual([400, 'NOT_AN_IMAGE']);
    const tiny = await uploadTo(`/admin/products/${productId}/images`, editor, await png(100, 100));
    expect(tiny.body.code).toBe('IMAGE_TOO_SMALL');

    const first = await uploadTo(`/admin/products/${productId}/images`, editor, await png(1600, 1200), 'image/png', {
      alt: 'Front',
    });
    const second = await uploadTo(`/admin/products/${productId}/images`, editor, await png(800, 800));
    expect(second.body.images).toHaveLength(2);
    expect(first.body.images[0]).toMatchObject({ alt: 'Front' });
    const [a, b] = second.body.images.map((i: { id: number }) => i.id);
    const reordered = await call('PUT', `/admin/products/${productId}/images/order`, editor, { ids: [b, a] });
    expect(reordered.body.images.map((i: { id: number }) => i.id)).toEqual([b, a]);
    const alt = await call('PATCH', `/admin/products/${productId}/images/${b}`, editor, { alt: 'Side' });
    expect(alt.body.images[0].alt).toBe('Side');
    expect((await call('GET', `/products/${slug}`, undefined)).body.image.alt).toBe('Side');
  });

  it('duplicates as a draft that shares photos safely', async () => {
    const copy = (await call('POST', `/admin/products/${productId}/duplicate`, editor)).body;
    expect(copy).toMatchObject({ status: 'draft', nameEn: `Brass Wall Plate ${tag} (copy)` });
    expect(copy.variants.every((v: { stock: number }) => v.stock === 0)).toBe(true);
    expect(copy.images).toHaveLength(2);
    const shared = copy.images[0].url as string;
    const path = shared.replace('https://storage.test/', '');
    // Removing the copy's photo keeps the files, because the original still uses them.
    await call('DELETE', `/admin/products/${copy.id}/images/${copy.images[0].id}`, editor);
    expect(store.files.has(path)).toBe(true);
    const original = (await call('GET', `/admin/products/${productId}`, editor)).body;
    const same = original.images.find((i: { url: string }) => i.url === shared);
    await call('DELETE', `/admin/products/${productId}/images/${same.id}`, editor);
    expect(store.files.has(path)).toBe(false); // last user gone: all sizes deleted
    expect(store.files.has(path.replace('-1200.webp', '-400.webp'))).toBe(false);
  });

  it('adjusts stock with a reason, records a stocktake and keeps history', async () => {
    const sku = `BN-P${productId}-1`;
    expect(
      (await call('POST', '/admin/inventory/adjust', manager, { sku, change: 5, reason: 'New batch from Jashore' }))
        .body,
    ).toEqual({ sku, stock: 15 });
    expect(
      (await call('POST', '/admin/inventory/adjust', manager, { sku, change: -3, reason: 'Damaged in storage' })).body
        .stock,
    ).toBe(12);
    const tooMany = await call('POST', '/admin/inventory/adjust', manager, { sku, change: -50, reason: 'Oops' });
    expect([tooMany.status, tooMany.body.code]).toEqual([409, 'NOT_ENOUGH_STOCK']);
    expect(
      (await call('POST', '/admin/inventory/adjust', manager, { sku, count: 4, reason: 'Stocktake' })).body.stock,
    ).toBe(4);
    expect(
      (await call('POST', '/admin/inventory/adjust', manager, { sku, change: 1, count: 2, reason: 'Both' })).status,
    ).toBe(400);

    const low = await call('GET', `/admin/inventory?low=true&q=${sku}`, manager);
    expect(low.body.items).toContainEqual(expect.objectContaining({ sku, stock: 4, low: true }));
    const history = await call('GET', `/admin/inventory/movements?sku=${sku}`, manager);
    expect(history.body.items.map((m: { change: number }) => m.change)).toEqual([-8, -3, 5, 10]);
    expect(history.body.items[0]).toMatchObject({ reason: 'Stocktake', by: 'Test manager' });
  });

  it('archiving takes a product off the storefront', async () => {
    await call('PATCH', `/admin/products/${productId}`, editor, { status: 'archived' });
    expect((await call('GET', `/products/${slug}`, undefined)).status).toBe(404);
    const list = await call('GET', `/admin/products?status=archived&q=${tag}`, editor);
    expect(list.body.items.map((p: { id: number }) => p.id)).toContain(productId);
    const del = await call('DELETE', `/admin/categories/${categoryId}`, editor);
    expect(del.body.code).toBe('CATEGORY_NOT_EMPTY');
  });
});
