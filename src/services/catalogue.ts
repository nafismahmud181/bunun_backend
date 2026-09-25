import type { z } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';
import type { Db } from '../lib/prisma.js';
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

export async function listProducts(db: Db, q: ProductListQuery): Promise<z.infer<typeof ProductList>> {
  const where: Prisma.ProductWhereInput = {
    ...visible,
    ...(q.category && { category: { active: true, slug: q.category } }),
    ...(q.maxPrice && { priceFrom: { lt: q.maxPrice } }),
    ...(q.legacyId && { legacyId: q.legacyId }),
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
    return { items: items.map((i) => toSummary(i.product)), total, page: q.page, limit: q.limit };
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
      images: { orderBy: { sort: 'asc' }, select: { url: true, alt: true } },
      variants: { orderBy: { sort: 'asc' } },
    },
  });
  if (!p) return null;
  return {
    ...toSummary({ ...p, images: p.images.slice(0, 1) }),
    description: p.descriptionEn,
    images: p.images,
    variants: p.variants.map((v) => ({
      sku: v.sku,
      label: v.label,
      price: v.price,
      compareAtPrice: v.compareAtPrice,
      ...stockInfo(v.stock),
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
