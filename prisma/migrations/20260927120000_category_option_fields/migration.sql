-- Per-category option fields (e.g. Dimensions for table runners instead of Weight).

-- AlterTable
ALTER TABLE "categories" ADD COLUMN     "option_label" TEXT NOT NULL DEFAULT 'Size',
ADD COLUMN     "variant_fields" JSONB NOT NULL DEFAULT '[{"key":"weight","label":"Weight","unit":"g"}]';

-- AlterTable
ALTER TABLE "product_variants" ADD COLUMN     "attributes" JSONB NOT NULL DEFAULT '{}';
