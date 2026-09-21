-- CreateTable
CREATE TABLE "value_records" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "uuid" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "recurring" BOOLEAN NOT NULL DEFAULT true,
    "verification" TEXT NOT NULL DEFAULT 'pending',
    "description" TEXT,
    "evidence_ref" TEXT,
    "evidence_note" TEXT,
    "source_system" TEXT,
    "source_reference" TEXT,
    "dedupe_key" TEXT NOT NULL,
    "baseline_cents" INTEGER,
    "measured_cents" INTEGER,
    "baseline_approved_by" TEXT,
    "createdBy" INTEGER,
    "verifiedBy" INTEGER,
    "verifiedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "value_record_events" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "value_record_id" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "actor_id" INTEGER,
    "actor_label" TEXT,
    "detail" TEXT,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "value_records_uuid_key" ON "value_records"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "value_records_dedupe_key_key" ON "value_records"("dedupe_key");

-- CreateIndex
CREATE INDEX "value_records_period_idx" ON "value_records"("period");

-- CreateIndex
CREATE INDEX "value_records_verification_idx" ON "value_records"("verification");

-- CreateIndex
CREATE INDEX "value_record_events_value_record_id_idx" ON "value_record_events"("value_record_id");
