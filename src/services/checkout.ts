import type { z } from 'zod';
import { Prisma } from '../generated/prisma/client.js';
import { ApiError } from '../lib/errors.js';
import type { Db } from '../lib/prisma.js';
import { getSettings } from '../lib/settings.js';
import type { CheckoutBody, OrderReceipt } from '../schemas/orders.js';
import { findCart } from './cart.js';
import { deliveryFee, resolveArea } from './delivery.js';
import { orderPlacedSms } from './sms/templates.js';

export interface CheckoutContext {
  cartToken: string;
  idempotencyKey: string;
  ip: string;
  userAgent?: string;
  storefrontUrl: string;
}

type Receipt = z.infer<typeof OrderReceipt>;

export const receiptInclude = { items: { orderBy: { id: 'asc' } } } satisfies Prisma.OrderInclude;

export function toReceipt(o: Prisma.OrderGetPayload<{ include: typeof receiptInclude }>): Receipt {
  return {
    orderNo: o.orderNo,
    status: o.status,
    paymentMethod: o.paymentMethod,
    phone: o.phone,
    items: o.items.map((i) => ({
      sku: i.sku,
      name: i.productName,
      label: i.label,
      qty: i.qty,
      lineTotal: i.lineTotal,
    })),
    subtotal: o.subtotal,
    deliveryFee: o.deliveryFee,
    total: o.total,
    createdAt: o.createdAt.toISOString(),
  };
}

export const trackUrl = (storefrontUrl: string, orderNo: string) =>
  `${storefrontUrl.replace(/\/$/, '')}/track?order=${encodeURIComponent(orderNo)}`;

/** Order number from the database sequence: BN-<year>-<6+ digits>. */
export async function nextOrderNo(tx: Prisma.TransactionClient) {
  const [row] = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('order_no_seq') AS n`;
  const year = new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka', year: 'numeric' });
  return `BN-${year}-${String(row!.n).padStart(6, '0')}`;
}

async function fraudChecks(db: Db, phone: string, ip: string) {
  const blocked = await db.blockedContact.findFirst({
    where: {
      OR: [
        { kind: 'phone', value: phone },
        { kind: 'ip', value: ip },
      ],
    },
  });
  const settings = await getSettings(db);
  if (blocked)
    throw new ApiError(
      403,
      'ORDER_BLOCKED',
      `We couldn't take this order online. Please call us on ${settings.hotline} to order.`,
    );
  const now = Date.now();
  const [byPhone, byIp] = await Promise.all([
    db.order.count({ where: { phone, createdAt: { gte: new Date(now - 24 * 3600_000) } } }),
    db.order.count({ where: { ip, createdAt: { gte: new Date(now - 3600_000) } } }),
  ]);
  if (byPhone >= settings.order_limit_per_phone_24h || byIp >= settings.order_limit_per_ip_1h)
    throw new ApiError(
      429,
      'TOO_MANY_ORDERS',
      `You've placed several orders recently. Please call us on ${settings.hotline} to order more.`,
    );
  return settings;
}

async function existingOrder(db: Db, idempotencyKey: string) {
  const o = await db.order.findUnique({ where: { idempotencyKey }, include: receiptInclude });
  return o ? toReceipt(o) : null;
}

/**
 * Places a Cash on Delivery order from the cart. Everything happens in one transaction: prices and
 * the delivery fee are recalculated here (nothing about money is taken from the browser), stock is
 * decremented atomically so two shoppers can't buy the last unit, and the confirmation SMS is
 * written to the outbox. Repeating the same idempotency key returns the first order.
 */
