import type { z } from 'zod';
import { Prisma } from '../generated/prisma/client.js';
import { ApiError } from '../lib/errors.js';
import type { Db } from '../lib/prisma.js';
import type {
  FeaturedReviews,
  ProductReviews,
  PublicReview,
  ReviewableOrder,
  ReviewFields,
} from '../schemas/reviews.js';
import { deleteImage, storeImage } from './images.js';
import type { ImageStore } from './storage.js';

type Tx = Prisma.TransactionClient | Db;

const publicInclude = { images: { orderBy: { sort: 'asc' }, select: { url: true } } } satisfies Prisma.ReviewInclude;

function toPublic(r: Prisma.ReviewGetPayload<{ include: typeof publicInclude }>): z.infer<typeof PublicReview> {
  return {
    id: r.id,
    name: r.name,
    city: r.city,
    rating: r.rating,
    body: r.body,
    images: r.images.map((i) => i.url),
    createdAt: r.createdAt.toISOString(),
  };
}

const round1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);

/** Recomputes a product's star rating from its approved reviews. Call after any moderation change. */
export async function refreshRating(tx: Tx, productId: number) {
  const agg = await tx.review.aggregate({
    where: { productId, status: 'approved' },
    _avg: { rating: true },
    _count: { _all: true },
  });
  await tx.product.update({
    where: { id: productId },
    data: { ratingAvg: agg._avg.rating, ratingCount: agg._count._all },
  });
}

/** Approved reviews of a visible product, newest first, with the star breakdown. Null if no such product. */
export async function productReviews(
  db: Db,
  slug: string,
  q: { page: number; limit: number },
): Promise<z.infer<typeof ProductReviews> | null> {
  const product = await db.product.findFirst({
    where: { slug, status: 'active', category: { active: true } },
    select: { id: true, ratingAvg: true, ratingCount: true },
  });
  if (!product) return null;
  const where = { productId: product.id, status: 'approved' } satisfies Prisma.ReviewWhereInput;
  const [rows, groups] = await Promise.all([
    db.review.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      include: publicInclude,
    }),
    db.review.groupBy({ by: ['rating'], where, _count: { _all: true } }),
  ]);
  const breakdown = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  for (const g of groups) breakdown[String(g.rating) as keyof typeof breakdown] = g._count._all;
  return {
    summary: { average: round1(product.ratingAvg), count: product.ratingCount, breakdown },
    items: rows.map(toPublic),
    total: product.ratingCount,
    page: q.page,
    limit: q.limit,
  };
}

/** Recent 4- and 5-star reviews with some text, for the homepage, plus the store-wide average. */
export async function featuredReviews(db: Db, limit: number): Promise<z.infer<typeof FeaturedReviews>> {
  const visibleProduct = { status: 'active', category: { active: true } } satisfies Prisma.ProductWhereInput;
  const [rows, agg] = await Promise.all([
    db.review.findMany({
      where: { status: 'approved', rating: { gte: 4 }, product: visibleProduct },
      orderBy: { createdAt: 'desc' },
      take: limit * 3,
      include: { ...publicInclude, product: { select: { slug: true, nameEn: true } } },
    }),
    db.review.aggregate({ where: { status: 'approved' }, _avg: { rating: true }, _count: { _all: true } }),
  ]);
  // Prefer reviews with a real sentence or two; fall back to short ones.
  const sorted = [...rows.filter((r) => r.body.length >= 40), ...rows.filter((r) => r.body.length < 40)];
  return {
    average: round1(agg._avg.rating),
    count: agg._count._all,
    items: sorted
      .slice(0, limit)
      .map((r) => ({ ...toPublic(r), product: { slug: r.product.slug, name: r.product.nameEn } })),
  };
}

/** "Rahima Begum" → "Rahima B." */
export function suggestName(fullName: string) {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] ?? 'Customer';
  return `${parts[0]} ${parts[parts.length - 1]![0]!.toUpperCase()}.`;
}

async function findDeliveredOrder(db: Tx, orderNo: string, phone: string) {
  const order = await db.order.findFirst({
    where: { orderNo, phone },
    include: {
      items: {
        orderBy: { id: 'asc' },
        include: {
          variant: {
            select: {
              product: {
                select: {
                  id: true,
                  slug: true,
                  nameEn: true,
                  status: true,
                  images: { orderBy: { sort: 'asc' }, take: 1, select: { url: true, alt: true } },
                },
              },
            },
          },
        },
      },
      reviews: { select: { productId: true } },
    },
  });
  if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'No order matches that order number and phone number.');
  if (order.status !== 'delivered')
    throw new ApiError(409, 'NOT_DELIVERED', 'You can review your order once it has been delivered.');
  return order;
}

/**
 * The products in a delivered order that can be reviewed. Products that have been archived since
 * are left out (their page is gone), and so are items whose product was deleted.
 */
export async function lookupOrderForReview(
  db: Db,
  orderNo: string,
  phone: string,
): Promise<z.infer<typeof ReviewableOrder>> {
  const order = await findDeliveredOrder(db, orderNo, phone);
  const reviewed = new Set(order.reviews.map((r) => r.productId));
  const seen = new Set<number>();
  const items: z.infer<typeof ReviewableOrder>['items'] = [];
  for (const i of order.items) {
    const p = i.variant?.product;
    if (!p || p.status === 'archived' || seen.has(p.id)) continue;
    seen.add(p.id);
    items.push({
      slug: p.slug,
      name: p.nameEn,
      label: i.label,
      image: p.images[0] ?? null,
      reviewed: reviewed.has(p.id),
    });
  }
  return { orderNo: order.orderNo, suggestedName: suggestName(order.name), items };
}

/**
 * Saves a buyer's review as pending (staff approve it before it shows). Photos are checked and
 * stored first; if anything fails afterwards they are deleted again.
 */
export async function submitReview(
  db: Db,
  images: ImageStore | null,
  input: z.infer<typeof ReviewFields>,
  photos: Buffer[],
) {
  const order = await findDeliveredOrder(db, input.orderNo, input.phone);
  const item = order.items.find(
    (i) => i.variant?.product.slug === input.slug && i.variant.product.status !== 'archived',
  );
  if (!item) throw new ApiError(409, 'NOT_IN_ORDER', "That product isn't in this order.");
  const productId = item.variant!.product.id;
  if (order.reviews.some((r) => r.productId === productId))
    throw new ApiError(409, 'ALREADY_REVIEWED', "You've already reviewed this product for this order.");
  if (photos.length && !images) throw new ApiError(503, 'STORAGE_OFF', 'Photo uploads are not available right now.');

  const urls: string[] = [];
  const discard = () => Promise.allSettled(urls.map((u) => deleteImage(images!, u)));
  try {
    for (const photo of photos) urls.push(await storeImage(images!, `reviews/${order.id}-${productId}`, photo));
    const review = await db.review.create({
      data: {
        productId,
        orderId: order.id,
        name: input.name,
        city: order.districtName,
        rating: input.rating,
        body: input.body,
        images: { create: urls.map((url, sort) => ({ url, sort })) },
      },
    });
    return { id: review.id, status: 'pending' as const };
  } catch (err) {
    await discard();
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
      throw new ApiError(409, 'ALREADY_REVIEWED', "You've already reviewed this product for this order.");
    throw err;
  }
}
