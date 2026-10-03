-- Courier API tokens (encrypted), so the API and worker reuse them instead of logging in each start.

-- CreateTable
CREATE TABLE "courier_tokens" (
    "courier" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "courier_tokens_pkey" PRIMARY KEY ("courier")
);

-- Row-level security: only the API (which connects as the table owner) reads or writes this.
ALTER TABLE "courier_tokens" ENABLE ROW LEVEL SECURITY;
