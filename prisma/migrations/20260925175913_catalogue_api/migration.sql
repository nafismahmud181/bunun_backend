-- AlterTable
ALTER TABLE "products" ADD COLUMN     "price_from" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "homepage_sections" (
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,

    CONSTRAINT "homepage_sections_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "homepage_section_items" (
    "section_key" TEXT NOT NULL,
    "product_id" INTEGER NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "homepage_section_items_pkey" PRIMARY KEY ("section_key","product_id")
);

-- CreateIndex
CREATE INDEX "homepage_section_items_section_key_sort_idx" ON "homepage_section_items"("section_key", "sort");

-- CreateIndex
CREATE INDEX "products_status_price_from_idx" ON "products"("status", "price_from");

-- AddForeignKey
ALTER TABLE "homepage_section_items" ADD CONSTRAINT "homepage_section_items_section_key_fkey" FOREIGN KEY ("section_key") REFERENCES "homepage_sections"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "homepage_section_items" ADD CONSTRAINT "homepage_section_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security on every new table (see 20260925151207_enable_row_level_security).
ALTER TABLE "homepage_sections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "homepage_section_items" ENABLE ROW LEVEL SECURITY;

-- SKUs match what the storefront has always shown, e.g. BN-R1-1.
UPDATE "product_variants" SET "sku" = 'BN-' || "sku" WHERE "sku" NOT LIKE 'BN-%';

-- Backfill the new column from existing variants.
UPDATE "products" p
SET "price_from" = v.min_price
FROM (SELECT "product_id", MIN("price") AS min_price FROM "product_variants" GROUP BY "product_id") v
WHERE v."product_id" = p."id";
