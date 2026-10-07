-- What one unit of each product variant costs the store (owner-only Product profit page).

-- CreateTable
CREATE TABLE "variant_costs" (
    "variant_id" INTEGER NOT NULL,
    "lines" JSONB NOT NULL,
    "unit_cost" DOUBLE PRECISION NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "variant_costs_pkey" PRIMARY KEY ("variant_id")
);

-- AddForeignKey
ALTER TABLE "variant_costs" ADD CONSTRAINT "variant_costs_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security: only the API (which connects as the table owner) reads or writes this.
ALTER TABLE "variant_costs" ENABLE ROW LEVEL SECURITY;
