import type { z } from 'zod';
import type { AdminUser, OrderStatus, Prisma } from '../generated/prisma/client.js';
import { audit } from '../lib/audit.js';
import { ApiError } from '../lib/errors.js';
import type { Db } from '../lib/prisma.js';
import { getSettings } from '../lib/settings.js';
import type { AdminOrderDetail, AdminOrderList, OrderEditBody, OrderListQuery } from '../schemas/admin-orders.js';
import { trackUrl } from './checkout.js';
import { deliveryFee, resolveArea } from './delivery.js';
import { orderCancelledSms, orderConfirmedSms, orderShippedSms } from './sms/templates.js';

/** Which status an order may move to next. Everything else is refused. */
export const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered', 'returned'],
  delivered: ['returned'],
  returned: ['refunded'],
  cancelled: [],
  refunded: [],
};
const EDITABLE: OrderStatus[] = ['pending', 'confirmed'];
const OPEN: OrderStatus[] = ['pending', 'confirmed', 'processing'];

const dhakaDay = (day: string, plusDays = 0) => {
  const d = new Date(`${day}T00:00:00+06:00`);
  d.setUTCDate(d.getUTCDate() + plusDays);
  return d;
};

function listWhere(q: z.infer<typeof OrderListQuery>, withStatus = true): Prisma.OrderWhereInput {
  const term = q.q?.trim();
  return {
    ...(withStatus && q.status && { status: q.status === 'open' ? { in: OPEN } : q.status }),
    ...(q.paymentStatus && { paymentStatus: q.paymentStatus }),
    ...((q.from || q.to) && {
      createdAt: { ...(q.from && { gte: dhakaDay(q.from) }), ...(q.to && { lt: dhakaDay(q.to, 1) }) },
    }),
    ...(term && {
      OR: [
        { orderNo: { contains: term, mode: 'insensitive' } },
        { phone: { contains: term.replace(/[\s-]/g, '').replace(/^\+?88(?=01)/, '') } },
        { name: { contains: term, mode: 'insensitive' } },
      ],
    }),
  };
}

const rowSelect = {
  orderNo: true,
  createdAt: true,
  name: true,
  phone: true,
  districtName: true,
  areaName: true,
  total: true,
  status: true,
  paymentStatus: true,
  paymentMethod: true,
  source: true,
  items: { select: { qty: true } },
} satisfies Prisma.OrderSelect;

const toRow = (o: Prisma.OrderGetPayload<{ select: typeof rowSelect }>) => ({
  orderNo: o.orderNo,
  createdAt: o.createdAt.toISOString(),
  name: o.name,
  phone: o.phone,
  district: o.districtName,
  area: o.areaName,
  itemCount: o.items.reduce((a, i) => a + i.qty, 0),
  total: o.total,
  status: o.status,
  paymentStatus: o.paymentStatus,
  paymentMethod: o.paymentMethod,
  source: o.source,
});

export async function listOrders(db: Db, q: z.infer<typeof OrderListQuery>): Promise<z.infer<typeof AdminOrderList>> {
  const where = listWhere(q);
  const [rows, total, grouped] = await Promise.all([
    db.order.findMany({
      where,
      orderBy: { id: 'desc' },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      select: rowSelect,
    }),
    db.order.count({ where }),
    db.order.groupBy({ by: ['status'], where: listWhere(q, false), _count: { _all: true } }),
  ]);
  const counts: Record<string, number> = {};
  for (const g of grouped) counts[g.status] = g._count._all;
  return { items: rows.map(toRow), total, page: q.page, limit: q.limit, counts };
}

