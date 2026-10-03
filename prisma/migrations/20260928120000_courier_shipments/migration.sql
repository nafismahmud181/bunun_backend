-- Couriers (Phase 6): parcels booked for orders, and their status history.

-- CreateEnum
CREATE TYPE "ShipmentState" AS ENUM ('booking', 'active', 'delivered', 'returned', 'cancelled');

-- CreateTable
CREATE TABLE "shipments" (
    "id" SERIAL NOT NULL,
    "order_id" INTEGER NOT NULL,
    "courier" TEXT NOT NULL,
    "state" "ShipmentState" NOT NULL DEFAULT 'booking',
    "consignment_id" TEXT,
    "courier_status" TEXT,
    "status_label" TEXT,
    "delivery_fee" INTEGER,
    "cod_amount" INTEGER NOT NULL,
    "weight_kg" DOUBLE PRECISION NOT NULL,
    "note" TEXT,
    "last_error" TEXT,
    "booked_by_id" INTEGER,
    "checked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_events" (
    "id" SERIAL NOT NULL,
    "shipment_id" INTEGER NOT NULL,
    "courier_status" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shipments_consignment_id_key" ON "shipments"("consignment_id");

-- CreateIndex
CREATE INDEX "shipments_order_id_idx" ON "shipments"("order_id");

-- CreateIndex
CREATE INDEX "shipments_state_checked_at_idx" ON "shipments"("state", "checked_at");

-- CreateIndex
CREATE INDEX "shipment_events_shipment_id_created_at_idx" ON "shipment_events"("shipment_id", "created_at");

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_events" ADD CONSTRAINT "shipment_events_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security: only the API (which connects as the table owner) reads or writes these.
ALTER TABLE "shipments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shipment_events" ENABLE ROW LEVEL SECURITY;
