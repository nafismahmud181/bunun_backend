import { z } from 'zod';

// Danger zone: what to delete, confirmed with a fresh two-factor code and the word RESET.
export const DataResetBody = z
  .object({
    orders: z.boolean().describe('Orders with their shipments, SMS, reviews and coupon uses; stock is put back'),
    customers: z.boolean().describe('Carts, and customers who have no orders left'),
    coupons: z.boolean(),
    auditLog: z.boolean(),
    sessions: z.boolean().describe("Signs out every other admin session (the caller's stays)"),
    code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app'),
    confirm: z.literal('RESET', { error: 'Type RESET to confirm' }),
  })
  .refine((b) => b.orders || b.customers || b.coupons || b.auditLog || b.sessions, 'Choose something to delete');

export const DataResetResult = z
  .object({
    deleted: z.object({
      orders: z.number().int(),
      shipments: z.number().int(),
      smsMessages: z.number().int(),
      reviews: z.number().int(),
      customers: z.number().int(),
      carts: z.number().int(),
      coupons: z.number().int(),
      auditEntries: z.number().int(),
      sessions: z.number().int(),
      stockReturned: z.number().int().describe('Units of stock put back from deleted orders'),
    }),
    orderNumbersRestarted: z.boolean(),
  })
  .meta({ id: 'DataResetResult' });
