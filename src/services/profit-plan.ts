import type { AdminUser, Prisma } from '../generated/prisma/client.js';
import { audit } from '../lib/audit.js';
import type { Db } from '../lib/prisma.js';
import { ProfitPlan, type ProfitPlanInput } from '../schemas/profit-plan.js';
import { DEFAULT_ZONE } from './delivery.js';
import { todayInDhaka } from './reports.js';

const KEY = 'profit_plan';
const INSIDE_ZONE = 'inside-dhaka';
const ACTUAL_DAYS = 90;

/** Typical Bangladesh figures (Sept 2026 estimates); the owner replaces them with their own. */
export const DEFAULT_PLAN: ProfitPlanInput = {
  startup: [
    { label: 'Website development', amount: 0, note: 'Built in-house. An agency site like this costs ৳1.5–4 lakh.' },
    { label: 'Branding (logo, labels, stickers)', amount: 15_000, note: 'Freelance design ৳8–25k.' },
    { label: 'Product photography', amount: 20_000, note: '৳300–800 per product photo set.' },
    { label: 'Packaging stock', amount: 15_000, note: 'Boxes, poly mailers and tape for the first 500–800 parcels.' },
    { label: 'Trade licence, TIN, bank setup', amount: 8_000, note: 'Small-retail trade licence ৳3–8k plus fees.' },
    { label: 'Launch advertising', amount: 20_000, note: 'Extra Facebook boost for the opening weeks.' },
    { label: 'First stock purchase', amount: 0, note: 'Unknown yet: until you enter it, ROI leaves stock out.' },
    { label: 'Contingency', amount: 10_000, note: 'Buffer for things you forgot.' },
  ],
  monthly: [
    { label: 'VPS hosting (production + staging)', amount: 1_400, note: '2 × Contabo Cloud VPS 10, ≈ ৳700 each.' },
    { label: 'Supabase', amount: 0, note: 'Free plan now; Pro is $25 ≈ ৳3,000.' },
    { label: 'Domain (yearly ÷ 12)', amount: 150, note: '.com ≈ ৳1,800 a year.' },
    { label: 'Advertising (Facebook / Google)', amount: 30_000, note: 'Small BD décor shops spend ৳20–60k.' },
    { label: 'Staff (orders + packing)', amount: 15_000, note: 'One entry-level staff in Dhaka ৳12–18k.' },
    { label: 'Rent / storage', amount: 0, note: '৳0 home-based; a small store room is ৳8–15k.' },
    { label: 'Internet, phone, electricity', amount: 3_000, note: '' },
    { label: 'Miscellaneous', amount: 2_000, note: 'Supplies, bank charges.' },
  ],
  perOrder: {
    averageItemValue: 1_500,
    insideDhakaShare: 60,
    chargeInside: 70,
    chargeOutside: 130,
    freeDeliveryShare: 10,
    courierFeeInside: 60,
    courierFeeOutside: 110,
    codChargePct: 1,
    packaging: 40,
    smsPerOrder: 3,
    smsPrice: 0.35,
    returnRate: 10,
    returnChargePct: 100,
    paymentFeePct: 0,
  },
  margins: [30, 40, 50],
  orders: [60, 90, 120, 160, 200, 240, 270, 300, 330, 360, 380, 400],
};

const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : null);
const round = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v)));

/** The store's real figures over the last 90 days, to compare with (and fill in) the plan. */
export async function storeActuals(db: Db) {
  const to = todayInDhaka();
  const end = new Date(Date.parse(`${to}T00:00:00+06:00`) + 86_400_000);
  const start = new Date(end.getTime() - ACTUAL_DAYS * 86_400_000);
  const [[o], fees, zones] = await Promise.all([
    db.$queryRaw<Record<string, unknown>[]>`
      SELECT
        count(*) FILTER (WHERE "status" NOT IN ('cancelled', 'returned', 'refunded'))::int AS orders,
        avg("subtotal" - "discount") FILTER (WHERE "status" NOT IN ('cancelled', 'returned', 'refunded')) AS item_value,
        count(*) FILTER (
          WHERE "status" NOT IN ('cancelled', 'returned', 'refunded') AND "zone_key" <> ${DEFAULT_ZONE}
        )::int AS inside,
        count(*) FILTER (
          WHERE "status" NOT IN ('cancelled', 'returned', 'refunded') AND "delivery_fee" = 0
        )::int AS free,
        count(*) FILTER (WHERE "status" = 'delivered')::int AS delivered,
        count(*) FILTER (WHERE "status" = 'returned')::int AS returned
      FROM "orders"
      WHERE "created_at" >= ${start} AND "created_at" < ${end}`,
    // Live Pathao parcels only: sandbox test fees aren't real costs.
    db.$queryRaw<{ inside: boolean; fee: unknown }[]>`
      SELECT (o."zone_key" <> ${DEFAULT_ZONE}) AS inside, avg(s."delivery_fee") AS fee
      FROM "shipments" s JOIN "orders" o ON o."id" = s."order_id"
      WHERE s."courier" = 'pathao' AND s."delivery_fee" IS NOT NULL AND s."state" <> 'cancelled'
        AND s."created_at" >= ${start} AND s."created_at" < ${end}
      GROUP BY 1`,
    db.deliveryZone.findMany({ where: { key: { in: [INSIDE_ZONE, DEFAULT_ZONE] } } }),
  ]);
  const orders = Number(o!.orders);
  const finished = Number(o!.delivered) + Number(o!.returned);
  return {
    from: new Date(start.getTime() + 6 * 3_600_000).toISOString().slice(0, 10),
    to,
    days: ACTUAL_DAYS,
    orders,
    ordersPerMonth: orders ? Math.round((orders / ACTUAL_DAYS) * 30) : null,
    averageItemValue: round(o!.item_value),
    insideDhakaShare: pct(Number(o!.inside), orders),
    freeDeliveryShare: pct(Number(o!.free), orders),
    returnRate: pct(Number(o!.returned), finished),
    chargeInside: zones.find((z) => z.key === INSIDE_ZONE)?.fee ?? null,
    chargeOutside: zones.find((z) => z.key === DEFAULT_ZONE)?.fee ?? null,
    courierFeeInside: round(fees.find((f) => f.inside)?.fee),
    courierFeeOutside: round(fees.find((f) => !f.inside)?.fee),
  };
}

export async function getProfitPlan(db: Db) {
  const [row, actuals] = await Promise.all([db.setting.findUnique({ where: { key: KEY } }), storeActuals(db)]);
  // A stored plan from an older shape falls back to the defaults rather than breaking the page.
  const parsed = row ? ProfitPlan.safeParse(row.value) : null;
  return {
    plan: parsed?.success ? parsed.data : DEFAULT_PLAN,
    defaults: DEFAULT_PLAN,
    saved: !!parsed?.success,
    updatedAt: row?.updatedAt.toISOString() ?? null,
    actuals,
  };
}

export async function saveProfitPlan(db: Db, plan: ProfitPlanInput, ctx: { admin: AdminUser; ip: string }) {
  const value = plan as unknown as Prisma.InputJsonValue;
  await db.setting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
  await audit(db, {
    adminId: ctx.admin.id,
    action: 'profit_plan.update',
    entityType: 'settings',
    entityId: KEY,
    ip: ctx.ip,
  });
  return getProfitPlan(db);
}
