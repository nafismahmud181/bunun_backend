import type { z } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';
import type { Db } from '../lib/prisma.js';
import { WEIGHT_FIELD } from '../schemas/admin-catalogue.js';
import { categoryFields } from '../lib/variant-fields.js';
import {
  LOW_STOCK,
  type CartVariant,
  type Category,
  type ProductDetail,
  type ProductList,
  type ProductListQuery,
  type ProductSummary,
  type Variant,
} from '../schemas/catalogue.js';

// Only active products in active categories are ever visible to shoppers.
const visible = { status: 'active', category: { active: true } } satisfies Prisma.ProductWhereInput;

const summaryInclude = {
  category: { select: { slug: true, nameEn: true } },
  images: { orderBy: { sort: 'asc' }, take: 1, select: { url: true, alt: true } },
  variants: {
    orderBy: { sort: 'asc' },
    select: { sku: true, label: true, price: true, compareAtPrice: true, stock: true },
  },
} satisfies Prisma.ProductInclude;

type SummaryRow = Prisma.ProductGetPayload<{ include: typeof summaryInclude }>;

function toSummary(p: SummaryRow): z.infer<typeof ProductSummary> {
  const first = p.variants[0];
  return {
    slug: p.slug,
    legacyId: p.legacyId,
    name: p.nameEn,
    category: { slug: p.category.slug, name: p.category.nameEn },
    tag: p.tag,
    price: p.priceFrom,
    compareAtPrice: first?.compareAtPrice ?? null,
    image: p.images[0] ?? null,
    inStock: p.variants.some((v) => v.stock > 0),
    rating:
      p.ratingCount > 0 && p.ratingAvg !== null
        ? { average: Math.round(p.ratingAvg * 10) / 10, count: p.ratingCount }
        : null,
    firstVariant: first
      ? { sku: first.sku, label: first.label, price: first.price, stockStatus: stockInfo(first.stock).stockStatus }
      : null,
  };
}

export function stockInfo(stock: number): Pick<z.infer<typeof Variant>, 'stockStatus' | 'stockLeft'> {
  if (stock <= 0) return { stockStatus: 'out' };
  if (stock <= LOW_STOCK) return { stockStatus: 'low', stockLeft: stock };
  return { stockStatus: 'in_stock' };
}

const orderBy: Record<ProductListQuery['sort'], Prisma.ProductOrderByWithRelationInput[]> = {
  featured: [{ id: 'asc' }],
  price_asc: [{ priceFrom: 'asc' }, { id: 'asc' }],
  price_desc: [{ priceFrom: 'desc' }, { id: 'asc' }],
  newest: [{ createdAt: 'desc' }, { id: 'desc' }],
};

export async function listCategories(db: Db): Promise<z.infer<typeof Category>[]> {
  const rows = await db.category.findMany({
    where: { active: true },
    orderBy: [{ sort: 'asc' }, { id: 'asc' }],
    include: { _count: { select: { products: { where: { status: 'active' } } } } },
  });
  return rows.map((c) => ({ slug: c.slug, name: c.nameEn, imageUrl: c.imageUrl, productCount: c._count.products }));
}

/** Sections that fill themselves when staff haven't picked any products for them. */
type AutoSection = 'bestsellers' | 'new-arrivals';
const AUTO_SECTIONS = new Set<string>(['bestsellers', 'new-arrivals']);
const AUTO_SIZE = 8;

/**
 * New arrivals: the newest products. Best sellers: the products with the most units sold in the
 * last 90 days (cancelled, returned and refunded orders don't count), topped up in the store's
 * featured order while there aren't enough sales yet, so it doesn't repeat New arrivals.
 */
async function autoSection(db: Db, section: AutoSection, where: Prisma.ProductWhereInput, take: number) {
  const pick = (order: Prisma.ProductOrderByWithRelationInput[], exclude: number[], n: number) =>
    db.product.findMany({
      where: { ...where, ...(exclude.length && { id: { notIn: exclude } }) },
      orderBy: order,
      take: n,
      include: summaryInclude,
    });
  if (section === 'new-arrivals') return pick([{ createdAt: 'desc' }, { id: 'desc' }], [], take);

  const sold = await db.$queryRaw<{ product_id: number }[]>`
    SELECT v."product_id"
    FROM "order_items" i
    JOIN "product_variants" v ON v."id" = i."variant_id"
    JOIN "orders" o ON o."id" = i."order_id"
    WHERE o."status" NOT IN ('cancelled', 'returned', 'refunded')
      AND o."created_at" > now() - interval '90 days'
    GROUP BY v."product_id"
    ORDER BY sum(i."qty") DESC, v."product_id"
    LIMIT 50`;
  const ids = sold.map((r) => r.product_id);
  const rows = ids.length
    ? await db.product.findMany({ where: { ...where, id: { in: ids } }, include: summaryInclude })
    : [];
  const top = ids.flatMap((id) => rows.filter((r) => r.id === id)).slice(0, take);
  return top.length < take
    ? [
        ...top,
        ...(await pick(
          orderBy.featured,
          top.map((p) => p.id),
          take - top.length,
        )),
      ]
    : top;
}

