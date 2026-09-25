import type { z } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';
import { audit } from '../lib/audit.js';
import { ApiError } from '../lib/errors.js';
import type { Db } from '../lib/prisma.js';
import { getSettings } from '../lib/settings.js';
import type { InventoryQuery, MovementQuery, StockChange } from '../schemas/admin-catalogue.js';
import type { ActionContext } from './admin-catalogue.js';

export async function listInventory(db: Db, q: z.infer<typeof InventoryQuery>) {
  const { low_stock_threshold: threshold } = await getSettings(db);
  const term = q.q?.trim();
  const where: Prisma.ProductVariantWhereInput = {
    product: { status: { not: 'archived' } },
    ...(q.low && { stock: { lte: threshold } }),
    ...(term && {
      OR: [{ sku: { contains: term.toUpperCase() } }, { product: { nameEn: { contains: term, mode: 'insensitive' } } }],
    }),
  };
  const [rows, total] = await Promise.all([
    db.productVariant.findMany({
      where,
      orderBy: q.low ? [{ stock: 'asc' }, { id: 'asc' }] : [{ productId: 'asc' }, { sort: 'asc' }],
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      include: { product: { select: { id: true, nameEn: true, status: true } } },
    }),
    db.productVariant.count({ where }),
  ]);
  return {
    items: rows.map((v) => ({
      sku: v.sku,
      productId: v.product.id,
      productName: v.product.nameEn,
      productStatus: v.product.status,
      label: v.label,
      price: v.price,
      stock: v.stock,
      low: v.stock <= threshold,
    })),
    total,
    page: q.page,
    limit: q.limit,
    lowStockThreshold: threshold,
  };
}

/**
 * Adds or removes units (`change`), or records a stocktake count (`count`). The update is a
 * single atomic statement, so it can't race an order being placed, and a history row is written
 * with the reason and who did it. Stock can never go below zero.
 */
export async function changeStock(db: Db, input: z.infer<typeof StockChange>, ctx: ActionContext) {
  return db.$transaction(async (tx) => {
    const v = await tx.productVariant.findUnique({ where: { sku: input.sku } });
    if (!v) throw new ApiError(404, 'NOT_FOUND', `No variant with SKU ${input.sku}.`);
    let delta: number;
    if (input.count !== undefined) {
      // Stocktake: lock the row so the count and the delta agree.
      const [row] = await tx.$queryRaw<
        { stock: number }[]
      >`SELECT stock FROM product_variants WHERE id = ${v.id} FOR UPDATE`;
      delta = input.count - row!.stock;
      if (delta === 0) return { sku: v.sku, stock: row!.stock };
    } else delta = input.change!;

    const { count } = await tx.productVariant.updateMany({
      where: { id: v.id, ...(delta < 0 && { stock: { gte: -delta } }) },
      data: { stock: { increment: delta } },
    });
    if (count === 0) throw new ApiError(409, 'NOT_ENOUGH_STOCK', `Only ${v.stock} in stock; can't remove ${-delta}.`);
    await tx.inventoryMovement.create({
      data: { variantId: v.id, change: delta, reason: input.reason, adminId: ctx.admin.id },
    });
    await audit(tx, {
      adminId: ctx.admin.id,
      action: 'inventory.adjust',
      entityType: 'variant',
      entityId: v.sku,
      ip: ctx.ip,
      data: { change: delta, reason: input.reason },
    });
    const after = await tx.productVariant.findUniqueOrThrow({ where: { id: v.id }, select: { stock: true } });
    return { sku: v.sku, stock: after.stock };
  });
}

export async function listMovements(db: Db, q: z.infer<typeof MovementQuery>) {
  const where: Prisma.InventoryMovementWhereInput = q.sku ? { variant: { sku: q.sku.toUpperCase() } } : {};
  const [rows, total] = await Promise.all([
    db.inventoryMovement.findMany({
      where,
      orderBy: { id: 'desc' },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      include: {
        variant: { select: { sku: true, label: true, product: { select: { nameEn: true } } } },
        order: { select: { orderNo: true } },
      },
    }),
    db.inventoryMovement.count({ where }),
  ]);
  const adminIds = [...new Set(rows.map((r) => r.adminId).filter((id): id is number => id !== null))];
  const names = new Map(
    (await db.adminUser.findMany({ where: { id: { in: adminIds } }, select: { id: true, name: true } })).map((a) => [
      a.id,
      a.name,
    ]),
  );
  return {
    items: rows.map((r) => ({
      id: r.id,
      at: r.createdAt.toISOString(),
      sku: r.variant.sku,
      productName: r.variant.product.nameEn,
      label: r.variant.label,
      change: r.change,
      reason: r.reason,
      orderNo: r.order?.orderNo ?? null,
      by: r.adminId ? (names.get(r.adminId) ?? null) : r.orderId ? 'Order' : null,
    })),
    total,
    page: q.page,
    limit: q.limit,
  };
}
