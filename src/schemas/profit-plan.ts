import { z } from 'zod';

// The profit planner's inputs (admin "Profit planner" page). The maths runs in the admin panel as
// you type; the API only stores the inputs and supplies the store's real figures to compare with.

const Taka = z.number().min(0).max(100_000_000);
const Pct = z.number().min(0).max(100).describe('Percent, e.g. 60 for 60%');

const CostLine = z.object({
  label: z.string().trim().min(1).max(80),
  amount: Taka.describe('Whole or fractional taka'),
  note: z.string().trim().max(300).default(''),
});

export const ProfitPlan = z
  .object({
    startup: z.array(CostLine).max(40).describe('One-time costs before the first sale'),
    monthly: z.array(CostLine).max(40).describe('Fixed costs paid every month'),
    perOrder: z.object({
      averageItemValue: Taka.describe('Items in an order after discounts, without delivery'),
      insideDhakaShare: Pct,
      chargeInside: Taka.describe('Delivery charged to the customer inside Dhaka'),
      chargeOutside: Taka,
      freeDeliveryShare: Pct.describe('Orders that pay no delivery'),
      courierFeeInside: Taka.describe('What the courier charges you inside Dhaka'),
      courierFeeOutside: Taka,
      codChargePct: Pct.describe('Courier COD charge on cash collected'),
      packaging: Taka,
      smsPerOrder: z.number().min(0).max(50),
      smsPrice: Taka,
      returnRate: Pct.describe('Parcels refused or returned'),
      returnChargePct: Pct.describe('Return charge as a share of the delivery fee'),
      paymentFeePct: Pct.describe('Online-payment fee; 0 while cash on delivery only'),
    }),
    margins: z.array(Pct).length(3).describe('Three product-margin scenarios: (price − cost) ÷ price'),
    orders: z.array(z.number().int().min(0).max(1_000_000)).length(12).describe('Planned orders, months 1–12'),
  })
  .meta({ id: 'ProfitPlan' });

export type ProfitPlanInput = z.infer<typeof ProfitPlan>;

const Nullable = z.number().nullable();

export const StoreActuals = z
  .object({
    from: z.string(),
    to: z.string(),
    days: z.number().int(),
    orders: z.number().int().describe('Orders placed, without cancelled, returned and refunded ones'),
    ordersPerMonth: Nullable,
    averageItemValue: Nullable,
    insideDhakaShare: Nullable,
    freeDeliveryShare: Nullable,
    returnRate: Nullable.describe('Returned ÷ (delivered + returned), %; null with nothing finished yet'),
    chargeInside: Nullable.describe('Delivery fee of the inside-Dhaka zone'),
    chargeOutside: Nullable.describe('Delivery fee of the outside-Dhaka zone'),
    courierFeeInside: Nullable.describe('Average live courier fee on parcels inside Dhaka'),
    courierFeeOutside: Nullable,
  })
  .meta({ id: 'StoreActuals' });

export const ProfitPlanReply = z
  .object({
    plan: ProfitPlan,
    defaults: ProfitPlan,
    saved: z.boolean().describe('False until someone saves; `plan` is then the defaults'),
    updatedAt: z.string().nullable(),
    actuals: StoreActuals,
  })
  .meta({ id: 'ProfitPlanReply' });
