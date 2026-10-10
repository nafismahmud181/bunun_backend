-- CreateTable
CREATE TABLE "telegram_links" (
    "telegram_user_id" BIGINT NOT NULL,
    "admin_id" INTEGER NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_links_pkey" PRIMARY KEY ("telegram_user_id")
);

-- CreateIndex
CREATE INDEX "telegram_links_admin_id_idx" ON "telegram_links"("admin_id");

-- AddForeignKey
ALTER TABLE "telegram_links" ADD CONSTRAINT "telegram_links_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Only the API (as the table owner) reads this table; block the Data API.
ALTER TABLE "telegram_links" ENABLE ROW LEVEL SECURITY;
