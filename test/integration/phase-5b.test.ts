// Part 5b against a real database: the CMS (sale banner, promo tiles, homepage sections, FAQ)
// and the legal/information pages. TEST_DATABASE_URL=... npm run test:integration
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
let owner: string;
let editor: string;
let handler: string;
// Whatever the local database already had, put back afterwards.
let savedBlocks: { key: string; value: unknown }[] = [];
let savedPages: { slug: string; title: string; body: string }[] = [];
let savedItems: { sectionKey: string; productId: number; sort: number }[] = [];

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await app.inject({
    method: method as 'GET',
    url: `/api/v1${path}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body !== undefined && { payload: body as object }),
  });
  return { status: res.statusCode, body: res.statusCode === 204 ? null : res.json() };
}

const hero = (over: Record<string, unknown> = {}) => ({
  eyebrow: 'Winter Sale',
  title: 'Warm *nakshi kantha* throws',
  text: 'Hand-stitched throws for cold evenings.',
  primary: { label: 'Shop throws', href: '/shop?cat=bed-throws' },
  secondary: null,
  countdownEnds: null,
  ...over,
});

describe.skipIf(!url)('part 5b: CMS (database)', () => {
  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: url!,
      LOG_LEVEL: 'silent',
      RATE_LIMIT: 'off',
      ADMIN_ENCRYPTION_KEY: TEST_KEY,
    });
    app = await buildApp(config, db!, store);
    owner = await signedInAdmin(app, db!, `owner5b-${tag}@test.bunon`, 'owner');
    editor = await signedInAdmin(app, db!, `editor5b-${tag}@test.bunon`, 'content_editor');
    handler = await signedInAdmin(app, db!, `handler5b-${tag}@test.bunon`, 'order_handler');
    savedBlocks = await db!.contentBlock.findMany();
    savedPages = await db!.page.findMany();
    savedItems = await db!.homepageSectionItem.findMany();
    await db!.contentBlock.deleteMany();
    await db!.page.deleteMany();
  });

  afterAll(async () => {
    await db!.contentBlock.deleteMany();
    await db!.page.deleteMany();
    for (const b of savedBlocks) await db!.contentBlock.create({ data: { key: b.key, value: b.value as never } });
    for (const p of savedPages) await db!.page.create({ data: { slug: p.slug, title: p.title, body: p.body } });
    await db!.homepageSectionItem.deleteMany();
    await db!.homepageSectionItem.createMany({ data: savedItems });
    const admins = await db!.adminUser.findMany({ where: { email: { contains: tag } } });
    await db!.auditLog.deleteMany({ where: { adminId: { in: admins.map((a) => a.id) } } });
    await db!.adminUser.deleteMany({ where: { id: { in: admins.map((a) => a.id) } } });
    await app.close();
  });

  it('serves the built-in content until staff change it, with FAQ placeholders filled in', async () => {
    const c = (await call('GET', '/content')).body;
    expect(c.hero.title).toBe('Up to *25% off* handcrafted runners, kantha & jute');
    expect(c.promos).toHaveLength(2);
    expect(c.sections.map((s: { key: string }) => s.key)).toEqual([
      'hero',
      'trust',
      'categories',
      'bestsellers',
      'promos',
      'new-arrivals',
      'budget',
      'story',
      'reviews',
      'faq',
      'newsletter',
    ]);
    const fees = c.faq.find((f: { q: string }) => f.q === 'What are the delivery charges?').a;
    expect(fees).toMatch(/^৳\d+ inside Dhaka and ৳\d+ outside Dhaka\. Delivery is free on orders above ৳[\d,]+\.$/);
    expect(JSON.stringify(c.faq)).not.toMatch(/{[a-z_]+}/);
    const page = (await call('GET', '/pages/privacy')).body;
    expect(page).toMatchObject({ slug: 'privacy', title: 'Privacy Policy', updatedAt: null });
    expect(page.body).toContain('## Information we collect');
    expect((await call('GET', '/pages/secret')).status).toBe(400);
  });

  it('lets owners, managers and content editors edit content, nobody else', async () => {
    expect((await call('GET', '/admin/content', handler)).status).toBe(403);
    const c = await call('GET', '/admin/content', editor);
    expect(c.status).toBe(200);
    expect(c.body.faqTokens).toEqual(['{hotline}', '{free_delivery}', '{delivery_fees}']);
    expect(c.body.updatedAt.hero).toBeNull();
  });

  it('saves the sale banner, refusing unsafe links', async () => {
    expect(
      (await call('PUT', '/admin/content/hero', editor, hero({ primary: { label: 'x', href: 'javascript:alert(1)' } })))
        .status,
    ).toBe(400);
    expect(
      (await call('PUT', '/admin/content/hero', editor, hero({ primary: { label: 'x', href: '//evil.example' } })))
        .status,
    ).toBe(400);
    const saved = await call(
      'PUT',
      '/admin/content/hero',
      editor,
      hero({ countdownEnds: '2026-12-31T23:59:00+06:00' }),
    );
    expect(saved.status).toBe(200);
    expect(saved.body.updatedAt.hero).not.toBeNull();
    expect((await call('GET', '/content')).body.hero).toMatchObject({
      title: 'Warm *nakshi kantha* throws',
      secondary: null,
      countdownEnds: '2026-12-31T23:59:00+06:00',
    });
    // Back to the default.
    await call('DELETE', '/admin/content/hero', editor);
    expect((await call('GET', '/content')).body.hero.eyebrow).toBe('Festive Sale · Limited Time');
  });

  it('reorders and hides homepage sections, listing each exactly once', async () => {
    const current = (await call('GET', '/admin/content', owner)).body.homepage_sections as {
      key: string;
      visible: boolean;
    }[];
    const faqFirst = [current.find((s) => s.key === 'faq')!, ...current.filter((s) => s.key !== 'faq')].map((s) =>
      s.key === 'story' ? { ...s, visible: false } : s,
    );
    expect((await call('PUT', '/admin/content/sections', owner, { sections: faqFirst.slice(1) })).status).toBe(400);
    expect(
      (await call('PUT', '/admin/content/sections', owner, { sections: [...faqFirst.slice(1), faqFirst[1]] })).status,
    ).toBe(400);
    expect((await call('PUT', '/admin/content/sections', owner, { sections: faqFirst })).status).toBe(200);
    const pub = (await call('GET', '/content')).body.sections;
    expect(pub[0].key).toBe('faq');
    expect(pub.find((s: { key: string }) => s.key === 'story').visible).toBe(false);
  });

  it('saves the FAQ with placeholders', async () => {
    const faq = [{ q: 'Can I call you?', a: 'Yes, call {hotline} any day.' }];
    expect((await call('PUT', '/admin/content/faq', editor, { faq })).status).toBe(200);
    const hotline = (await call('GET', '/settings')).body.hotline;
    expect((await call('GET', '/content')).body.faq).toEqual([
      { q: 'Can I call you?', a: `Yes, call ${hotline} any day.` },
    ]);
  });

  it('saves promo tiles with uploaded images, and deletes images no tile uses any more', async () => {
    const png = await sharp({ create: { width: 800, height: 500, channels: 3, background: '#6b1e2e' } })
      .png()
      .toBuffer();
    const { payload, headers } = multipart(png, 'promo.png', 'image/png');
    const up = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/content/images',
      headers: { ...headers, authorization: `Bearer ${editor}` },
      payload,
    });
    expect(up.statusCode).toBe(201);
    const imageUrl = up.json().url as string;
    expect(imageUrl).toMatch(/^https:\/\/storage\.test\/content\/.+-1200\.webp$/);
    const tile = {
      tag: 'New',
      tagStyle: 'gold',
      title: 'Winter throws',
      text: 'Warm and hand-stitched.',
      buttonLabel: 'Shop now',
      href: '/shop?cat=bed-throws',
      imageUrl,
    };
    expect(
      (await call('PUT', '/admin/content/promos', editor, { promos: [{ ...tile, href: 'javascript:x' }] })).status,
    ).toBe(400);
    expect((await call('PUT', '/admin/content/promos', editor, { promos: [tile] })).status).toBe(200);
    expect((await call('GET', '/content')).body.promos).toEqual([tile]);
    const files = store.files.size;
    await call('PUT', '/admin/content/promos', editor, { promos: [] });
    expect(store.files.size).toBe(files - 3); // all three sizes of the replaced image
    // "Use the original" also deletes an uploaded image the default tiles don't use.
    await call('PUT', '/admin/content/promos', editor, { promos: [tile] });
    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/content/images',
      headers: { ...headers, authorization: `Bearer ${editor}` },
      payload,
    });
    await call('PUT', '/admin/content/promos', editor, { promos: [{ ...tile, imageUrl: again.json().url }] });
    const withUpload = store.files.size;
    await call('DELETE', '/admin/content/promos', editor);
    expect(store.files.size).toBe(withUpload - 3);
  });

  it('picks and orders the products in Best sellers', async () => {
    const current = (await call('GET', '/admin/content/section-products', editor)).body;
    expect(current.bestsellers.length).toBeGreaterThan(1);
    const ids = current.bestsellers.map((p: { id: number }) => p.id).reverse();
    expect(
      (await call('PUT', '/admin/content/section-products/bestsellers', editor, { productIds: [...ids, 999999] })).body
        .code,
    ).toBe('UNKNOWN_PRODUCT');
    expect(
      (await call('PUT', '/admin/content/section-products/bestsellers', editor, { productIds: [ids[0], ids[0]] }))
        .status,
    ).toBe(400);
    const saved = await call('PUT', '/admin/content/section-products/bestsellers', editor, { productIds: ids });
    expect(saved.body.bestsellers.map((p: { id: number }) => p.id)).toEqual(ids);
    const slugs = current.bestsellers.map((p: { slug: string }) => p.slug).reverse();
    const store = (await call('GET', '/products?section=bestsellers')).body.items.map((p: { slug: string }) => p.slug);
    expect(store).toEqual(slugs);
  });

  it('fills New arrivals and Best sellers automatically when nothing is picked', async () => {
    await call('PUT', '/admin/content/section-products/new-arrivals', editor, { productIds: [] });
    await call('PUT', '/admin/content/section-products/bestsellers', editor, { productIds: [] });
    const newest = (await call('GET', '/products?sort=newest&limit=8')).body.items.map((p: { slug: string }) => p.slug);
    const arrivals = (await call('GET', '/products?section=new-arrivals')).body;
    expect(arrivals.items.map((p: { slug: string }) => p.slug)).toEqual(newest);
    // Few or no sales in the test data: topped up in featured order, not a copy of New arrivals.
    const featured = (await call('GET', '/products?sort=featured&limit=100')).body.items.map(
      (p: { slug: string }) => p.slug,
    );
    const best = (await call('GET', '/products?section=bestsellers')).body.items.map((p: { slug: string }) => p.slug);
    expect(best).toHaveLength(Math.min(8, featured.length));
    expect(best.every((slug: string) => featured.includes(slug))).toBe(true);
  });

  it('saves pages and reports which ones are still headings only', async () => {
    const before = (await call('GET', '/admin/pages', editor)).body;
    expect(before.every((p: { filledIn: boolean }) => !p.filledIn)).toBe(true);
    const body = '## Our story\n\nBunon started in **2024** in Dhaka.\n\n- Handmade\n- Fair wages';
    const saved = await call('PUT', '/admin/pages/about', editor, { title: 'About us', body });
    expect(saved.body).toMatchObject({ slug: 'about', title: 'About us', body });
    const pub = (await call('GET', '/pages/about')).body;
    expect(pub.updatedAt).not.toBeNull();
    const list = (await call('GET', '/admin/pages', editor)).body;
    expect(list.find((p: { slug: string }) => p.slug === 'about').filledIn).toBe(true);
    const mine = await db!.adminUser.findMany({ where: { email: { contains: tag } }, select: { id: true } });
    const log = await db!.auditLog.findMany({
      where: { entityType: { in: ['content', 'page'] }, adminId: { in: mine.map((m) => m.id) } },
      orderBy: { id: 'asc' },
    });
    expect(log.map((l) => `${l.action}:${l.entityId}`)).toEqual([
      'content.update:hero',
      'content.reset:hero',
      'content.update:homepage_sections',
      'content.update:faq',
      'content.update:promos',
      'content.update:promos',
      'content.update:promos',
      'content.update:promos',
      'content.reset:promos',
      'content.section_products:bestsellers',
      'content.section_products:new-arrivals',
      'content.section_products:bestsellers',
      'page.update:about',
    ]);
  });
});
