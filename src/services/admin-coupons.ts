import type { z } from 'zod';
import { type AdminUser, type Coupon, Prisma } from '../generated/prisma/client.js';
import { audit } from '../lib/audit.js';
import { ApiError } from '../lib/errors.js';
import type { Db } from '../lib/prisma.js';
import type {
  AdminCoupon,
  CouponCreate,
  CouponDetail,
  CouponListQuery,
  CouponState,
  CouponUpdate,
} from '../schemas/admin-5a.js';
import { couponSummary } from './coupons.js';

interface Context {
  admin: AdminUser;
  ip: string;
}

export function couponState(c: Coupon, now = new Date()): z.infer<typeof CouponState> {
  if (!c.active) return 'disabled';
  if (c.endsAt && c.endsAt <= now) return 'expired';
  if (c.usageLimit !== null && c.usedCount >= c.usageLimit) return 'used_up';
  if (c.startsAt && c.startsAt > now) return 'scheduled';
  return 'active';
}

function toAdmin(c: Coupon, saved: number): z.infer<typeof AdminCoupon> {
  return {
    id: c.id,
    code: c.code,
    description: c.description,
    type: c.type,
    value: c.value,
    maxDiscount: c.maxDiscount,
    minSubtotal: c.minSubtotal,
    startsAt: c.startsAt?.toISOString() ?? null,
    endsAt: c.endsAt?.toISOString() ?? null,
    usageLimit: c.usageLimit,
    perPhoneLimit: c.perPhoneLimit,
    firstOrderOnly: c.firstOrderOnly,
    active: c.active,
    usedCount: c.usedCount,
    state: couponState(c),
    summary: couponSummary(c),
    saved,
    createdAt: c.createdAt.toISOString(),
  };
}

export async function listCoupons(db: Db, q: z.infer<typeof CouponListQuery>) {
  const rows = await db.coupon.findMany({
    where: q.q ? { code: { contains: q.q.toUpperCase() } } : {},
    orderBy: { createdAt: 'desc' },
  });
  const sums = await db.couponRedemption.groupBy({
    by: ['couponId'],
    where: { couponId: { in: rows.map((r) => r.id) } },
    _sum: { amount: true },
  });
  const saved = new Map(sums.map((s) => [s.couponId, s._sum.amount ?? 0]));
  const items = rows.map((c) => toAdmin(c, saved.get(c.id) ?? 0));
  return q.state ? items.filter((c) => c.state === q.state) : items;
}

