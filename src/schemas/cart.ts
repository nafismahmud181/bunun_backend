import { z } from 'zod';
import { Image, StockStatus } from './catalogue.js';

const Money = z.number().int().describe('Whole taka');
const Sku = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);

/** Header that carries the guest cart token. */
export const CART_TOKEN_HEADER = 'x-cart-token';

export const CartLine = z
  .object({
    sku: z.string(),
    qty: z.number().int(),
    name: z.string(),
    slug: z.string(),
    label: z.string(),
    image: Image.nullable(),
    unitPrice: Money,
    lineTotal: Money,
    stockStatus: StockStatus,
    stockLeft: z.number().int().optional(),
    available: z.boolean().describe('False when fewer are in stock than the quantity in the cart'),
  })
  .meta({ id: 'CartLine' });

export const CartView = z
  .object({
    items: z.array(CartLine),
    itemCount: z.number().int(),
    subtotal: Money,
    token: z.string().optional().describe('Only when this request created the cart: store it and send it back'),
  })
  .meta({ id: 'Cart' });

// Loose, so validating the headers doesn't strip the ones not listed here (User-Agent and so on).
export const CartHeaders = z.looseObject({ [CART_TOKEN_HEADER]: z.string().max(100).optional() });

export const AddItemBody = z.object({ sku: Sku, qty: z.number().int().min(1).max(20).default(1) });
export const SetQtyBody = z.object({ qty: z.number().int().min(0).max(20).describe('0 removes the item') });
export const SkuParams = z.object({ sku: Sku });

export const QuoteQuery = z.object({ areaId: z.coerce.number().int().positive() });
export const Quote = z
  .object({
    subtotal: Money,
    deliveryFee: Money,
    total: Money,
    freeDelivery: z.boolean(),
    zone: z.object({ key: z.string(), name: z.string(), estimate: z.string() }),
  })
  .meta({ id: 'Quote' });
