import { z } from 'zod';

const Money = z.number().int().describe('Whole taka');
const Id = z.coerce.number().int().positive();
export const IdParams = z.object({ id: Id });
export const ProductStatus = z.enum(['draft', 'active', 'archived']).meta({ id: 'ProductStatus' });

/** URL-safe lowercase slug, e.g. "nakshi-kantha-runner". */
export const Slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and single hyphens')
  .max(120);
const OptionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === '' ? null : v));

// ---------- Categories ----------

export const AdminCategory = z
  .object({
    id: z.number().int(),
    slug: z.string(),
    name: z.string(),
    nameBn: z.string().nullable(),
    imageUrl: z.string().nullable(),
    sort: z.number().int(),
    active: z.boolean(),
    productCount: z.number().int(),
  })
  .meta({ id: 'AdminCategory' });

export const CategoryCreate = z.object({
  name: z.string().trim().min(2).max(80),
  nameBn: OptionalText(80),
  slug: Slug.optional(),
  active: z.boolean().default(true),
});
export const CategoryUpdate = z
  .object({ name: z.string().trim().min(2).max(80), nameBn: OptionalText(80), slug: Slug, active: z.boolean() })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');
export const ReorderBody = z.object({ ids: z.array(z.number().int().positive()).min(1).max(500) });

// ---------- Products ----------

export const AdminProductQuery = z.object({
  q: z.string().trim().max(100).optional().describe('Name, slug or SKU'),
  categoryId: Id.optional(),
  status: ProductStatus.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const AdminProductRow = z
  .object({
    id: z.number().int(),
    slug: z.string(),
    name: z.string(),
    category: z.object({ id: z.number().int(), name: z.string() }),
    status: ProductStatus,
    tag: z.string().nullable(),
    priceFrom: Money,
    stock: z.number().int().describe('All variants together'),
    variantCount: z.number().int(),
    image: z.string().nullable(),
    updatedAt: z.string(),
  })
  .meta({ id: 'AdminProductRow' });

export const AdminProductList = z
  .object({ items: z.array(AdminProductRow), total: z.number().int(), page: z.number().int(), limit: z.number().int() })
  .meta({ id: 'AdminProductList' });

export const AdminVariant = z
  .object({
    id: z.number().int(),
    sku: z.string(),
    label: z.string(),
    price: Money,
    compareAtPrice: Money.nullable(),
    stock: z.number().int(),
    weightGrams: z.number().int().nullable(),
    sort: z.number().int(),
  })
  .meta({ id: 'AdminVariant' });

export const AdminImage = z
  .object({ id: z.number().int(), url: z.string(), alt: z.string().nullable(), sort: z.number().int() })
  .meta({ id: 'AdminImage' });

export const AdminProduct = z
  .object({
    id: z.number().int(),
    slug: z.string(),
    legacyId: z.string().nullable(),
    nameEn: z.string(),
    nameBn: z.string().nullable(),
    descriptionEn: z.string().nullable(),
    descriptionBn: z.string().nullable(),
    categoryId: z.number().int(),
    tag: z.string().nullable(),
    status: ProductStatus,
    seoTitle: z.string().nullable(),
    seoDescription: z.string().nullable(),
    priceFrom: Money,
    variants: z.array(AdminVariant),
    images: z.array(AdminImage),
    orderCount: z.number().int().describe('Orders that include this product'),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'AdminProduct' });

const productFields = {
  nameEn: z.string().trim().min(2).max(150),
  nameBn: OptionalText(150),
  slug: Slug,
  descriptionEn: OptionalText(5000),
  descriptionBn: OptionalText(5000),
  categoryId: z.number().int().positive(),
  tag: OptionalText(30),
  status: ProductStatus,
  seoTitle: OptionalText(70),
  seoDescription: OptionalText(170),
};
export const ProductCreate = z.object({
  ...productFields,
  slug: productFields.slug.optional(),
  status: z.literal('draft').default('draft').describe('New products start as drafts; add variants, then publish'),
});
export const ProductUpdate = z
  .object(productFields)
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');

const Sku = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]+(-[A-Z0-9]+)*$/, 'Use letters, numbers and hyphens')
  .max(64);
export const VariantCreate = z.object({
  label: z.string().trim().min(1).max(60),
  sku: Sku.optional().describe('Left out: generated from the product'),
  price: Money.positive(),
  compareAtPrice: Money.positive().nullable().optional(),
  weightGrams: z.number().int().positive().max(100_000).nullable().optional(),
  openingStock: z.number().int().min(0).max(100_000).default(0),
});
export const VariantUpdate = z
  .object({
    label: z.string().trim().min(1).max(60),
    sku: Sku,
    price: Money.positive(),
    compareAtPrice: Money.positive().nullable(),
    weightGrams: z.number().int().positive().max(100_000).nullable(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');
export const VariantParams = z.object({ id: Id, variantId: Id });
export const ImageParams = z.object({ id: Id, imageId: Id });
export const ImageUpdate = z.object({ alt: z.string().trim().max(150).nullable() });

// ---------- Inventory ----------

export const InventoryQuery = z.object({
  q: z.string().trim().max(100).optional().describe('Product name or SKU'),
  low: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true')
    .describe('Only variants at or below the low-stock threshold'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const InventoryRow = z
  .object({
    sku: z.string(),
    productId: z.number().int(),
    productName: z.string(),
    productStatus: ProductStatus,
    label: z.string(),
    price: Money,
    stock: z.number().int(),
    low: z.boolean(),
  })
  .meta({ id: 'InventoryRow' });

export const InventoryList = z
  .object({
    items: z.array(InventoryRow),
    total: z.number().int(),
    page: z.number().int(),
    limit: z.number().int(),
    lowStockThreshold: z.number().int(),
  })
  .meta({ id: 'InventoryList' });

export const StockChange = z
  .object({
    sku: Sku,
    reason: z.string().trim().min(3).max(200),
    change: z
      .number()
      .int()
      .refine((n) => n !== 0, 'Must not be zero')
      .optional()
      .describe('Add (+) or remove (−) units'),
    count: z.number().int().min(0).max(1_000_000).optional().describe('Or: the exact count after a stocktake'),
  })
  .refine((b) => (b.change === undefined) !== (b.count === undefined), 'Give either change or count');

export const MovementQuery = z.object({
  sku: z.string().trim().max(64).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const MovementList = z
  .object({
    items: z.array(
      z.object({
        id: z.number().int(),
        at: z.string(),
        sku: z.string(),
        productName: z.string(),
        label: z.string(),
        change: z.number().int(),
        reason: z.string(),
        orderNo: z.string().nullable(),
        by: z.string().nullable(),
      }),
    ),
    total: z.number().int(),
    page: z.number().int(),
    limit: z.number().int(),
  })
  .meta({ id: 'MovementList' });
