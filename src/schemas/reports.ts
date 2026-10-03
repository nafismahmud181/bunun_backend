import { z } from 'zod';

const Money = z.number().int().describe('Whole taka');
const Count = z.number().int();
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

export const ReportQuery = z.object({
  from: Day.optional().describe('First day (Bangladesh time); default 29 days before `to`'),
  to: Day.optional().describe('Last day, included; default today'),
});

const Bucket = z.object({ day: z.string(), orders: Count, revenue: Money });
const Stage = z.object({ orders: Count, amount: Money });

export const SalesReport = z
  .object({
    range: z.object({ from: z.string(), to: z.string(), days: Count, bucket: z.enum(['day', 'month']) }),
    previous: z
      .object({ from: z.string(), to: z.string(), orders: Count, revenue: Money })
      .describe('The same number of days just before'),
    summary: z.object({
      orders: Count.describe('Orders placed, without cancelled, returned and refunded ones'),
      revenue: Money.describe('Their totals (items − discounts + delivery)'),
      averageOrder: Money,
      itemsSold: Count,
      discounts: Money,
      deliveryFees: Money.describe('Delivery charged to customers'),
      allOrders: Count,
      cancelled: Count,
      returned: Count,
      delivered: Count,
      returnRate: Count.nullable().describe('Returned ÷ (delivered + returned), %'),
      customers: Count,
      newCustomers: Count.describe('First order ever in this range'),
      revenueChange: Count.nullable().describe('% against the previous period; null when it had none'),
      ordersChange: Count.nullable(),
    }),
    series: z.array(Bucket).describe('Per day, or per month for ranges over 92 days'),
    products: z.array(
      z.object({ productId: Count.nullable(), name: z.string(), qty: Count, revenue: Money.describe('Item sales') }),
    ),
    categories: z.array(z.object({ name: z.string(), orders: Count, qty: Count, revenue: Money })),
    sources: z.array(z.object({ source: z.string(), orders: Count, revenue: Money })),
    statuses: z.array(z.object({ status: z.string(), orders: Count, total: Money })),
    payments: z.object({
      methods: z.array(z.object({ method: z.string(), orders: Count, amount: Money, paid: Money })),
      cod: z.object({ collected: Stage, withCourier: Stage, notShipped: Stage }),
    }),
    coupons: z.array(z.object({ code: z.string(), uses: Count, saved: Money, revenue: Money })),
    couriers: z.array(
      z.object({
        courier: z.string(),
        booked: Count,
        inTransit: Count,
        delivered: Count,
        returned: Count,
        cancelled: Count,
        successRate: Count.nullable(),
        fees: Money.describe('Delivery fees charged by the courier'),
        codBooked: Money,
        averageDays: z.number().nullable().describe('Booking to delivery'),
      }),
    ),
  })
  .meta({ id: 'SalesReport' });
