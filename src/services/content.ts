import type { z } from 'zod';
import type { AdminUser, Prisma } from '../generated/prisma/client.js';
import { audit } from '../lib/audit.js';
import { ApiError } from '../lib/errors.js';
import {
  CONTENT_DEFAULTS,
  type Content,
  type ContentKey,
  FAQ_TOKENS,
  fillFaqTokens,
  getContent,
  PAGE_DEFAULTS,
  PAGE_SLUGS,
} from '../lib/content.js';
import type { Db } from '../lib/prisma.js';
import { getSettings } from '../lib/settings.js';
import type { PageSlug, PublicContent, PublicPage } from '../schemas/content.js';
import { deleteImage } from './images.js';
import type { ImageStore } from './storage.js';

interface Context {
  admin: AdminUser;
  ip: string;
}
type Slug = z.infer<typeof PageSlug>;

/** What the storefront shows: content with FAQ placeholders filled in from the live settings. */
export async function publicContent(db: Db): Promise<z.infer<typeof PublicContent>> {
  const [content, settings, zones] = await Promise.all([
    getContent(db),
    getSettings(db),
    db.deliveryZone.findMany({ orderBy: [{ sort: 'asc' }, { key: 'asc' }] }),
  ]);
  const live = { hotline: settings.hotline, freeDeliveryThreshold: settings.free_delivery_threshold, zones };
  return {
    hero: content.hero,
    promos: content.promos,
    sections: content.homepage_sections,
    faq: content.faq.map((f) => ({ q: fillFaqTokens(f.q, live), a: fillFaqTokens(f.a, live) })),
  };
}

export async function adminContent(db: Db) {
  return { ...(await getContent(db)), faqTokens: [...FAQ_TOKENS] };
}

/**
 * Saves one content block. When promo tiles change, uploaded images no tile uses any more are
 * deleted from storage (other addresses, such as Pexels photos, are left alone).
 */
export async function saveContent<K extends ContentKey>(
  db: Db,
  images: ImageStore | null,
  key: K,
  value: Content[K],
  ctx: Context,
) {
  const before = (await getContent(db))[key];
  await db.$transaction(async (tx) => {
    await tx.contentBlock.upsert({
      where: { key },
      create: { key, value: value as Prisma.InputJsonValue, updatedById: ctx.admin.id },
      update: { value: value as Prisma.InputJsonValue, updatedById: ctx.admin.id },
    });
    await audit(tx, {
      adminId: ctx.admin.id,
      action: 'content.update',
      entityType: 'content',
      entityId: key,
      data: { before, after: value } as Prisma.InputJsonValue,
      ip: ctx.ip,
    });
  });
  if (key === 'promos') await dropUnusedImages(images, before as Content['promos'], value as Content['promos']);
  return adminContent(db);
}

/** Deletes uploaded promo images the new tiles no longer use (other addresses, e.g. Pexels, are left alone). */
async function dropUnusedImages(images: ImageStore | null, before: Content['promos'], after: Content['promos']) {
  if (!images) return;
  const kept = new Set(after.map((p) => p.imageUrl));
  const dropped = before.map((p) => p.imageUrl).filter((u) => !kept.has(u));
  await Promise.allSettled(dropped.map((u) => deleteImage(images, u)));
}

/** Puts a block back to its default by removing the saved value. */
export async function resetContent(db: Db, images: ImageStore | null, key: ContentKey, ctx: Context) {
  const before = (await getContent(db))[key];
  await db.$transaction(async (tx) => {
    await tx.contentBlock.deleteMany({ where: { key } });
    await audit(tx, {
      adminId: ctx.admin.id,
      action: 'content.reset',
      entityType: 'content',
      entityId: key,
      ip: ctx.ip,
    });
  });
  if (key === 'promos') await dropUnusedImages(images, before as Content['promos'], (await getContent(db)).promos);
  return adminContent(db);
}

