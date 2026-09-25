import type { z } from 'zod';
import { Prisma, type AdminUser } from '../generated/prisma/client.js';
import { audit } from '../lib/audit.js';
import { ApiError } from '../lib/errors.js';
import type { Db } from '../lib/prisma.js';
import { getSettings } from '../lib/settings.js';
import type { ManualOrderBody } from '../schemas/admin-3c.js';
import { nextOrderNo, receiptInclude, toReceipt, trackUrl } from './checkout.js';
import { deliveryFee, resolveArea } from './delivery.js';
import { manualOrderSms } from './sms/templates.js';

interface Context {
  admin: AdminUser;
  ip: string;
  storefrontUrl: string;
}

/**
 * An order staff took on Facebook, WhatsApp or by phone. Same rules as the website: catalogue
 * prices, zone delivery fee (free above the threshold), atomic stock decrement, sequence order
 * number, SMS. It starts as confirmed (staff already spoke to the customer). An optional
 * discount comes off the item total. Resending the same idempotency key returns the first order.
 */
export async function createManualOrder(db: Db, input: z.infer<typeof ManualOrderBody>, ctx: Context) {
  const existing = await db.order.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    include: receiptInclude,
  });
  if (existing) return { receipt: toReceipt(existing), created: false };

  // The same SKU twice in the list counts once, with the quantities added up.
  const qtyBySku = new Map<string, number>();
  for (const i of input.items) qtyBySku.set(i.sku, (qtyBySku.get(i.sku) ?? 0) + i.qty);
  const variants = await db.productVariant.findMany({
    where: { sku: { in: [...qtyBySku.keys()] } },
    include: { product: { select: { nameEn: true, status: true } } },
  });
  const unknown = [...qtyBySku.keys()].filter((s) => !variants.some((v) => v.sku === s));
  if (unknown.length) throw new ApiError(400, 'UNKNOWN_SKU', `Unknown SKU: ${unknown.join(', ')}`, { skus: unknown });
  const archived = variants.filter((v) => v.product.status === 'archived').map((v) => v.sku);
  if (archived.length)
    throw new ApiError(409, 'UNAVAILABLE', `Archived products can't be ordered: ${archived.join(', ')}`, {
      skus: archived,
    });

  const subtotal = variants.reduce((a, v) => a + v.price * qtyBySku.get(v.sku)!, 0);
  if (input.discount > subtotal) throw new ApiError(400, 'BAD_DISCOUNT', 'The discount is larger than the item total.');
  const { area, district, division, zone } = await resolveArea(db, input.areaId);
  const settings = await getSettings(db);
  // Free delivery is judged on what the customer pays for the items, after the discount.
  const fee = deliveryFee(subtotal - input.discount, zone.fee, settings.free_delivery_threshold);

  try {
    const order = await db.$transaction(
      async (tx) => {
        const short: string[] = [];
        for (const v of variants) {
          const qty = qtyBySku.get(v.sku)!;
          const { count } = await tx.productVariant.updateMany({
            where: { id: v.id, stock: { gte: qty } },
            data: { stock: { decrement: qty } },
          });
          if (!count) short.push(`${v.sku} (${v.stock} in stock)`);
        }
        if (short.length) throw new ApiError(409, 'OUT_OF_STOCK', `Not enough stock: ${short.join(', ')}`);

        const customer = await tx.customer.upsert({
          where: { phone: input.phone },
          create: { phone: input.phone, name: input.name },
          update: { name: input.name },
        });
        const orderNo = await nextOrderNo(tx);
        const total = subtotal - input.discount + fee;
        const created = await tx.order.create({
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
            discount: input.discount,
            deliveryFee: fee,
            total,
            status: 'confirmed',
            paymentMethod: 'cod',
            notes: input.notes || null,
            ip: ctx.ip,
            source: input.source,
            createdById: ctx.admin.id,
            idempotencyKey: input.idempotencyKey,
            items: {
              create: variants.map((v) => ({
                variantId: v.id,
                sku: v.sku,
                productName: v.product.nameEn,
                label: v.label,
                unitPrice: v.price,
                qty: qtyBySku.get(v.sku)!,
                lineTotal: v.price * qtyBySku.get(v.sku)!,
              })),
            },
            history: {
              create: {
                toStatus: 'confirmed',
                actor: `admin:${ctx.admin.id}`,
                note: `Manual order (${input.source})${input.discount ? `, discount ৳${input.discount}` : ''}`,
              },
            },
          },
          include: receiptInclude,
        });
        await tx.inventoryMovement.createMany({
          data: variants.map((v) => ({
            variantId: v.id,
            change: -qtyBySku.get(v.sku)!,
            reason: 'order',
            orderId: created.id,
            adminId: ctx.admin.id,
          })),
        });
        await tx.smsMessage.create({
          data: {
            to: input.phone,
            template: 'order_manual',
            body: manualOrderSms({ orderNo, total, trackUrl: trackUrl(ctx.storefrontUrl, orderNo) }),
            orderId: created.id,
          },
        });
        await audit(tx, {
          adminId: ctx.admin.id,
          action: 'order.manual_create',
          entityType: 'order',
          entityId: orderNo,
          ip: ctx.ip,
          data: { source: input.source, total, discount: input.discount },
        });
        return created;
      },
      { timeout: 15_000 },
    );
    return { receipt: toReceipt(order), created: true };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const again = await db.order.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        include: receiptInclude,
      });
      if (again) return { receipt: toReceipt(again), created: false };
    }
    throw err;
  }
}
