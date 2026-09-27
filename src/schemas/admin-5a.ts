import { z } from 'zod';
import { CouponCode } from './orders.js';

const Money = z.number().int().min(0).describe('Whole taka');
const When = z.iso.datetime({ offset: true }).describe('ISO date-time');

// ---------- Coupons ----------

export const CouponType = z.enum(['percent', 'fixed', 'free_delivery']).meta({ id: 'CouponType' });

const couponFields = {
  description: z.string().trim().max(200).nullable().optional().describe('Staff-facing note, also shown at checkout'),
  type: CouponType,
  value: z.number().int().min(0).describe('Percent for "percent", taka for "fixed", 0 for "free_delivery"'),
  maxDiscount: Money.nullable().optional().describe('Cap for a percentage discount'),
  minSubtotal: Money.default(0),
  startsAt: When.nullable().optional(),
  endsAt: When.nullable().optional(),
  usageLimit: z.number().int().min(1).nullable().optional().describe('Total uses; null = unlimited'),
  perPhoneLimit: z.number().int().min(1).max(100).default(1),
  firstOrderOnly: z.boolean().default(false),
  active: z.boolean().default(true),
};

type CouponShape = {
  type?: z.infer<typeof CouponType>;
  value?: number;
  startsAt?: string | null;
  endsAt?: string | null;
};

/** Rules shared by create and update: a sensible value for the type, and an end after the start. */
function checkCoupon(c: CouponShape, ctx: z.RefinementCtx) {
  if (c.type === 'percent' && c.value !== undefined && (c.value < 1 || c.value > 100))
    ctx.addIssue({ code: 'custom', path: ['value'], message: 'A percentage must be between 1 and 100.' });
  if (c.type === 'fixed' && c.value !== undefined && c.value < 1)
    ctx.addIssue({ code: 'custom', path: ['value'], message: 'Enter the taka amount to take off.' });
  if (c.startsAt && c.endsAt && new Date(c.endsAt) <= new Date(c.startsAt))
    ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'The end must be after the start.' });
}

export const CouponCreate = z
  .object({ code: CouponCode.transform((s) => s.toUpperCase()), ...couponFields })
  .superRefine(checkCoupon);

export const CouponUpdate = z
  .object({
    description: couponFields.description,
    type: CouponType.optional(),
    value: couponFields.value.optional(),
    maxDiscount: couponFields.maxDiscount,
    minSubtotal: Money.optional(),
    startsAt: couponFields.startsAt,
    endsAt: couponFields.endsAt,
    usageLimit: couponFields.usageLimit,
    perPhoneLimit: z.number().int().min(1).max(100).optional(),
    firstOrderOnly: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .superRefine(checkCoupon);

export const CouponState = z
  .enum(['active', 'scheduled', 'expired', 'used_up', 'disabled'])
  .meta({ id: 'CouponState' });

export const AdminCoupon = z
  .object({
    id: z.number().int(),
    code: z.string(),
    description: z.string().nullable(),
    type: CouponType,
    value: z.number().int(),
    maxDiscount: z.number().int().nullable(),
    minSubtotal: z.number().int(),
    startsAt: z.string().nullable(),
    endsAt: z.string().nullable(),
    usageLimit: z.number().int().nullable(),
    perPhoneLimit: z.number().int(),
    firstOrderOnly: z.boolean(),
    active: z.boolean(),
    usedCount: z.number().int(),
    state: CouponState,
    summary: z.string(),
    saved: z.number().int().describe('Taka taken off across its orders'),
    createdAt: z.string(),
  })
  .meta({ id: 'AdminCoupon' });

export const CouponListQuery = z.object({
  q: z.string().trim().max(30).optional(),
  state: CouponState.optional(),
});

export const CouponDetail = AdminCoupon.extend({
  orderTotal: z.number().int().describe('Total of the orders that used it'),
  redemptions: z.array(
    z.object({
      orderNo: z.string(),
      phone: z.string(),
      amount: z.number().int(),
      orderTotal: z.number().int(),
      status: z.string(),
      at: z.string(),
    }),
  ),
}).meta({ id: 'CouponDetail' });

// ---------- Reviews ----------

export const ReviewStatus = z.enum(['pending', 'approved', 'rejected']).meta({ id: 'ReviewStatus' });

export const AdminReview = z
  .object({
    id: z.number().int(),
    status: ReviewStatus,
    rating: z.number().int(),
    name: z.string(),
    city: z.string().nullable(),
    body: z.string(),
    images: z.array(z.string()),
    product: z.object({ id: z.number().int(), name: z.string(), slug: z.string() }),
    orderNo: z.string().nullable(),
    phone: z.string().nullable(),
    moderatedBy: z.string().nullable(),
    moderatedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .meta({ id: 'AdminReview' });

export const ReviewListQuery = z.object({
  status: ReviewStatus.default('pending'),
  productId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const AdminReviewList = z
  .object({
    items: z.array(AdminReview),
    total: z.number().int(),
    page: z.number().int(),
    limit: z.number().int(),
    counts: z.object({ pending: z.number().int(), approved: z.number().int(), rejected: z.number().int() }),
  })
  .meta({ id: 'AdminReviewList' });

export const ModerateBody = z.object({ status: z.enum(['approved', 'rejected']) });
