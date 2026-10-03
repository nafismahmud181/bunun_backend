import { Prisma } from '../generated/prisma/client.js';
import { ApiError } from '../lib/errors.js';
import type { Db } from '../lib/prisma.js';

// Reports for a range of Bangladesh-time days (UTC+6, no daylight saving). Sales count every order
// placed in the range except cancelled, returned and refunded ones (the dashboard's rule); the
// order counts by status, payments and courier figures say what happened to them since.

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 366;
const COUNTED = Prisma.sql`o."status" NOT IN ('cancelled', 'returned', 'refunded')`;

/** Midnight in Dhaka of a YYYY-MM-DD day, as a UTC instant. */
const dhakaMidnight = (day: string) => new Date(`${day}T00:00:00+06:00`);
const addDays = (day: string, n: number) =>
  new Date(dhakaMidnight(day).getTime() + n * 86_400_000 + 6 * 3_600_000).toISOString().slice(0, 10);
export const todayInDhaka = () => new Date(Date.now() + 6 * 3_600_000).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) =>
  Math.round((dhakaMidnight(to).getTime() - dhakaMidnight(from).getTime()) / 86_400_000) + 1;

/** The range asked for, defaulting to the last 30 days (today included). */
export function reportRange(q: { from?: string; to?: string }) {
  const to = q.to ?? todayInDhaka();
  const from = q.from ?? addDays(to, -29);
  if (!DAY.test(from) || !DAY.test(to)) throw new ApiError(400, 'BAD_RANGE', 'Dates must look like 2026-09-30.');
  if (from > to) throw new ApiError(400, 'BAD_RANGE', 'The start date must be on or before the end date.');
  const days = daysBetween(from, to);
  if (days > MAX_DAYS) throw new ApiError(400, 'BAD_RANGE', `Choose at most ${MAX_DAYS} days.`);
  // The same number of days just before, for "compared with the previous period".
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(days - 1));
  return { from, to, days, prevFrom, prevTo, bucket: days > 92 ? ('month' as const) : ('day' as const) };
}

type Range = ReturnType<typeof reportRange>;
const n = (v: unknown) => Number(v ?? 0);

async function totals(db: Db, from: string, to: string) {
  const start = dhakaMidnight(from);
  const end = dhakaMidnight(addDays(to, 1));
  const [row] = await db.$queryRaw<Record<string, unknown>[]>`
    SELECT
      count(*) FILTER (WHERE ${COUNTED})::int AS orders,
      COALESCE(sum(o."total") FILTER (WHERE ${COUNTED}), 0)::int AS revenue,
      COALESCE(sum(o."discount") FILTER (WHERE ${COUNTED}), 0)::int AS discounts,
      COALESCE(sum(o."delivery_fee") FILTER (WHERE ${COUNTED}), 0)::int AS delivery_fees,
      count(*)::int AS all_orders,
      count(*) FILTER (WHERE o."status" = 'cancelled')::int AS cancelled,
      count(*) FILTER (WHERE o."status" = 'returned')::int AS returned,
      count(*) FILTER (WHERE o."status" = 'delivered')::int AS delivered,
      count(DISTINCT o."phone") FILTER (WHERE ${COUNTED})::int AS customers,
      count(DISTINCT o."phone") FILTER (
        WHERE ${COUNTED} AND NOT EXISTS (
          SELECT 1 FROM "orders" e WHERE e."phone" = o."phone" AND e."created_at" < ${start}
        )
      )::int AS new_customers
    FROM "orders" o
    WHERE o."created_at" >= ${start} AND o."created_at" < ${end}`;
  const [items] = await db.$queryRaw<{ items: number }[]>`
    SELECT COALESCE(sum(i."qty"), 0)::int AS items
    FROM "order_items" i JOIN "orders" o ON o."id" = i."order_id"
    WHERE ${COUNTED} AND o."created_at" >= ${start} AND o."created_at" < ${end}`;
  const r = row!;
  const orders = n(r.orders);
  const revenue = n(r.revenue);
  const finished = n(r.delivered) + n(r.returned);
  return {
    orders,
    revenue,
    averageOrder: orders ? Math.round(revenue / orders) : 0,
    itemsSold: n(items?.items),
    discounts: n(r.discounts),
    deliveryFees: n(r.delivery_fees),
    allOrders: n(r.all_orders),
    cancelled: n(r.cancelled),
    returned: n(r.returned),
    delivered: n(r.delivered),
    returnRate: finished ? Math.round((n(r.returned) / finished) * 100) : null,
    customers: n(r.customers),
    newCustomers: n(r.new_customers),
  };
}

