// Needs a migrated + seeded database: TEST_DATABASE_URL=... npm run test:integration
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createPrisma } from '../../src/lib/prisma.js';

const url = process.env.TEST_DATABASE_URL;
const db = url ? createPrisma(url) : null;
const DRAFT_SLUG = 'integration-test-draft-product';

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
const get = async (path: string) => {
  const res = await app.inject({ method: 'GET', url: `/api/v1${path}` });
  return { status: res.statusCode, body: res.json(), headers: res.headers };
};
const ids = (items: { legacyId: string | null }[]) => items.map((i) => i.legacyId);

describe.skipIf(!url)('catalogue API (database)', () => {
  beforeAll(async () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: url!, LOG_LEVEL: 'silent' });
    app = await buildApp(config, db!);
    // A draft product must never be visible.
    const category = await db!.category.findUniqueOrThrow({ where: { slug: 'table-runners' } });
    await db!.product.deleteMany({ where: { slug: DRAFT_SLUG } });
    await db!.product.create({
      data: {
        slug: DRAFT_SLUG,
        nameEn: 'Jute Draft Runner',
        categoryId: category.id,
        status: 'draft',
        priceFrom: 100,
        variants: { create: { sku: 'TEST-DRAFT-1', label: 'One', price: 100, stock: 5 } },
      },
    });
  });

  afterAll(async () => {
    await db!.product.deleteMany({ where: { slug: DRAFT_SLUG } });
    await app.close(); // also disconnects db
  });

  it('lists categories in order with active product counts', async () => {
    const { status, body, headers } = await get('/categories');
    expect(status).toBe(200);
    expect(headers['cache-control']).toBe('public, max-age=60');
    expect(body.map((c: { slug: string }) => c.slug)).toEqual([
      'table-runners',
      'cushion-covers',
      'table-mats-and-napkins',
      'bed-and-throws',
      'jute-decor',
    ]);
    expect(body[0]).toMatchObject({ name: 'Table Runners', productCount: 4 }); // the draft isn't counted
  });

  it('lists every active product in featured order', async () => {
    const { body } = await get('/products?limit=100');
    expect(body.total).toBe(13);
    expect(ids(body.items)).toEqual(['r1', 'r2', 'r3', 'r4', 'c1', 'c2', 'c3', 'm1', 'm2', 'b1', 'b2', 'j1', 'j2']);
    expect(body.items[0]).toMatchObject({
      slug: 'nakshi-kantha-table-runner',
      price: 1850,
      compareAtPrice: 2200,
      tag: 'Best Seller',
      inStock: true,
      firstVariant: { sku: 'BN-R1-1', label: '13 × 72"', price: 1850, stockStatus: 'in_stock' },
      category: { slug: 'table-runners', name: 'Table Runners' },
    });
  });

  it('filters by category and sorts by price', async () => {
    expect(ids((await get('/products?category=table-runners&sort=price_asc')).body.items)).toEqual([
      'r3',
      'r4',
      'r1',
      'r2',
    ]);
    expect(ids((await get('/products?category=table-runners&sort=price_desc')).body.items)).toEqual([
      'r2',
      'r1',
      'r4',
      'r3',
    ]);
    expect((await get('/products?category=no-such-category')).body.total).toBe(0);
  });

  it('searches product and category names, case-insensitively, like the old storefront', async () => {
    expect(ids((await get('/products?q=JUTE')).body.items)).toEqual(['r3', 'c3', 'm1', 'j1', 'j2']);
    expect((await get('/products?q=zzz')).body.total).toBe(0);
  });

  it('filters below a maximum price', async () => {
    const { body } = await get('/products?maxPrice=1000&sort=price_asc');
    expect(ids(body.items)).toEqual(['c3', 'c2', 'c1', 'm2', 'r3']);
    expect(body.items.every((p: { price: number }) => p.price < 1000)).toBe(true);
  });

  it('keeps the hand-picked order of homepage sections', async () => {
    expect(ids((await get('/products?section=bestsellers')).body.items)).toEqual(['r1', 'c1', 'm1', 'r2']);
    expect(ids((await get('/products?section=new-arrivals')).body.items)).toEqual(['r2', 'b2', 'j1', 'c2']);
  });

  it('paginates', async () => {
    const page2 = (await get('/products?limit=5&page=2')).body;
    expect(page2).toMatchObject({ total: 13, page: 2, limit: 5 });
    expect(ids(page2.items)).toEqual(['c2', 'c3', 'm1', 'm2', 'b1']);
  });

  it('finds a product by its old storefront id', async () => {
    expect((await get('/products?legacyId=b2')).body.items[0].slug).toBe('handloom-bedcover');
  });

  it('returns one product with variants, prices and stock status', async () => {
    const { status, body } = await get('/products/nakshi-kantha-table-runner');
    expect(status).toBe(200);
    expect(body.variants.map((v: { sku: string; label: string; price: number }) => [v.sku, v.label, v.price])).toEqual([
      ['BN-R1-1', '13 × 72"', 1850],
      ['BN-R1-2', '13 × 90"', 2220],
      ['BN-R1-3', '13 × 108"', 2590],
    ]);
    expect(body.variants[0]).toMatchObject({ compareAtPrice: 2200, stockStatus: 'in_stock' });
    expect(body.variants[0].stockLeft).toBeUndefined();
    expect(body.images).toHaveLength(1);
  });

  it('hides draft products and unknown slugs', async () => {
    expect((await get(`/products/${DRAFT_SLUG}`)).status).toBe(404);
    expect((await get('/products/does-not-exist')).status).toBe(404);
    expect(ids((await get('/products?q=draft')).body.items)).toEqual([]);
  });

  it('looks up cart variants, skipping unknown and hidden SKUs', async () => {
    const { body, headers } = await get('/variants?skus=BN-C1-2,NOPE-1,TEST-DRAFT-1,BN-C1-2');
    expect(headers['cache-control']).toBe('no-store');
    expect(body).toEqual([
      {
        sku: 'BN-C1-2',
        label: '18 × 18"',
        price: 1020,
        stockStatus: 'in_stock',
        product: {
          slug: 'nakshi-kantha-cushion-cover',
          name: 'Nakshi Kantha Cushion Cover',
          image: expect.any(Object),
        },
      },
    ]);
  });
});
