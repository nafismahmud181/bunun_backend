import type { FastifyBaseLogger } from 'fastify';
import type { AdminUser, Prisma, Shipment } from '../generated/prisma/client.js';
import { audit } from '../lib/audit.js';
import { ApiError } from '../lib/errors.js';
import type { Db } from '../lib/prisma.js';
import { changeStatus } from './admin-orders.js';
import { type CourierDriver, CourierError, type Stage } from './courier/index.js';

interface Context {
  admin: AdminUser;
  ip: string;
  storefrontUrl: string;
}

/** A booking in progress, or one that is live at the courier, blocks booking the order again. */
const BLOCKING = ['booking', 'active', 'delivered', 'returned'] as const;

const orderWithItems = {
  items: { include: { variant: { select: { weightGrams: true } } } },
} satisfies Prisma.OrderInclude;

/** What the courier needs for this order: address, COD amount, weight from the options' shipping weights. */
export async function parcelDefaults(db: Db, orderNo: string) {
  const o = await db.order.findUnique({ where: { orderNo: orderNo.toUpperCase() }, include: orderWithItems });
  if (!o) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  const grams = o.items.reduce((a, i) => a + (i.variant?.weightGrams ?? 0) * i.qty, 0);
  const missingWeight = o.items.some((i) => !i.variant?.weightGrams);
  return {
    order: o,
    weightKg: Math.min(10, Math.max(0.5, Math.round((grams / 1000) * 10) / 10)),
    weightKnown: grams > 0 && !missingWeight,
    codAmount: o.paymentStatus === 'paid' ? 0 : o.total,
    address: [o.addressLine, o.areaName, o.districtName].filter(Boolean).join(', '),
    itemQuantity: o.items.reduce((a, i) => a + i.qty, 0),
    description: o.items
      .map((i) => `${i.qty} × ${i.productName}${i.label ? ` (${i.label})` : ''}`)
      .join(', ')
      .slice(0, 250),
  };
}

async function addEvent(
  tx: Prisma.TransactionClient | Db,
  shipmentId: number,
  status: string,
  label: string,
  source: string,
) {
  await tx.shipmentEvent.create({ data: { shipmentId, courierStatus: status, label, source } });
}

/**
 * Books the order with the courier. The order row is locked while the booking row is written, so
 * two clicks (or two staff) can't both book: the courier itself doesn't reject duplicates. If the
 * courier doesn't answer, the booking stays "booking" (unknown) until staff check the courier's
 * panel and clear it, rather than risk a second parcel.
 */
