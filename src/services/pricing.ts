import type { Prisma } from '../generated/prisma/client.js';

/**
 * Recomputes a product's `priceFrom` (its lowest variant price). Call it inside the same
 * transaction whenever a product's variants are created, deleted or repriced.
 */
export async function refreshPriceFrom(tx: Prisma.TransactionClient, productId: number) {
  const { _min } = await tx.productVariant.aggregate({ where: { productId }, _min: { price: true } });
  await tx.product.update({ where: { id: productId }, data: { priceFrom: _min.price ?? 0 } });
}