export async function salesReport(db: Db, range: Range) {
  const start = dhakaMidnight(range.from);
  const end = dhakaMidnight(addDays(range.to, 1));
  const inRange = Prisma.sql`o."created_at" >= ${start} AND o."created_at" < ${end}`;
  const localDay = Prisma.sql`((o."created_at" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Dhaka')::date`;
  const unit = range.bucket === 'month' ? Prisma.sql`'month'` : Prisma.sql`'day'`;

  const [
    current,
    previous,
    series,
    products,
    categories,
    sources,
    statuses,
    payments,
    coupons,
    shipments,
    deliveryTime,
  ] = await Promise.all([
    totals(db, range.from, range.to),
    totals(db, range.prevFrom, range.prevTo),
    db.$queryRaw<{ period: string; orders: number; revenue: number }[]>`
        SELECT to_char(g.p, 'YYYY-MM-DD') AS period, count(o."id")::int AS orders, COALESCE(sum(o."total"), 0)::int AS revenue
        FROM generate_series(date_trunc(${unit}, ${range.from}::date), ${range.to}::date, ('1 ' || ${unit})::interval) AS g(p)
        LEFT JOIN "orders" o ON date_trunc(${unit}, ${localDay}) = g.p AND ${COUNTED} AND ${inRange}
        GROUP BY g.p ORDER BY g.p`,
    db.$queryRaw<{ product_id: number | null; name: string; qty: number; revenue: number }[]>`
        SELECT p."id" AS product_id, COALESCE(p."name_en", i."product_name") AS name,
               sum(i."qty")::int AS qty, sum(i."line_total")::int AS revenue
        FROM "order_items" i
        JOIN "orders" o ON o."id" = i."order_id"
        LEFT JOIN "product_variants" v ON v."id" = i."variant_id"
        LEFT JOIN "products" p ON p."id" = v."product_id"
        WHERE ${COUNTED} AND ${inRange}
        GROUP BY 1, 2 ORDER BY revenue DESC, qty DESC LIMIT 15`,
    db.$queryRaw<{ name: string; orders: number; qty: number; revenue: number }[]>`
        SELECT COALESCE(c."name_en", 'Deleted products') AS name, count(DISTINCT o."id")::int AS orders,
               sum(i."qty")::int AS qty, sum(i."line_total")::int AS revenue
        FROM "order_items" i
        JOIN "orders" o ON o."id" = i."order_id"
        LEFT JOIN "product_variants" v ON v."id" = i."variant_id"
        LEFT JOIN "products" p ON p."id" = v."product_id"
        LEFT JOIN "categories" c ON c."id" = p."category_id"
        WHERE ${COUNTED} AND ${inRange}
        GROUP BY 1 ORDER BY revenue DESC`,
    db.$queryRaw<{ source: string; orders: number; revenue: number }[]>`
        SELECT o."source", count(*)::int AS orders, COALESCE(sum(o."total"), 0)::int AS revenue
        FROM "orders" o WHERE ${COUNTED} AND ${inRange}
        GROUP BY 1 ORDER BY revenue DESC`,
    db.$queryRaw<{ status: string; orders: number; total: number }[]>`
        SELECT o."status"::text AS status, count(*)::int AS orders, COALESCE(sum(o."total"), 0)::int AS total
        FROM "orders" o WHERE ${inRange} GROUP BY 1`,
    db.$queryRaw<{ method: string; status: string; stage: string; orders: number; total: number }[]>`
        SELECT o."payment_method"::text AS method, o."payment_status"::text AS status,
               CASE WHEN o."status" = 'shipped' THEN 'with_courier'
                    WHEN o."status" IN ('pending', 'confirmed', 'processing') THEN 'not_shipped'
                    ELSE o."status"::text END AS stage,
               count(*)::int AS orders, COALESCE(sum(o."total"), 0)::int AS total
        FROM "orders" o WHERE ${inRange} GROUP BY 1, 2, 3`,
    db.$queryRaw<{ code: string; uses: number; saved: number; revenue: number }[]>`
        SELECT r."coupon_id"::text AS id, c."code", count(*)::int AS uses, sum(r."amount")::int AS saved,
               COALESCE(sum(o."total"), 0)::int AS revenue
        FROM "coupon_redemptions" r
        JOIN "coupons" c ON c."id" = r."coupon_id"
        JOIN "orders" o ON o."id" = r."order_id"
        WHERE ${inRange}
        GROUP BY 1, 2 ORDER BY uses DESC, saved DESC LIMIT 10`,
    db.$queryRaw<{ courier: string; state: string; parcels: number; fees: number; cod: number }[]>`
        SELECT s."courier", s."state"::text AS state, count(*)::int AS parcels,
               COALESCE(sum(s."delivery_fee"), 0)::int AS fees, COALESCE(sum(s."cod_amount"), 0)::int AS cod
        FROM "shipments" s
        WHERE s."created_at" >= ${start} AND s."created_at" < ${end}
        GROUP BY 1, 2`,
    db.$queryRaw<{ courier: string; hours: number | null }[]>`
        SELECT s."courier", avg(extract(epoch FROM (d.at - s."created_at")) / 3600)::float AS hours
        FROM "shipments" s
        JOIN LATERAL (
          SELECT min(e."created_at") AS at FROM "shipment_events" e
          WHERE e."shipment_id" = s."id" AND e."courier_status" IN ('delivered', 'payment_invoice')
        ) d ON d.at IS NOT NULL
        WHERE s."state" = 'delivered' AND s."created_at" >= ${start} AND s."created_at" < ${end}
        GROUP BY 1`,
  ]);

  const pct = (now: number, before: number) => (before ? Math.round(((now - before) / before) * 100) : null);
  const sum = <T>(rows: T[], f: (r: T) => number) => rows.reduce((a, r) => a + f(r), 0);

  // Cash on Delivery: collected (delivered and paid), with the courier, not yet shipped.
  const cod = payments.filter((p) => p.method === 'cod');
  const codStage = (stage: string) => ({
    orders: sum(
      cod.filter((p) => p.stage === stage),
      (p) => p.orders,
    ),
    amount: sum(
      cod.filter((p) => p.stage === stage),
      (p) => p.total,
    ),
  });
  const methods = [...new Set(payments.map((p) => p.method))].map((method) => {
    const rows = payments.filter(
      (p) => p.method === method && !['cancelled', 'returned', 'refunded'].includes(p.stage),
    );
    return {
      method,
      orders: sum(rows, (r) => r.orders),
      amount: sum(rows, (r) => r.total),
      paid: sum(
        rows.filter((r) => r.status === 'paid'),
        (r) => r.total,
      ),
    };
  });

  const couriers = [...new Set(shipments.map((s) => s.courier))].map((courier) => {
    const rows = shipments.filter((s) => s.courier === courier);
    const count = (state: string) =>
      sum(
        rows.filter((r) => r.state === state),
        (r) => r.parcels,
      );
    const live = rows.filter((r) => r.state !== 'cancelled');
    const delivered = count('delivered');
    const returned = count('returned');
    const hours = deliveryTime.find((d) => d.courier === courier)?.hours ?? null;
    return {
      courier,
      booked: sum(live, (r) => r.parcels),
      inTransit: count('active') + count('booking'),
      delivered,
      returned,
      cancelled: count('cancelled'),
      successRate: delivered + returned ? Math.round((delivered / (delivered + returned)) * 100) : null,
      fees: sum(live, (r) => r.fees),
      codBooked: sum(live, (r) => r.cod),
      averageDays: hours === null ? null : Math.round((hours / 24) * 10) / 10,
    };
  });

  return {
    range: { from: range.from, to: range.to, days: range.days, bucket: range.bucket },
    previous: { from: range.prevFrom, to: range.prevTo, orders: previous.orders, revenue: previous.revenue },
    summary: {
      ...current,
      revenueChange: pct(current.revenue, previous.revenue),
      ordersChange: pct(current.orders, previous.orders),
    },
    series: series.map((s) => ({ day: s.period, orders: s.orders, revenue: s.revenue })),
    products: products.map((p) => ({ productId: p.product_id, name: p.name, qty: p.qty, revenue: p.revenue })),
    categories,
    sources,
    statuses: statuses.map((s) => ({ status: s.status, orders: s.orders, total: s.total })),
    payments: {
      methods,
      cod: {
        collected: codStage('delivered'),
        withCourier: codStage('with_courier'),
        notShipped: codStage('not_shipped'),
      },
    },
    coupons: coupons.map((c) => ({ code: c.code, uses: c.uses, saved: c.saved, revenue: c.revenue })),
    couriers,
  };
}
