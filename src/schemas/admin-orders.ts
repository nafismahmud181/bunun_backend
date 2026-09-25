import { z } from 'zod';
import { BdPhone, OrderStatus } from './orders.js';

const Money = z.number().int().describe('Whole taka');
const PaymentStatus = z.enum(['unpaid', 'partially_paid', 'paid', 'refunded']);
const PaymentMethod = z.enum(['cod', 'bkash', 'nagad', 'card']);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

export const OrderListQuery = z.object({
  status: z
    .union([OrderStatus, z.literal('open')])
    .optional()
    .describe('"open" = pending, confirmed or processing'),
  paymentStatus: PaymentStatus.optional(),
  q: z.string().trim().max(100).optional().describe('Order number, phone or name'),
  from: Day.optional().describe('Placed on or after this day (Bangladesh time)'),
  to: Day.optional().describe('Placed on or before this day (Bangladesh time)'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const AdminOrderRow = z
  .object({
    orderNo: z.string(),
    createdAt: z.string(),
    name: z.string(),
    phone: z.string(),
    district: z.string(),
    area: z.string(),
    itemCount: z.number().int(),
    total: Money,
    status: OrderStatus,
    paymentStatus: PaymentStatus,
    paymentMethod: PaymentMethod,
    source: z.string(),
  })
  .meta({ id: 'AdminOrderRow' });

export const AdminOrderList = z
  .object({
    items: z.array(AdminOrderRow),
    total: z.number().int(),
    page: z.number().int(),
    limit: z.number().int(),
    counts: z
      .record(z.string(), z.number().int())
      .describe('Orders per status for the current search (ignores the status filter)'),
  })
  .meta({ id: 'AdminOrderList' });

export const AdminOrderDetail = z
  .object({
    orderNo: z.string(),
    createdAt: z.string(),
    status: OrderStatus,
    paymentStatus: PaymentStatus,
    paymentMethod: PaymentMethod,
    source: z.string(),
    allowedTransitions: z.array(OrderStatus),
    editable: z.boolean().describe('Contact and address can still be changed (pending or confirmed)'),
    customer: z.object({
      name: z.string(),
      phone: z.string(),
      orders: z.number().int(),
      delivered: z.number().int(),
      cancelled: z.number().int(),
      returned: z.number().int(),
      spent: Money.describe('Total of delivered orders'),
    }),
    address: z.object({
      division: z.string(),
      district: z.string(),
      area: z.string(),
      areaId: z.number().int().nullable(),
      line: z.string(),
      zone: z.string(),
    }),
    notes: z.string().nullable().describe("The customer's delivery notes"),
    items: z.array(
      z.object({
        sku: z.string(),
        name: z.string(),
        label: z.string(),
        unitPrice: Money,
        qty: z.number().int(),
        lineTotal: Money,
      }),
    ),
    subtotal: Money,
    discount: Money,
    deliveryFee: Money,
    total: Money,
    history: z.array(
      z.object({
        from: OrderStatus.nullable(),
        to: OrderStatus,
        note: z.string().nullable(),
        by: z.string(),
        at: z.string(),
      }),
    ),
    staffNotes: z.array(z.object({ id: z.number().int(), body: z.string(), by: z.string(), at: z.string() })),
    sms: z.array(z.object({ template: z.string(), status: z.string(), at: z.string(), sentAt: z.string().nullable() })),
    ip: z.string().nullable(),
  })
  .meta({ id: 'AdminOrderDetail' });

export const OrderNoParams = z.object({ orderNo: z.string().max(30) });

export const StatusChangeBody = z.object({
  to: OrderStatus,
  note: z.string().trim().max(500).optional(),
  restock: z.boolean().default(true).describe('For returns: put the items back in stock (off for damaged goods)'),
});

export const NoteBody = z.object({ body: z.string().trim().min(1).max(2000) });

export const OrderEditBody = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    phone: BdPhone.optional(),
    areaId: z.number().int().positive().optional(),
    addressLine: z.string().trim().min(5).max(300).optional(),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');
