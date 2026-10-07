import type { z } from 'zod';
import type { AdminUser, Prisma } from '../generated/prisma/client.js';
import { audit } from '../lib/audit.js';
import { ApiError } from '../lib/errors.js';
import type { Db } from '../lib/prisma.js';
import type { ProductCostQuery, VariantCostBody } from '../schemas/product-costs.js';

type Line = { label: string; amount: number };

const costOf = (c: { lines: unknown; unitCost: number; updatedAt: Date } | null) =>
  c && { lines: c.lines as Line[], unitCost: c.unitCost, updatedAt: c.updatedAt.toISOString() };

/** Products with each variant's price and cost, newest first. */
export async function listProductCosts(db: Db, q: z.infer<typeof ProductCostQuery>) {
  const term = q.q?.trim();
  const where: Prisma.ProductWhereInput = {
    ...(q.productId && { id: q.productId }),
    ...(q.missing && { variants: { some: { cost: null } } }),
    ...(term && {
      OR: [
        { nameEn: { contains: term, mode: 'insensitive' } },
        { nameBn: { contains: term, mode: 'insensitive' } },
        { variants: { some: { sku: { contains: term.toUpperCase() } } } },
      ],
    }),
  };
  const [rows, total] = await Promise.all([
    db.product.findMany({
      where,
      orderBy: { id: 'desc' },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
      include: {
        category: { select: { nameEn: true } },
        images: { orderBy: { sort: 'asc' }, take: 1, select: { url: true } },
        variants: { orderBy: [{ sort: 'asc' }, { id: 'asc' }], include: { cost: true } },
      },
    }),
    db.product.count({ where }),
  ]);
  return {
    items: rows.map((p) => ({
      id: p.id,
      name: p.nameEn,
      image: p.images[0]?.url ?? null,
      category: p.category.nameEn,
      status: p.status,
      variants: p.variants.map((v) => ({
        id: v.id,
        label: v.label,
        sku: v.sku,
        price: v.price,
        cost: costOf(v.cost),
      })),
    })),
    total,
    page: q.page,
    limit: q.limit,
  };
}

/** Saves (or, with no lines, clears) what one unit of a variant costs. */
export async function saveVariantCost(
  db: Db,
  variantId: number,
  input: z.infer<typeof VariantCostBody>,
  ctx: { admin: AdminUser; ip: string },
) {
  const variant = await db.productVariant.findUnique({ where: { id: variantId }, select: { id: true, sku: true } });
  if (!variant) throw new ApiError(404, 'NOT_FOUND', 'Product size not found.');
  const unitCost = input.lines.reduce((a, l) => a + l.amount, 0);
  const saved = input.lines.length
    ? await db.variantCost.upsert({
        where: { variantId },
        create: { variantId, lines: input.lines, unitCost },
        update: { lines: input.lines, unitCost },
      })
    : (await db.variantCost.deleteMany({ where: { variantId } }), null);
  await audit(db, {
    adminId: ctx.admin.id,
    action: 'product_cost.update',
    entityType: 'variant',
    entityId: variantId,
    ip: ctx.ip,
    data: { sku: variant.sku, unitCost: saved ? unitCost : null },
  });
  return { cost: costOf(saved) };
}
