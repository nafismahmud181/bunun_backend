import { createHash, randomBytes } from 'node:crypto';
import type { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import type { Db } from '../lib/prisma.js';
import type { CartView } from '../schemas/cart.js';
import { stockInfo } from './catalogue.js';

/** Most units of one variant a cart can hold. */
export const MAX_LINE_QTY = 20;
/** Most different variants in one cart. */
export const MAX_LINES = 50;

export const newCartToken = () => randomBytes(32).toString('base64url');
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

type CartDb = Pick<Db, 'cart' | 'cartItem' | 'productVariant'>;

export async function findCart(db: Pick<Db, 'cart'>, token: string | undefined) {
  if (!token) return null;
  return db.cart.findUnique({ where: { tokenHash: hashToken(token) } });
}

/** The caller's cart, or a new one (returned with its token, which is shown only this once). */
async function findOrCreateCart(db: CartDb, token: string | undefined) {
  const existing = await findCart(db, token);
  if (existing) return { cart: existing, newToken: undefined };
  const fresh = newCartToken();
  const cart = await db.cart.create({ data: { tokenHash: hashToken(fresh) } });
  return { cart, newToken: fresh };
}

async function activeVariant(db: CartDb, sku: string) {
  const v = await db.productVariant.findFirst({
    where: { sku, product: { status: 'active', category: { active: true } } },
  });
  if (!v) throw new ApiError(404, 'UNKNOWN_SKU', 'This product is no longer available.');
  return v;
}

/** Cart contents with current prices and stock. Items no longer for sale are left out. */
export async function cartView(db: CartDb, cartId: number | null): Promise<z.infer<typeof CartView>> {
  const rows = cartId
    ? await db.cartItem.findMany({
        where: { cartId, variant: { product: { status: 'active', category: { active: true } } } },
        orderBy: { addedAt: 'asc' },
        include: {
          variant: {
            include: {
              product: {
                select: {
                  slug: true,
                  nameEn: true,
                  images: { orderBy: { sort: 'asc' }, take: 1, select: { url: true, alt: true } },
                },
              },
            },
          },
        },
      })
    : [];
  const items = rows.map((r) => ({
    sku: r.variant.sku,
    qty: r.qty,
    name: r.variant.product.nameEn,
    slug: r.variant.product.slug,
    label: r.variant.label,
    image: r.variant.product.images[0] ?? null,
    unitPrice: r.variant.price,
    lineTotal: r.variant.price * r.qty,
    ...stockInfo(r.variant.stock),
    available: r.variant.stock >= r.qty,
  }));
  return {
    items,
    itemCount: items.reduce((a, i) => a + i.qty, 0),
    subtotal: items.reduce((a, i) => a + i.lineTotal, 0),
  };
}

/**
 * Adds units of a variant (or sets the exact quantity when `mode` is "set"; 0 removes it).
 * Quantities are capped at what's in stock and at MAX_LINE_QTY.
 */
export async function changeItem(db: CartDb, token: string | undefined, sku: string, qty: number, mode: 'add' | 'set') {
  const { cart, newToken } = await findOrCreateCart(db, token);
  const variant = await activeVariant(db, sku);
  const existing = await db.cartItem.findUnique({
    where: { cartId_variantId: { cartId: cart.id, variantId: variant.id } },
  });
  const wanted = mode === 'add' ? (existing?.qty ?? 0) + qty : qty;

  if (wanted <= 0) {
    if (existing) await db.cartItem.delete({ where: { cartId_variantId: { cartId: cart.id, variantId: variant.id } } });
  } else {
    if (variant.stock <= 0) throw new ApiError(409, 'OUT_OF_STOCK', 'Sorry, this size is out of stock.');
    if (!existing && (await db.cartItem.count({ where: { cartId: cart.id } })) >= MAX_LINES)
      throw new ApiError(400, 'CART_FULL', `A cart can hold up to ${MAX_LINES} different items.`);
    const capped = Math.min(wanted, variant.stock, MAX_LINE_QTY);
    await db.cartItem.upsert({
      where: { cartId_variantId: { cartId: cart.id, variantId: variant.id } },
      create: { cartId: cart.id, variantId: variant.id, qty: capped },
      update: { qty: capped },
    });
  }
  await db.cart.update({ where: { id: cart.id }, data: { updatedAt: new Date() } });
  return { ...(await cartView(db, cart.id)), ...(newToken && { token: newToken }) };
}