export async function getCoupon(db: Db, id: number): Promise<z.infer<typeof CouponDetail>> {
  const c = await db.coupon.findUnique({ where: { id } });
  if (!c) throw new ApiError(404, 'NOT_FOUND', 'Coupon not found.');
  const [redemptions, sums] = await Promise.all([
    db.couponRedemption.findMany({
      where: { couponId: id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { order: { select: { orderNo: true, total: true, status: true } } },
    }),
    db.couponRedemption.aggregate({ where: { couponId: id }, _sum: { amount: true } }),
  ]);
  const orderTotal = await db.order.aggregate({
    where: { redemption: { couponId: id } },
    _sum: { total: true },
  });
  return {
    ...toAdmin(c, sums._sum.amount ?? 0),
    orderTotal: orderTotal._sum.total ?? 0,
    redemptions: redemptions.map((r) => ({
      orderNo: r.order.orderNo,
      phone: r.phone,
      amount: r.amount,
      orderTotal: r.order.total,
      status: r.order.status,
      at: r.createdAt.toISOString(),
    })),
  };
}

const dates = (input: { startsAt?: string | null; endsAt?: string | null }) => ({
  ...(input.startsAt !== undefined && { startsAt: input.startsAt ? new Date(input.startsAt) : null }),
  ...(input.endsAt !== undefined && { endsAt: input.endsAt ? new Date(input.endsAt) : null }),
});

export async function createCoupon(db: Db, input: z.infer<typeof CouponCreate>, ctx: Context) {
  try {
    const c = await db.coupon.create({
      data: {
        ...input,
        value: input.type === 'free_delivery' ? 0 : input.value,
        maxDiscount: input.type === 'percent' ? (input.maxDiscount ?? null) : null,
        description: input.description || null,
        ...dates(input),
      },
    });
    await audit(db, {
      adminId: ctx.admin.id,
      action: 'coupon.create',
      entityType: 'coupon',
      entityId: c.id,
      data: { code: c.code, summary: couponSummary(c) },
      ip: ctx.ip,
    });
    return getCoupon(db, c.id);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
      throw new ApiError(409, 'CODE_TAKEN', 'A coupon with that code already exists.');
    throw err;
  }
}

/**
 * Edits a coupon. Once it has been used, its type and value are fixed (the orders that used it
 * record what it gave); limits, dates, description and on/off can still change.
 */
export async function updateCoupon(db: Db, id: number, input: z.infer<typeof CouponUpdate>, ctx: Context) {
  const before = await db.coupon.findUnique({ where: { id } });
  if (!before) throw new ApiError(404, 'NOT_FOUND', 'Coupon not found.');
  const used = await db.couponRedemption.count({ where: { couponId: id } });
  const changesDeal =
    (input.type !== undefined && input.type !== before.type) ||
    (input.value !== undefined && input.value !== before.value) ||
    (input.maxDiscount !== undefined && input.maxDiscount !== before.maxDiscount);
  if (used > 0 && changesDeal)
    throw new ApiError(
      409,
      'COUPON_IN_USE',
      'This coupon has been used, so its discount can no longer change. Disable it and create a new one.',
    );
  const type = input.type ?? before.type;
  const value = type === 'free_delivery' ? 0 : (input.value ?? before.value);
  if (type === 'percent' && (value < 1 || value > 100))
    throw new ApiError(400, 'BAD_VALUE', 'A percentage must be between 1 and 100.');
  if (type === 'fixed' && value < 1) throw new ApiError(400, 'BAD_VALUE', 'Enter the taka amount to take off.');
  // Dates are strings in the request and Date objects in the database; dates() converts them.
  const rest = Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'startsAt' && k !== 'endsAt'));
  const data: Prisma.CouponUpdateInput = {
    ...rest,
    type,
    value,
    maxDiscount: type === 'percent' ? (input.maxDiscount !== undefined ? input.maxDiscount : before.maxDiscount) : null,
    ...(input.description !== undefined && { description: input.description || null }),
    ...dates(input),
  };
  const { startsAt, endsAt } = { startsAt: before.startsAt, endsAt: before.endsAt, ...dates(input) };
  if (startsAt && endsAt && endsAt <= startsAt)
    throw new ApiError(400, 'BAD_DATES', 'The end must be after the start.');
  const after = await db.coupon.update({ where: { id }, data });
  const changed = Object.fromEntries(
    Object.keys(input)
      .filter((k) => String(before[k as keyof Coupon]) !== String(after[k as keyof Coupon]))
      .map((k) => [k, { from: before[k as keyof Coupon], to: after[k as keyof Coupon] }]),
  );
  await audit(db, {
    adminId: ctx.admin.id,
    action: 'coupon.update',
    entityType: 'coupon',
    entityId: id,
    data: { code: after.code, ...changed } as Prisma.InputJsonValue,
    ip: ctx.ip,
  });
  return getCoupon(db, id);
}

/** Only a coupon no order has used can be deleted; used ones are disabled instead. */
export async function deleteCoupon(db: Db, id: number, ctx: Context) {
  const c = await db.coupon.findUnique({ where: { id } });
  if (!c) throw new ApiError(404, 'NOT_FOUND', 'Coupon not found.');
  if (await db.couponRedemption.count({ where: { couponId: id } }))
    throw new ApiError(409, 'COUPON_IN_USE', 'This coupon has been used, so it can only be disabled.');
  await db.coupon.delete({ where: { id } });
  await audit(db, {
    adminId: ctx.admin.id,
    action: 'coupon.delete',
    entityType: 'coupon',
    entityId: id,
    data: { code: c.code },
    ip: ctx.ip,
  });
}
