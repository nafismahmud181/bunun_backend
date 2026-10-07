import { z } from 'zod';

// Owner-only "Product profit" page: what one unit of each variant costs the store.

const CostLineSchema = z.object({
  label: z.string().trim().min(1).max(80),
  amount: z.number().min(0).max(10_000_000),
});

export const VariantCostBody = z
  .object({
    lines: z.array(CostLineSchema).max(20).describe('Empty clears the cost'),
  })
  .meta({ id: 'VariantCostBody' });

export const VariantCostParam = z.object({ variantId: z.coerce.number().int().positive() });

const VariantCost = z
  .object({
    lines: z.array(CostLineSchema),
    unitCost: z.number(),
    updatedAt: z.string(),
  })
  .meta({ id: 'VariantCost' });

export const CostedVariant = z
  .object({
    id: z.number().int(),
    label: z.string(),
    sku: z.string(),
    price: z.number().int(),
    cost: VariantCost.nullable(),
  })
  .meta({ id: 'CostedVariant' });

export const CostedProduct = z
  .object({
    id: z.number().int(),
    name: z.string(),
    image: z.string().nullable(),
    category: z.string(),
    status: z.string(),
    variants: z.array(CostedVariant),
  })
  .meta({ id: 'CostedProduct' });

export const ProductCostQuery = z.object({
  q: z.string().trim().max(100).optional(),
  productId: z.coerce.number().int().positive().optional().describe('Just this product'),
  missing: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true')
    .describe('Only products with a size whose cost is not entered'),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const ProductCostList = z
  .object({
    items: z.array(CostedProduct),
    total: z.number().int(),
    page: z.number().int(),
    limit: z.number().int(),
  })
  .meta({ id: 'ProductCostList' });
