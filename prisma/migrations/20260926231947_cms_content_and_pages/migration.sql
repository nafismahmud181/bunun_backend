-- CreateTable
CREATE TABLE "content_blocks" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by_id" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_blocks_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "pages" (
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "updated_by_id" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pages_pkey" PRIMARY KEY ("slug")
);

-- Row-level security: only the API (which connects as the table owner) reads or writes these.
ALTER TABLE "content_blocks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pages" ENABLE ROW LEVEL SECURITY;