export async function placeOrder(
  db: Db,
  input: z.infer<typeof CheckoutBody>,
  ctx: CheckoutContext,
): Promise<{ receipt: Receipt; created: boolean }> {
  const repeat = await existingOrder(db, ctx.idempotencyKey);
  if (repeat) return { receipt: repeat, created: false };

  const found = await findCart(db, ctx.cartToken);
  if (!found) throw new ApiError(400, 'CART_EMPTY', 'Your cart is empty.');
  const cart = found;
  const settings = await fraudChecks(db, input.phone, ctx.ip);
  const { area, district, division, zone } = await resolveArea(db, input.areaId);

  for (let attempt = 1; ; attempt++) {
    try {
      const receipt = await createOrder();
      return { receipt, created: true };
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
      // Same idempotency key at the same moment: the loser returns the winner's order.
      const winner = await existingOrder(db, ctx.idempotencyKey);
      if (winner) return { receipt: winner, created: false };
      // Otherwise two first orders from one new phone number raced to create the customer; retry once.
      if (attempt >= 2) throw err;
    }
  }

  function createOrder() {
    return db.$transaction(
      async (tx) => {
        const lines = await tx.cartItem.findMany({
          where: { cartId: cart.id },
          orderBy: { addedAt: 'asc' },
          include: { variant: { include: { product: { include: { category: true } } } } },
        });
        if (!lines.length) throw new ApiError(400, 'CART_EMPTY', 'Your cart is empty.');

        const unavailable = lines.filter(
          (l) => l.variant.product.status !== 'active' || !l.variant.product.category.active,
        );
        if (unavailable.length)
          throw new ApiError(409, 'UNAVAILABLE', 'Some items are no longer available. Please review your cart.', {
            skus: unavailable.map((l) => l.variant.sku),
          });

        // Atomic stock decrement: the WHERE clause fails for a line when another order got there first.
        const short: string[] = [];
        for (const l of lines) {
          const { count } = await tx.productVariant.updateMany({
            where: { id: l.variantId, stock: { gte: l.qty } },
            data: { stock: { decrement: l.qty } },
          });
          if (count === 0) short.push(l.variant.sku);
        }
        if (short.length)
          throw new ApiError(
            409,
            'OUT_OF_STOCK',
            'Some items just sold out or have fewer left. Please review your cart.',
            {
              skus: short,
            },
          );

        const subtotal = lines.reduce((a, l) => a + l.variant.price * l.qty, 0);
        const fee = deliveryFee(subtotal, zone.fee, settings.free_delivery_threshold);
        const customer = await tx.customer.upsert({
          where: { phone: input.phone },
          create: { phone: input.phone, name: input.name },
          update: { name: input.name },
        });
        const orderNo = await nextOrderNo(tx);
        const order = await tx.order.create({
          data: {
            orderNo,
            customerId: customer.id,
            name: input.name,
            phone: input.phone,
            divisionName: division.nameEn,
            districtName: district.nameEn,
            areaName: area.nameEn,
            areaId: area.id,
            addressLine: input.address,
            zoneKey: zone.key,
            subtotal,
            deliveryFee: fee,
            total: subtotal + fee,
            paymentMethod: 'cod',
            notes: input.notes || null,
            ip: ctx.ip,
            userAgent: ctx.userAgent?.slice(0, 300),
            idempotencyKey: ctx.idempotencyKey,
            items: {
              create: lines.map((l) => ({
                variantId: l.variantId,
                sku: l.variant.sku,
                productName: l.variant.product.nameEn,
                label: l.variant.label,
                unitPrice: l.variant.price,
                qty: l.qty,
                lineTotal: l.variant.price * l.qty,
              })),
            },
            history: { create: { toStatus: 'pending', actor: 'customer', note: 'Placed online (Cash on Delivery)' } },
          },
          include: receiptInclude,
        });
        await tx.inventoryMovement.createMany({
          data: lines.map((l) => ({ variantId: l.variantId, change: -l.qty, reason: 'order', orderId: order.id })),
        });
        await tx.smsMessage.create({
          data: {
            to: input.phone,
            template: 'order_placed',
            body: orderPlacedSms({ orderNo, total: order.total, trackUrl: trackUrl(ctx.storefrontUrl, orderNo) }),
            orderId: order.id,
          },
        });
        await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
        await tx.cart.update({ where: { id: cart.id }, data: { customerId: customer.id } });
        return toReceipt(order);
      },
      { timeout: 15_000 },
    );
  }
}
