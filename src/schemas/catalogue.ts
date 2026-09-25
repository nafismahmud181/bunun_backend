import { z } from 'zod';

// Schemas with an `id` become named components in the OpenAPI spec, so the frontend and
// admin get readable generated types (components['schemas']['ProductSummary'], …).

/** At or below this many units a variant shows as "low" ("Only N left"). */
export const LOW_STOCK = 5;

const Money = z.number().int().describe('Whole taka');

export const CategoryRef = z.object({ slug: z.string(), name: z.string() });

export const Image = z.object({ url: z.string(), alt: z.string().nullable() }).meta({ id: 'Image' });

export const Category = z
  .object({
    slug: z.string(),
    name: z.string(),
    imageUrl: z.string().nullable(),
    productCount: z.number().int(),
  })
  .meta({ id: 'Category' });

export const StockStatus = z.enum(['in_stock', 'low', 'out']).meta({ id: 'StockStatus' });

export const ProductSummary = z
  .object({
    slug: z.string(),
    legacyId: z.string().nullable(),
    name: z.string(),
    category: CategoryRef,
    tag: z.string().nullable(),
    price: Money.describe('Lowest variant price'),
    compareAtPrice: Money.nullable().describe("First variant's old price, if on sale"),
    image: Image.nullable(),
    inStock: z.boolean(),
    firstSku: z.string().nullable().describe('SKU added by a one-click "Add to Cart"'),
  })
  .meta({ id: 'ProductSummary' });

export const Variant = z
  .object({
    sku: z.string(),
    label: z.string(),
    price: Money,
    compareAtPrice: Money.nullable(),
    stockStatus: StockStatus,
    stockLeft: z.number().int().optional().describe(`Only sent when stockStatus is "low" (≤ ${LOW_STOCK})`),
  })
  .meta({ id: 'Variant' });

export const ProductDetail = ProductSummary.extend({
  description: z.string().nullable(),
  images: z.array(Image),
  variants: z.array(Variant),
  seoTitle: z.string().nullable(),
  seoDescription: z.string().nullable(),
}).meta({ id: 'ProductDetail' });

export const ProductList = z
  .object({
    items: z.array(ProductSummary),
    total: z.number().int(),
    page: z.number().int(),
    limit: z.number().int(),
  })
  .meta({ id: 'ProductList' });

export const ProductSort = z.enum(['featured', 'price_asc', 'price_desc', 'newest']);

export const ProductListQuery = z.object({
  category: z.string().max(100).optional().describe('Category slug'),
  q: z.string().trim().max(100).optional().describe('Search in product and category names'),
  maxPrice: z.coerce.number().int().positive().optional().describe('Products priced below this'),
  section: z.string().max(50).optional().describe('Homepage section key, e.g. bestsellers; keeps its order'),
  legacyId: z.string().max(20).optional().describe('Old storefront id, e.g. r1'),
  sort: ProductSort.default('featured'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(24),
});

export const CartVariant = Variant.omit({ compareAtPrice: true })
  .extend({ product: z.object({ slug: z.string(), name: z.string(), image: Image.nullable() }) })
  .meta({ id: 'CartVariant' });

export const VariantsQuery = z.object({
  skus: z
    .string()
    .regex(/^[A-Za-z0-9-]+(,[A-Za-z0-9-]+){0,49}$/, 'Comma-separated SKUs, at most 50')
    .describe('Comma-separated SKUs, e.g. BN-R1-1,BN-C1-2'),
});

export const NotFound = z
  .object({ statusCode: z.literal(404), error: z.string(), message: z.string() })
  .meta({ id: 'NotFound' });

export type ProductListQuery = z.infer<typeof ProductListQuery>;