const csvCell = (v: unknown) => {
  const s = String(v ?? '');
  // Quote everything, and stop spreadsheet apps from running a cell as a formula.
  return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

/** CSV of the orders matching a search (newest first, at most 5,000). */
export async function exportOrdersCsv(db: Db, q: z.infer<typeof OrderListQuery>) {
  const rows = await db.order.findMany({ where: listWhere(q), orderBy: { id: 'desc' }, take: 5000, select: rowSelect });
  const header = [
    'Order',
    'Placed',
    'Name',
    'Phone',
    'District',
    'Area',
    'Items',
    'Total',
    'Status',
    'Payment',
    'Method',
    'Source',
  ];
  const lines = rows
    .map(toRow)
    .map((r) =>
      [
        r.orderNo,
        r.createdAt,
        r.name,
        r.phone,
        r.district,
        r.area,
        r.itemCount,
        r.total,
        r.status,
        r.paymentStatus,
        r.paymentMethod,
        r.source,
      ]
        .map(csvCell)
        .join(','),
    );
  // A byte-order mark first, so Excel reads the file as UTF-8 (Bangla names, ৳).
  return String.fromCharCode(0xfeff) + [header.map(csvCell).join(','), ...lines].join('\r\n') + '\r\n';
}

const who = (a: { name: string } | null, actor?: string) =>
  a?.name ?? (actor === 'customer' ? 'Customer' : (actor ?? 'System'));

async function findOrder(db: Pick<Db, 'order'>, orderNo: string) {
  const order = await db.order.findUnique({ where: { orderNo: orderNo.toUpperCase() } });
  if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  return order;
}

export async function getOrderDetail(db: Db, orderNo: string): Promise<z.infer<typeof AdminOrderDetail>> {
  const o = await db.order.findUnique({
    where: { orderNo: orderNo.toUpperCase() },
    include: {
      items: { orderBy: { id: 'asc' } },
      history: { orderBy: { createdAt: 'asc' } },
      staffNotes: { orderBy: { createdAt: 'desc' }, include: { admin: { select: { name: true } } } },
      smsMessages: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!o) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found.');

  // Names for "admin:<id>" actors in the history.
  const adminIds = [
    ...new Set(
      o.history
        .map((h) => /^admin:(\d+)$/.exec(h.actor)?.[1])
        .filter(Boolean)
        .map(Number),
    ),
  ];
  const admins = new Map(
    (await db.adminUser.findMany({ where: { id: { in: adminIds } }, select: { id: true, name: true } })).map((a) => [
      `admin:${a.id}`,
      a,
    ]),
  );
  const byStatus = await db.order.groupBy({
    by: ['status'],
    where: { customerId: o.customerId },
    _count: { _all: true },
    _sum: { total: true },
  });
  const count = (s: OrderStatus) => byStatus.find((g) => g.status === s)?._count._all ?? 0;

  return {
    orderNo: o.orderNo,
    createdAt: o.createdAt.toISOString(),
    status: o.status,
    paymentStatus: o.paymentStatus,
    paymentMethod: o.paymentMethod,
    source: o.source,
    allowedTransitions: TRANSITIONS[o.status].filter((s) => s !== 'refunded' || o.paymentStatus === 'paid'),
    editable: EDITABLE.includes(o.status),
    customer: {
      name: o.name,
      phone: o.phone,
      orders: byStatus.reduce((a, g) => a + g._count._all, 0),
      delivered: count('delivered'),
      cancelled: count('cancelled'),
      returned: count('returned'),
      spent: byStatus.find((g) => g.status === 'delivered')?._sum.total ?? 0,
    },
    address: {
      division: o.divisionName,
      district: o.districtName,
      area: o.areaName,
      areaId: o.areaId,
      line: o.addressLine,
      zone: o.zoneKey,
    },
    notes: o.notes,
    items: o.items.map((i) => ({
      sku: i.sku,
      name: i.productName,
      label: i.label,
      unitPrice: i.unitPrice,
      qty: i.qty,
      lineTotal: i.lineTotal,
    })),
    subtotal: o.subtotal,
    discount: o.discount,
    deliveryFee: o.deliveryFee,
    total: o.total,
    history: o.history.map((h) => ({
      from: h.fromStatus,
      to: h.toStatus,
      note: h.note,
      by: who(admins.get(h.actor) ?? null, h.actor),
      at: h.createdAt.toISOString(),
    })),
    staffNotes: o.staffNotes.map((n) => ({ id: n.id, body: n.body, by: who(n.admin), at: n.createdAt.toISOString() })),
    sms: o.smsMessages.map((m) => ({
      template: m.template,
      status: m.status,
      at: m.createdAt.toISOString(),
      sentAt: m.sentAt?.toISOString() ?? null,
    })),
    ip: o.ip,
  };
}

interface ActionContext {
  admin: AdminUser;
  ip: string;
  storefrontUrl: string;
}

/**
 * Moves an order to its next status. Cancelling puts the items back in stock; so does a return
 * unless `restock` is off (damaged goods). A delivered Cash on Delivery order counts as paid.
 * The change, the stock movements, the customer SMS and the audit entry commit together.
 */
export async function changeStatus(
  db: Db,
  orderNo: string,
  input: { to: OrderStatus; note?: string; restock: boolean },
  ctx: ActionContext,
) {
  const order = await findOrder(db, orderNo);
  const allowed = TRANSITIONS[order.status];
  if (!allowed.includes(input.to))
    throw new ApiError(409, 'INVALID_TRANSITION', `An order that is ${order.status} can't be marked ${input.to}.`, {
      allowed,
    });
  if (input.to === 'refunded' && order.paymentStatus !== 'paid')
    throw new ApiError(409, 'INVALID_TRANSITION', 'Only a paid order can be refunded.');

  const settings = await getSettings(db);
  const link = trackUrl(ctx.storefrontUrl, order.orderNo);
  const sms =
    input.to === 'confirmed'
      ? orderConfirmedSms({ orderNo: order.orderNo, trackUrl: link })
      : input.to === 'shipped'
        ? orderShippedSms({
            orderNo: order.orderNo,
            codDue: order.paymentMethod === 'cod' && order.paymentStatus !== 'paid' ? order.total : undefined,
            trackUrl: link,
          })
        : input.to === 'cancelled'
          ? orderCancelledSms({ orderNo: order.orderNo, hotline: settings.hotline })
          : null;
  const restock = input.to === 'cancelled' || (input.to === 'returned' && input.restock);

  await db.$transaction(async (tx) => {
    // Only succeeds if nobody else changed the status in the meantime.
    const { count } = await tx.order.updateMany({
      where: { id: order.id, status: order.status },
      data: {
        status: input.to,
        ...(input.to === 'delivered' && order.paymentMethod === 'cod' && { paymentStatus: 'paid' }),
        ...(input.to === 'refunded' && { paymentStatus: 'refunded' }),
      },
    });
    if (count === 0)
      throw new ApiError(409, 'ORDER_CHANGED', 'Someone else just updated this order. Reload and try again.');

    await tx.orderStatusHistory.create({
      data: {
        orderId: order.id,
        fromStatus: order.status,
        toStatus: input.to,
        note: input.note || null,
        actor: `admin:${ctx.admin.id}`,
      },
    });
    if (restock) {
      const items = await tx.orderItem.findMany({ where: { orderId: order.id, variantId: { not: null } } });
      for (const i of items) {
        await tx.productVariant.update({ where: { id: i.variantId! }, data: { stock: { increment: i.qty } } });
        await tx.inventoryMovement.create({
          data: {
            variantId: i.variantId!,
            change: i.qty,
            reason: `order ${input.to}`,
            orderId: order.id,
            adminId: ctx.admin.id,
          },
        });
      }
    }
    if (sms)
      await tx.smsMessage.create({
        data: { to: order.phone, body: sms, template: `order_${input.to}`, orderId: order.id },
      });
    await audit(tx, {
      adminId: ctx.admin.id,
      action: 'order.status',
      entityType: 'order',
      entityId: order.orderNo,
      data: { from: order.status, to: input.to, restocked: restock, ...(input.note && { note: input.note }) },
      ip: ctx.ip,
    });
  });
  return getOrderDetail(db, order.orderNo);
}

export async function addNote(db: Db, orderNo: string, body: string, ctx: ActionContext) {
  const order = await findOrder(db, orderNo);
  await db.$transaction(async (tx) => {
    await tx.orderNote.create({ data: { orderId: order.id, adminId: ctx.admin.id, body } });
    await audit(tx, {
      adminId: ctx.admin.id,
      action: 'order.note',
      entityType: 'order',
      entityId: order.orderNo,
      ip: ctx.ip,
    });
  });
  return getOrderDetail(db, order.orderNo);
}

/**
 * Corrects contact or address details before the order is packed. A new area re-prices delivery
 * with the order's own subtotal (so the free-delivery threshold still applies).
 */
export async function editOrder(db: Db, orderNo: string, input: z.infer<typeof OrderEditBody>, ctx: ActionContext) {
  const order = await findOrder(db, orderNo);
  if (!EDITABLE.includes(order.status))
    throw new ApiError(409, 'NOT_EDITABLE', 'Contact and address can only be changed before the order is packed.');

  const data: Prisma.OrderUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.phone !== undefined) data.phone = input.phone;
  if (input.addressLine !== undefined) data.addressLine = input.addressLine;
  if (input.notes !== undefined) data.notes = input.notes || null;
  if (input.areaId !== undefined && input.areaId !== order.areaId) {
    const { area, district, division, zone } = await resolveArea(db, input.areaId);
    const settings = await getSettings(db);
    const fee = deliveryFee(order.subtotal, zone.fee, settings.free_delivery_threshold);
    Object.assign(data, {
      areaId: area.id,
      areaName: area.nameEn,
      districtName: district.nameEn,
      divisionName: division.nameEn,
      zoneKey: zone.key,
      deliveryFee: fee,
      total: order.subtotal - order.discount + fee,
    });
  }
  const before = Object.fromEntries(Object.keys(data).map((k) => [k, (order as Record<string, unknown>)[k] ?? null]));
  await db.$transaction(async (tx) => {
    await tx.order.update({ where: { id: order.id }, data });
    await audit(tx, {
      adminId: ctx.admin.id,
      action: 'order.edit',
      entityType: 'order',
      entityId: order.orderNo,
      data: { before, after: data } as Prisma.InputJsonValue,
      ip: ctx.ip,
    });
  });
  return getOrderDetail(db, order.orderNo);
}
