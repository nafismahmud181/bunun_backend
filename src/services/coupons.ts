import type { Coupon, Prisma } from '../generated/prisma/client.js';
import { ApiError } from '../lib/errors.js';
import type { Db } from '../lib/prisma.js';
import { deliveryFee } from './delivery.js';

type Tx = Prisma.TransactionClient | Db;

export const normaliseCode = (code: string) => code.trim().toUpperCase();

const invalid = (message: string) => new ApiError(400, 'COUPON_INVALID', message);
const taka = (n: number) => `৳${n.toLocaleString('en-US')}`;

/**
 * Checks a coupon can be used for this order. The phone-number rules (uses per phone, first order
 * only) are checked only when a phone is given: the cart quote may not know it yet, checkout always does.
 * `excludeOrderId` leaves the order being placed out of the "first order" count.
 */
export async function checkCoupon(
  db: Tx,
  coupon: Coupon | null,
  ctx: { subtotal: number; phone?: string; excludeOrderId?: number; now?: Date },
): Promise<Coupon> {
  const now = ctx.now ?? new Date();
  if (!coupon || !coupon.active) throw invalid("That coupon code isn't valid.");
  if (coupon.startsAt && coupon.startsAt > now) throw invalid("That coupon isn't active yet.");
  if (coupon.endsAt && coupon.endsAt <= now) throw invalid('That coupon has expired.');
  if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit)
    throw invalid('That coupon has been fully used.');
  if (ctx.subtotal < coupon.minSubtotal)
    throw invalid(`This coupon needs items worth at least ${taka(coupon.minSubtotal)}.`);
  if (ctx.phone) {
    const used = await db.couponRedemption.count({ where: { couponId: coupon.id, phone: ctx.phone } });
    if (used >= coupon.perPhoneLimit)
      throw invalid(
        coupon.perPhoneLimit === 1
          ? "You've already used this coupon."
          : `This coupon can be used ${coupon.perPhoneLimit} times per phone number.`,
      );
    if (coupon.firstOrderOnly) {
      const previous = await db.order.count({
        where: {
          phone: ctx.phone,
          status: { not: 'cancelled' },
          ...(ctx.excludeOrderId && { id: { not: ctx.excludeOrderId } }),
        },
      });
      if (previous > 0) throw invalid('This coupon is only for your first order.');
    }
  }
  return coupon;
}

export const findCoupon = (db: Tx, code: string) => db.coupon.findUnique({ where: { code: normaliseCode(code) } });

/**
 * Amounts for an order with an (already checked) coupon, or none. Free delivery is judged on what
 * the customer pays for the items after the discount. `saved` is the taka the coupon took off:
 * the item discount, or the delivery fee it waived.
 */
export function applyCoupon(
  coupon: Pick<Coupon, 'type' | 'value' | 'maxDiscount'> | null,
  subtotal: number,
  zoneFee: number,
  freeThreshold: number,
) {
  let discount = 0;
  if (coupon?.type === 'percent') {
    discount = Math.floor((subtotal * coupon.value) / 100);
    if (coupon.maxDiscount !== null) discount = Math.min(discount, coupon.maxDiscount);
  } else if (coupon?.type === 'fixed') {
    discount = Math.min(coupon.value, subtotal);
  }
  const normalFee = deliveryFee(subtotal - discount, zoneFee, freeThreshold);
  const fee = coupon?.type === 'free_delivery' ? 0 : normalFee;
  return {
    discount,
    deliveryFee: fee,
    total: subtotal - discount + fee,
    saved: coupon?.type === 'free_delivery' ? normalFee : discount,
  };
}

/**
 * Inside the checkout transaction: locks the coupon row (so two orders can't both take its last
 * use), checks every rule again with the fresh subtotal, and returns it. Call recordRedemption
 * once the order exists.
 */
export async function lockCoupon(tx: Prisma.TransactionClient, code: string, subtotal: number, phone: string) {
  const normalised = normaliseCode(code);
  await tx.$queryRaw`SELECT id FROM coupons WHERE code = ${normalised} FOR UPDATE`;
  return checkCoupon(tx, await tx.coupon.findUnique({ where: { code: normalised } }), { subtotal, phone });
}

export async function recordRedemption(
  tx: Prisma.TransactionClient,
  coupon: Coupon,
  order: { id: number; phone: string },
  amount: number,
) {
  await tx.coupon.update({ where: { id: coupon.id }, data: { usedCount: { increment: 1 } } });
  await tx.couponRedemption.create({
    data: { couponId: coupon.id, orderId: order.id, phone: order.phone, amount },
  });
}

/** A cancelled order gives its coupon use back, so the customer can use the code again. */
export async function releaseRedemption(tx: Prisma.TransactionClient, orderId: number) {
  const r = await tx.couponRedemption.findUnique({ where: { orderId } });
  if (!r) return false;
  await tx.couponRedemption.delete({ where: { id: r.id } });
  await tx.coupon.update({ where: { id: r.couponId }, data: { usedCount: { decrement: 1 } } });
  return true;
}

/** How a coupon is described to shoppers, e.g. "20% off (up to ৳500)". */
export function couponSummary(c: Pick<Coupon, 'type' | 'value' | 'maxDiscount'>) {
  if (c.type === 'percent') return `${c.value}% off${c.maxDiscount !== null ? ` (up to ${taka(c.maxDiscount)})` : ''}`;
  if (c.type === 'fixed') return `${taka(c.value)} off`;
  return 'Free delivery';
}
