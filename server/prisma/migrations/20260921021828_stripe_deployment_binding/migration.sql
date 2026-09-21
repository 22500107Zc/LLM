-- AlterTable
ALTER TABLE "billing_subscription" ADD COLUMN "bound_at" DATETIME;
ALTER TABLE "billing_subscription" ADD COLUMN "bound_deployment_id" TEXT;
ALTER TABLE "billing_subscription" ADD COLUMN "bound_via" TEXT;

-- CreateTable
CREATE TABLE "billing_pending_checkouts" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "session_id" TEXT NOT NULL,
    "deployment_id" TEXT NOT NULL,
    "expected_customer" TEXT,
    "price_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" DATETIME,
    "expiresAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_pending_checkouts_session_id_key" ON "billing_pending_checkouts"("session_id");

-- CreateIndex
CREATE INDEX "billing_pending_checkouts_deployment_id_idx" ON "billing_pending_checkouts"("deployment_id");
