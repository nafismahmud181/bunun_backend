import type { Db } from '../lib/prisma.js';
import { getSettings } from '../lib/settings.js';

// Sales figures count every order except cancelled, returned and refunded ones, by the day it was
// placed in Bangladesh time (UTC+6). Timestamps are stored in UTC.
const LOCAL_DAY = `(("created_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Dhaka')::date`;
const TODAY = `(now() AT TIME ZONE 'Asia/Dhaka')::date`;
const COUNTED = `"status" NOT IN ('cancelled', 'returned', 'refunded')`;

export async function dashboard(db: Db) {
  const { low_stock_threshold: threshold } = await getSettings(db);
  const [totals, days, top, byStatus, lowStock] = await Promise.all([
    db.$queryRawUnsafe<{ today_orders: number; today_revenue: number; month_orders: number; month_revenue: number }[]>(`
      SELECT
        count(*) FILTER (WHERE ${LOCAL_DAY} = ${TODAY})::int AS today_orders,
        COALESCE(sum("total") FILTER (WHERE ${LOCAL_DAY} = ${TODAY}), 0)::int AS today_revenue,
        count(*)::int AS month_orders,
        COALESCE(sum("total"), 0)::int AS month_revenue
      FROM "orders"
      WHERE ${COUNTED} AND ${LOCAL_DAY} >= date_trunc('month', ${TODAY})::date`),
    db.$queryRawUnsafe<{ day: string; orders: number; revenue: number }[]>(`
      SELECT to_char(d, 'YYYY-MM-DD') AS day, count(o."id")::int AS orders, COALESCE(sum(o."total"), 0)::int AS revenue
      FROM generate_series(${TODAY} - 29, ${TODAY}, interval '1 day') AS d
      LEFT JOIN "orders" o ON ((o."created_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Dhaka')::date = d::date
        AND o."status" NOT IN ('cancelled', 'returned', 'refunded')
      GROUP BY d ORDER BY d`),
    db.$queryRawUnsafe<{ name: string; qty: number; revenue: number }[]>(`
      SELECT i."product_name" AS name, sum(i."qty")::int AS qty, sum(i."line_total")::int AS revenue
      FROM "order_items" i JOIN "orders" o ON o."id" = i."order_id"
      WHERE o."status" NOT IN ('cancelled', 'returned', 'refunded') AND o."created_at" >= now() - interval '30 days'
      GROUP BY i."product_name" ORDER BY qty DESC, revenue DESC LIMIT 5`),
    db.order.groupBy({ by: ['status'], _count: { _all: true } }),
    db.productVariant.findMany({
      where: { stock: { lte: threshold }, product: { status: { not: 'archived' } } },
      orderBy: [{ stock: 'asc' }, { id: 'asc' }],
      take: 10,
      include: { product: { select: { id: true, nameEn: true } } },
    }),
  ]);
  const t = totals[0]!;
  return {
    today: { orders: t.today_orders, revenue: t.today_revenue },
    month: {
      orders: t.month_orders,
      revenue: t.month_revenue,
      averageOrder: t.month_orders ? Math.round(t.month_revenue / t.month_orders) : 0,
    },
    byStatus: Object.fromEntries(byStatus.map((g) => [g.status, g._count._all])),
    last30Days: days,
    topProducts: top,
    lowStock: lowStock.map((v) => ({
      sku: v.sku,
      productId: v.product.id,
      name: v.product.nameEn,
      label: v.label,
      stock: v.stock,
    })),
    lowStockThreshold: threshold,
  };
}