export async function bookShipment(
  db: Db,
  courier: CourierDriver | null,
  orderNo: string,
  input: { weightKg?: number; note?: string },
  ctx: Context,
) {
  if (!courier) throw new ApiError(503, 'COURIER_OFF', 'Courier booking is not set up on the server.');
  const d = await parcelDefaults(db, orderNo);
  if (!['confirmed', 'processing'].includes(d.order.status))
    throw new ApiError(409, 'NOT_READY', 'Book a courier once the order is confirmed (and packed).');
  const weightKg = input.weightKg ?? d.weightKg;

  const shipment = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${d.order.id} FOR UPDATE`;
    const existing = await tx.shipment.findFirst({
      where: { orderId: d.order.id, state: { in: [...BLOCKING] } },
    });
    if (existing)
      throw new ApiError(
        409,
        'ALREADY_BOOKED',
        existing.state === 'booking'
          ? 'A booking for this order is still waiting for the courier. Check the courier panel before booking again.'
          : `This order is already booked (${existing.consignmentId}).`,
      );
    return tx.shipment.create({
      data: {
        orderId: d.order.id,
        courier: courier.name,
        codAmount: d.codAmount,
        weightKg,
        note: input.note?.trim() || null,
        bookedById: ctx.admin.id,
      },
    });
  });

  let booked;
  try {
    booked = await courier.book({
      merchantOrderId: d.order.orderNo,
      name: d.order.name,
      phone: d.order.phone,
      address: d.address,
      codAmount: d.codAmount,
      weightKg,
      itemQuantity: d.itemQuantity,
      description: d.description,
      instruction: [d.order.notes, input.note].filter((x) => x?.trim()).join(' · ') || undefined,
    });
  } catch (err) {
    if (err instanceof CourierError && err.kind === 'rejected') {
      await db.shipment.delete({ where: { id: shipment.id } }); // nothing was booked: free the order
      throw new ApiError(422, 'COURIER_REJECTED', err.message, err.fields && { fields: err.fields });
    }
    const message = err instanceof Error ? err.message : String(err);
    await db.shipment.update({ where: { id: shipment.id }, data: { lastError: message.slice(0, 500) } });
    throw new ApiError(
      502,
      'COURIER_UNKNOWN',
      `${courier.label} didn't confirm the booking (${message}). Check the ${courier.label} merchant panel: if the parcel isn't there, choose "It wasn't booked" and try again.`,
    );
  }

  await db.$transaction(async (tx) => {
    await tx.shipment.update({
      where: { id: shipment.id },
      data: {
        state: 'active',
        consignmentId: booked.consignmentId,
        courierStatus: booked.status,
        statusLabel: booked.statusLabel,
        deliveryFee: booked.deliveryFee,
        lastError: null,
        checkedAt: new Date(),
      },
    });
    await addEvent(tx, shipment.id, booked.status, booked.statusLabel, 'booking');
    await audit(tx, {
      adminId: ctx.admin.id,
      action: 'shipment.book',
      entityType: 'order',
      entityId: d.order.orderNo,
      data: { courier: courier.name, consignmentId: booked.consignmentId, codAmount: d.codAmount, weightKg },
      ip: ctx.ip,
    });
  });
  // Booking a confirmed order means it's packed and waiting for the rider.
  if (d.order.status === 'confirmed')
    await changeStatus(
      db,
      d.order.orderNo,
      { to: 'processing', note: `Booked with ${courier.label}`, restock: false },
      ctx,
    );
}

/**
 * Staff say a booking isn't live at the courier: a "booking" whose answer was lost and that
 * isn't in the courier's panel, or a parcel they cancelled there. The order can be booked again.
 */
export async function releaseShipment(db: Db, orderNo: string, shipmentId: number, ctx: Context) {
  const s = await db.shipment.findFirst({
    where: { id: shipmentId, order: { orderNo: orderNo.toUpperCase() } },
  });
  if (!s) throw new ApiError(404, 'NOT_FOUND', 'Shipment not found.');
  if (s.state !== 'booking' && s.state !== 'active')
    throw new ApiError(409, 'NOT_OPEN', 'Only an open booking can be cancelled here.');
  await db.$transaction(async (tx) => {
    await tx.shipment.update({ where: { id: s.id }, data: { state: 'cancelled' } });
    await addEvent(
      tx,
      s.id,
      'cancelled',
      s.state === 'booking' ? 'Marked as not booked' : 'Cancelled at the courier',
      'staff',
    );
    await audit(tx, {
      adminId: ctx.admin.id,
      action: 'shipment.cancel',
      entityType: 'order',
      entityId: orderNo.toUpperCase(),
      data: { shipmentId: s.id, consignmentId: s.consignmentId, was: s.state },
      ip: ctx.ip,
    });
  });
}

/** The order statuses a courier stage leads to, in the order they must happen. */
const STEPS: Record<Stage, ('shipped' | 'delivered' | 'returned')[]> = {
  booked: [],
  cancelled: [],
  picked_up: ['shipped'],
  delivered: ['shipped', 'delivered'],
  returned: ['shipped', 'returned'],
};

/**
 * Asks the courier for the parcel's status and applies it: records the change, and moves the order
 * along (picked up → shipped, delivered → delivered, returned → returned, with the usual SMS and
 * stock changes). Never trusts a webhook body: a webhook is only a hint to call this.
 */
export async function refreshShipment(
  db: Db,
  courier: CourierDriver,
  s: Shipment,
  source: 'webhook' | 'sync' | 'staff',
  storefrontUrl: string,
  log?: FastifyBaseLogger,
) {
  if (!s.consignmentId || s.state !== 'active') return s;
  const now = await courier.status(s.consignmentId);
  const stage = courier.stage(now.status);
  const changed = now.status !== s.courierStatus;
  const state =
    stage === 'delivered'
      ? 'delivered'
      : stage === 'returned'
        ? 'returned'
        : stage === 'cancelled'
          ? 'cancelled'
          : 'active';
  const updated = await db.$transaction(async (tx) => {
    const u = await tx.shipment.update({
      where: { id: s.id },
      data: { courierStatus: now.status, statusLabel: now.statusLabel, state, checkedAt: new Date(), lastError: null },
    });
    if (changed) await addEvent(tx, s.id, now.status, now.statusLabel, source);
    return u;
  });
  if (!changed) return updated;

  const order = await db.order.findUniqueOrThrow({ where: { id: s.orderId }, select: { id: true, orderNo: true } });
  for (const to of STEPS[stage]) {
    const { status: current } = await db.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } });
    if (current === to || (to === 'shipped' && ['delivered', 'returned', 'refunded'].includes(current))) continue;
    try {
      await changeStatus(
        db,
        order.orderNo,
        { to, note: `${courier.label}: ${now.statusLabel}`, restock: to === 'returned' },
        { admin: null, actor: `courier:${courier.name}`, storefrontUrl },
      );
    } catch (err) {
      // e.g. staff cancelled the order meanwhile: keep the courier status, leave the order alone
      log?.warn({ err, orderNo: order.orderNo, to }, 'courier status not applied to the order');
      break;
    }
  }
  return updated;
}

/** Refresh one parcel by the courier's consignment ID (webhook). Unknown IDs are ignored. */
// Anyone can call the webhook with a consignment id (they're on the public tracking page), so a
// parcel is checked with Pathao at most once per WEBHOOK_MIN_GAP_MS from webhook calls; a flood
// can't use up the API quota. Kept per process (it's only a brake), and only for webhooks: the
// regular sync never delays a real update that arrives just after it.
const WEBHOOK_MIN_GAP_MS = 10_000;
const lastWebhookCheck = new Map<string, number>();

export async function refreshByConsignment(
  db: Db,
  courier: CourierDriver,
  consignmentId: string,
  storefrontUrl: string,
  log?: FastifyBaseLogger,
) {
  const now = Date.now();
  if (now - (lastWebhookCheck.get(consignmentId) ?? 0) < WEBHOOK_MIN_GAP_MS) return false;
  if (lastWebhookCheck.size > 5000)
    for (const [id, at] of lastWebhookCheck) if (now - at >= WEBHOOK_MIN_GAP_MS) lastWebhookCheck.delete(id);
  lastWebhookCheck.set(consignmentId, now); // before any await, so calls arriving together see it
  const s = await db.shipment.findUnique({ where: { consignmentId } });
  if (!s) return false;
  await refreshShipment(db, courier, s, 'webhook', storefrontUrl, log);
  return true;
}

/** Checks open parcels not looked at for `everyMinutes`, a batch at a time. */
export async function syncShipments(
  db: Db,
  courier: CourierDriver,
  everyMinutes: number,
  storefrontUrl: string,
  log: FastifyBaseLogger,
) {
  const due = await db.shipment.findMany({
    where: {
      state: 'active',
      courier: courier.name,
      OR: [{ checkedAt: null }, { checkedAt: { lt: new Date(Date.now() - everyMinutes * 60_000) } }],
    },
    orderBy: { checkedAt: 'asc' },
    take: 25,
  });
  for (const s of due) {
    try {
      await refreshShipment(db, courier, s, 'sync', storefrontUrl, log);
    } catch (err) {
      log.warn({ err, shipmentId: s.id }, 'courier status check failed');
      await db.shipment.update({
        where: { id: s.id },
        data: { checkedAt: new Date(), lastError: (err as Error).message.slice(0, 500) },
      });
    }
  }
  return due.length;
}

/** Runs syncShipments every minute (each parcel is checked every `everyMinutes`). */
export function startCourierSync(
  db: Db,
  courier: CourierDriver,
  everyMinutes: number,
  storefrontUrl: string,
  log: FastifyBaseLogger,
) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await syncShipments(db, courier, everyMinutes, storefrontUrl, log);
    } catch (err) {
      log.error({ err }, 'courier sync failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, 60_000);
  return () => clearInterval(timer);
}