const onlyHeadings = (body: string) =>
  body
    .split('\n')
    .map((l) => l.trim())
    .every((l) => l === '' || l.startsWith('#'));

export async function getPage(db: Db, slug: Slug): Promise<z.infer<typeof PublicPage>> {
  const row = await db.page.findUnique({ where: { slug } });
  const d = PAGE_DEFAULTS[slug];
  return {
    slug,
    title: row?.title ?? d.title,
    body: row?.body ?? d.body,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

export async function listPages(db: Db) {
  const rows = await db.page.findMany();
  return PAGE_SLUGS.map((slug) => {
    const row = rows.find((r) => r.slug === slug);
    const body = row?.body ?? PAGE_DEFAULTS[slug].body;
    return {
      slug,
      title: row?.title ?? PAGE_DEFAULTS[slug].title,
      updatedAt: row?.updatedAt.toISOString() ?? null,
      filledIn: !onlyHeadings(body),
    };
  });
}

export async function savePage(db: Db, slug: Slug, input: { title: string; body: string }, ctx: Context) {
  const body = input.body.replace(/\r\n/g, '\n').trimEnd();
  await db.$transaction(async (tx) => {
    await tx.page.upsert({
      where: { slug },
      create: { slug, title: input.title, body, updatedById: ctx.admin.id },
      update: { title: input.title, body, updatedById: ctx.admin.id },
    });
    await audit(tx, {
      adminId: ctx.admin.id,
      action: 'page.update',
      entityType: 'page',
      entityId: slug,
      data: { title: input.title, length: body.length },
      ip: ctx.ip,
    });
  });
  return getPage(db, slug);
}

export { CONTENT_DEFAULTS };

// ---------- Products in homepage sections ----------

type ProductSection = 'bestsellers' | 'new-arrivals';
const SECTION_TITLES: Record<ProductSection, string> = { bestsellers: 'Best Sellers', 'new-arrivals': 'New Arrivals' };

export async function listSectionProducts(db: Db) {
  const items = await db.homepageSectionItem.findMany({
    where: { sectionKey: { in: ['bestsellers', 'new-arrivals'] } },
    orderBy: { sort: 'asc' },
    include: {
      product: {
        select: {
          id: true,
          nameEn: true,
          slug: true,
          status: true,
          images: { orderBy: { sort: 'asc' }, take: 1, select: { url: true } },
        },
      },
    },
  });
  const pick = (key: ProductSection) =>
    items
      .filter((i) => i.sectionKey === key)
      .map(({ product: p }) => ({
        id: p.id,
        name: p.nameEn,
        slug: p.slug,
        image: p.images[0]?.url ?? null,
        status: p.status,
      }));
  return { bestsellers: pick('bestsellers'), 'new-arrivals': pick('new-arrivals') };
}

/** Replaces the products in a homepage section, in the order given. */
export async function setSectionProducts(db: Db, key: ProductSection, productIds: number[], ctx: Context) {
  const found = await db.product.findMany({ where: { id: { in: productIds } }, select: { id: true, nameEn: true } });
  if (found.length !== productIds.length)
    throw new ApiError(400, 'UNKNOWN_PRODUCT', 'Some of those products no longer exist. Reload and try again.');
  await db.$transaction(async (tx) => {
    await tx.homepageSection.upsert({ where: { key }, create: { key, title: SECTION_TITLES[key] }, update: {} });
    await tx.homepageSectionItem.deleteMany({ where: { sectionKey: key } });
    await tx.homepageSectionItem.createMany({
      data: productIds.map((productId, sort) => ({ sectionKey: key, productId, sort })),
    });
    await audit(tx, {
      adminId: ctx.admin.id,
      action: 'content.section_products',
      entityType: 'content',
      entityId: key,
      data: { products: productIds.map((id) => found.find((p) => p.id === id)!.nameEn) },
      ip: ctx.ip,
    });
  });
  return listSectionProducts(db);
}