export async function listProducts(db: Db, q: ProductListQuery): Promise<z.infer<typeof ProductList>> {
  const where: Prisma.ProductWhereInput = {
    ...visible,
    ...(q.category && { category: { active: true, slug: q.category } }),
    ...(q.maxPrice && { priceFrom: { lt: q.maxPrice } }),
    ...(q.legacyId && { legacyId: q.legacyId }),
    ...(q.slugs && { slug: { in: q.slugs.split(',') } }),
    ...(q.q && {
      OR: [
        { nameEn: { contains: q.q, mode: 'insensitive' } },
        { nameBn: { contains: q.q, mode: 'insensitive' } },
        { category: { nameEn: { contains: q.q, mode: 'insensitive' } } },
      ],
    }),
  };
  const skip = (q.page - 1) * q.limit;

  // A homepage section keeps its hand-picked order, which lives on the section items.
  if (q.section) {
    const itemWhere = { sectionKey: q.section, product: where } satisfies Prisma.HomepageSectionItemWhereInput;
    const [items, total] = await Promise.all([
      db.homepageSectionItem.findMany({
        where: itemWhere,
        orderBy: { sort: 'asc' },
        skip,
        take: q.limit,
        include: { product: { include: summaryInclude } },
      }),
      db.homepageSectionItem.count({ where: itemWhere }),
    ]);
    if (total > 0 || !AUTO_SECTIONS.has(q.section) || q.page > 1)
      return { items: items.map((i) => toSummary(i.product)), total, page: q.page, limit: q.limit };
    // Nothing picked (or nothing picked is for sale): fill the section automatically.
    const auto = await autoSection(db, q.section as AutoSection, where, Math.min(q.limit, AUTO_SIZE));
    return { items: auto.map(toSummary), total: auto.length, page: 1, limit: q.limit };
  }

  const [rows, total] = await Promise.all([
    db.product.findMany({ where, orderBy: orderBy[q.sort], skip, take: q.limit, include: summaryInclude }),
    db.product.count({ where }),
  ]);
  return { items: rows.map(toSummary), total, page: q.page, limit: q.limit };
}

export async function getProduct(db: Db, slug: string): Promise<z.infer<typeof ProductDetail> | null> {
  const p = await db.product.findFirst({
    where: { ...visible, slug },
    include: {
      ...summaryInclude,
      category: { select: { slug: true, nameEn: true, optionLabel: true, variantFields: true } },
      images: { orderBy: { sort: 'asc' }, select: { url: true, alt: true } },
      variants: { orderBy: { sort: 'asc' } },
    },
  });
  if (!p) return null;
  // The shipping weight is for couriers, not shoppers; the other fields are shown with their unit.
  const fields = categoryFields(p.category.variantFields).filter((f) => f.key !== WEIGHT_FIELD);
  const detailsOf = (attributes: unknown) => {
    const values = (attributes ?? {}) as Record<string, unknown>;
    return fields.flatMap((f) => {
      const v = values[f.key];
      return typeof v === 'string' && v.trim() ? [{ label: f.label, value: f.unit ? `${v} ${f.unit}` : v }] : [];
    });
  };
  return {
    ...toSummary({ ...p, images: p.images.slice(0, 1) }),
    optionLabel: p.category.optionLabel,
    description: p.descriptionEn,
    images: p.images,
    variants: p.variants.map((v) => ({
      sku: v.sku,
      label: v.label,
      price: v.price,
      compareAtPrice: v.compareAtPrice,
      ...stockInfo(v.stock),
      details: detailsOf(v.attributes),
    })),
    seoTitle: p.seoTitle,
    seoDescription: p.seoDescription,
  };
}

export async function lookupVariants(db: Db, skus: string[]): Promise<z.infer<typeof CartVariant>[]> {
  const rows = await db.productVariant.findMany({
    where: { sku: { in: skus }, product: visible },
    include: {
      product: {
        select: {
          slug: true,
          nameEn: true,
          images: { orderBy: { sort: 'asc' }, take: 1, select: { url: true, alt: true } },
        },
      },
    },
  });
  return rows.map((v) => ({
    sku: v.sku,
    label: v.label,
    price: v.price,
    ...stockInfo(v.stock),
    product: { slug: v.product.slug, name: v.product.nameEn, image: v.product.images[0] ?? null },
  }));
}
