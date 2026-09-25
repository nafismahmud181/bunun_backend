import type { z } from 'zod';
import type { Db } from '../lib/prisma.js';
import type { TrackedOrder } from '../schemas/orders.js';

/**
 * An order for the public track page. The phone number must match, and a wrong number gets the
 * same "not found" as a wrong order number, so the page can't be used to discover orders.
 * Name and street address are never returned.
 */
export async function trackOrder(db: Db, orderNo: string, phone: string): Promise<z.infer<typeof TrackedOrder> | null> {
  const o = await db.order.findUnique({
    where: { orderNo: orderNo.toUpperCase() },
    include: { items: { orderBy: { id: 'asc' } }, history: { orderBy: { createdAt: 'asc' } } },
  });
  if (!o || o.phone !== phone) return null;
  return {
    orderNo: o.orderNo,
    status: o.status,
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
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
    district: o.districtName,
    area: o.areaName,
    history: o.history.map((h) => ({ status: h.toStatus, at: h.createdAt.toISOString() })),
  };
}
