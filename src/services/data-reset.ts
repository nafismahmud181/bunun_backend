import type { z } from 'zod';
import type { AdminUser } from '../generated/prisma/client.js';
import { audit } from '../lib/audit.js';
import { sha256 } from '../lib/crypto.js';
import type { Db } from '../lib/prisma.js';
import type { DataResetBody } from '../schemas/data-reset.js';
import { deleteImage } from './images.js';
import type { ImageStore } from './storage.js';

interface Context {
  admin: AdminUser;
  ip: string;
  /** The caller's own session stays signed in. */
  sessionToken: string;
}

type Parts = Omit<z.infer<typeof DataResetBody>, 'code' | 'confirm'>;

/**
 * Danger zone: deletes test data (orders, customers, coupons, audit log, sessions) in one
 * transaction. The catalogue, settings, zones, content, block list and staff accounts are never
 * touched. Stock taken by deleted orders is put back, and order numbers restart at 1 once no
 * orders are left. The caller has already confirmed with a fresh two-factor code.
 */
export async function resetData(db: Db, images: ImageStore | null, parts: Parts, ctx: Context) {
  const deleted = {
    orders: 0,
    shipments: 0,
    smsMessages: 0,
    reviews: 0,
    customers: 0,
    carts: 0,
    coupons: 0,
    auditEntries: 0,
    sessions: 0,
    stockReturned: 0,
  };
  let reviewImages: string[] = [];
  let orderNumbersRestarted = false;

  await db.$transaction(
    async (tx) => {
      if (parts.orders) {
        // Net stock each order still holds: its sale (negative) plus any restock on cancel or return.
        const held = await tx.inventoryMovement.groupBy({
          by: ['variantId'],
          where: { orderId: { not: null } },
          _sum: { change: true },
        });
        for (const h of held) {
          const back = -(h._sum.change ?? 0);
          if (back === 0) continue;
          await tx.productVariant.update({ where: { id: h.variantId }, data: { stock: { increment: back } } });
          deleted.stockReturned += back;
        }
        await tx.inventoryMovement.deleteMany({ where: { orderId: { not: null } } });

        reviewImages = (await tx.reviewImage.findMany({ select: { url: true } })).map((i) => i.url);
        deleted.reviews = (await tx.review.deleteMany()).count;
        deleted.smsMessages = (await tx.smsMessage.deleteMany()).count;
        deleted.shipments = await tx.shipment.count();
        // Items, status history, notes, shipments and coupon redemptions go with their order.
        deleted.orders = (await tx.order.deleteMany()).count;
        await tx.coupon.updateMany({ data: { usedCount: 0 } });
      }

      if (parts.customers) {
        deleted.carts = (await tx.cart.deleteMany()).count;
        // Customers who still have orders (when orders are kept) stay.
        deleted.customers = (await tx.customer.deleteMany({ where: { orders: { none: {} } } })).count;
      }

      if (parts.coupons) deleted.coupons = (await tx.coupon.deleteMany()).count;

      if (parts.sessions)
        deleted.sessions = (
          await tx.adminSession.deleteMany({ where: { tokenHash: { not: sha256(ctx.sessionToken) } } })
        ).count;

      if (parts.auditLog) deleted.auditEntries = (await tx.auditLog.deleteMany()).count;

      if ((await tx.order.count()) === 0) {
        await tx.$executeRaw`ALTER SEQUENCE order_no_seq RESTART WITH 1`;
        orderNumbersRestarted = true;
      }

      // Written last, so it survives an audit-log reset and records what was removed.
      await audit(tx, {
        adminId: ctx.admin.id,
        action: 'data.reset',
        data: { parts, deleted, orderNumbersRestarted },
        ip: ctx.ip,
      });
    },
    { timeout: 120_000 },
  );

  // Review photos live in storage; remove them once the database change is safe.
  if (images && reviewImages.length) await Promise.allSettled(reviewImages.map((url) => deleteImage(images, url)));

  return { deleted, orderNumbersRestarted };
}
