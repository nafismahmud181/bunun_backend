import type { z } from 'zod';
import type { AdminUser, Prisma } from '../generated/prisma/client.js';
import { audit } from '../lib/audit.js';
import { ApiError } from '../lib/errors.js';
import type { Db } from '../lib/prisma.js';
import type { AdminReview, AdminReviewList, ReviewListQuery } from '../schemas/admin-5a.js';
import { deleteImage } from './images.js';
import { refreshRating } from './reviews.js';
import type { ImageStore } from './storage.js';

interface Context {
  admin: AdminUser;
  ip: string;
}

const include = {
  images: { orderBy: { sort: 'asc' }, select: { url: true } },
  product: { select: { id: true, nameEn: true, slug: true } },
  order: { select: { orderNo: true, phone: true } },
} satisfies Prisma.ReviewInclude;

type Row = Prisma.ReviewGetPayload<{ include: typeof include }>;

function toAdmin(r: Row, names: Map<number, string>): z.infer<typeof AdminReview> {
  return {
    id: r.id,
    status: r.status,
    rating: r.rating,
    name: r.name,
    city: r.city,
    body: r.body,
    images: r.images.map((i) => i.url),
    product: { id: r.product.id, name: r.product.nameEn, slug: r.product.slug },
    orderNo: r.order?.orderNo ?? null,
    phone: r.order?.phone ?? null,
    moderatedBy: r.moderatedById ? (names.get(r.moderatedById) ?? null) : null,
    moderatedAt: r.moderatedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

async function adminNames(db: Db, rows: Row[]) {
  const ids = [...new Set(rows.map((r) => r.moderatedById).filter((id): id is number => id !== null))];
  if (!ids.length) return new Map<number, string>();
  const admins = await db.adminUser.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(admins.map((a) => [a.id, a.name]));
}

export async function listReviews(
  db: Db,
  q: z.infer<typeof ReviewListQuery>,
): Promise<z.infer<typeof AdminReviewList>> {
  const where: Prisma.ReviewWhereInput = { status: q.status, ...(q.productId && { productId: q.productId }) };
  const [rows, total, groups] = await Promise.all([
    db.review.findMany({
      where,
      // The queue is worked oldest first; decided reviews are browsed newest first.
      orderBy: { createdAt: q.status === 'pending' ? 'asc' : 'desc' },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      include,
    }),
    db.review.count({ where }),
    db.review.groupBy({
      by: ['status'],
      where: q.productId ? { productId: q.productId } : {},
      _count: { _all: true },
    }),
  ]);
  const count = (s: string) => groups.find((g) => g.status === s)?._count._all ?? 0;
  const names = await adminNames(db, rows);
  return {
    items: rows.map((r) => toAdmin(r, names)),
    total,
    page: q.page,
    limit: q.limit,
    counts: { pending: count('pending'), approved: count('approved'), rejected: count('rejected') },
  };
}

/** Approves or rejects a review and updates the product's star rating in the same transaction. */
export async function moderateReview(db: Db, id: number, status: 'approved' | 'rejected', ctx: Context) {
  const before = await db.review.findUnique({ where: { id }, include: { product: { select: { nameEn: true } } } });
  if (!before) throw new ApiError(404, 'NOT_FOUND', 'Review not found.');
  // Relations are loaded after the transaction: Prisma fetches them in parallel, which a
  // transaction's single connection shouldn't be asked to do.
  await db.$transaction(async (tx) => {
    await tx.review.update({ where: { id }, data: { status, moderatedById: ctx.admin.id, moderatedAt: new Date() } });
    await refreshRating(tx, before.productId);
    await audit(tx, {
      adminId: ctx.admin.id,
      action: `review.${status === 'approved' ? 'approve' : 'reject'}`,
      entityType: 'review',
      entityId: id,
      data: { from: before.status, to: status, product: before.product.nameEn, rating: before.rating },
      ip: ctx.ip,
    });
  });
  const row = await db.review.findUniqueOrThrow({ where: { id }, include });
  return toAdmin(row, new Map([[ctx.admin.id, ctx.admin.name]]));
}

/** Deletes a review and its photos (e.g. spam or personal details in a photo). */
export async function deleteReview(db: Db, images: ImageStore | null, id: number, ctx: Context) {
  const r = await db.review.findUnique({ where: { id }, include });
  if (!r) throw new ApiError(404, 'NOT_FOUND', 'Review not found.');
  await db.$transaction(async (tx) => {
    await tx.review.delete({ where: { id } });
    await refreshRating(tx, r.productId);
    await audit(tx, {
      adminId: ctx.admin.id,
      action: 'review.delete',
      entityType: 'review',
      entityId: id,
      data: { product: r.product.nameEn, rating: r.rating, status: r.status },
      ip: ctx.ip,
    });
  });
  if (images) await Promise.allSettled(r.images.map((i) => deleteImage(images, i.url)));
  return r.status === 'approved';
}
