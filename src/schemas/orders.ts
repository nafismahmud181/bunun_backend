import { z } from 'zod';

const Money = z.number().int().describe('Whole taka');

/** Bangladeshi mobile numbers: accepts 01XXXXXXXXX, 8801XXXXXXXXX or +8801XXXXXXXXX; returns 01XXXXXXXXX. */
export const BdPhone = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s-]/g, '').replace(/^\+?88(?=01)/, ''))
  .pipe(z.string().regex(/^01[3-9]\d{8}$/, 'Enter a valid 11-digit mobile number, e.g. 01712345678'));

export const IDEMPOTENCY_HEADER = 'idempotency-key';

export const CheckoutHeaders = z.looseObject({
  'x-cart-token': z.string().max(100),
  [IDEMPOTENCY_HEADER]: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,100}$/)
    .describe('A new random value (e.g. a UUID) per order attempt; resend the same value when retrying'),
});

export const CheckoutBody = z.object({
  name: z.string().trim().min(2).max(80),
  phone: BdPhone,
  areaId: z.number().int().positive(),
  address: z.string().trim().min(5).max(300).describe('House, road, area'),
  notes: z.string().trim().max(500).optional(),
  paymentMethod: z.literal('cod').describe('Only Cash on Delivery until Phase 4'),
});

export const OrderStatus = z
  .enum(['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'returned', 'refunded'])
  .meta({ id: 'OrderStatus' });

const OrderLine = z.object({
  sku: z.string(),
  name: z.string(),
  label: z.string(),
  qty: z.number().int(),
  lineTotal: Money,
});

export const OrderReceipt = z
  .object({
    orderNo: z.string(),
    status: OrderStatus,
    paymentMethod: z.enum(['cod', 'bkash', 'nagad', 'card']),
    phone: z.string(),
    items: z.array(OrderLine),
    subtotal: Money,
    deliveryFee: Money,
    total: Money,
    createdAt: z.string(),
  })
  .meta({ id: 'OrderReceipt' });

export const TrackQuery = z.object({ orderNo: z.string().trim().max(30), phone: BdPhone });

export const TrackedOrder = OrderReceipt.omit({ phone: true })
  .extend({
    paymentStatus: z.enum(['unpaid', 'partially_paid', 'paid', 'refunded']),
    district: z.string(),
    area: z.string(),
    history: z.array(z.object({ status: OrderStatus, at: z.string() })),
  })
  .meta({ id: 'TrackedOrder' });
