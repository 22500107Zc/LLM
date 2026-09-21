-- CreateTable
CREATE TABLE "billing_subscription" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "stripe_customer_id" TEXT,
    "stripe_subscription_id" TEXT,
    "stripe_price_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'unconfigured',
    "collection_method" TEXT,
    "currency" TEXT DEFAULT 'usd',
    "unit_amount" INTEGER,
    "current_period_start" DATETIME,
    "current_period_end" DATETIME,
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "canceled_at" DATETIME,
    "latest_invoice_id" TEXT,
    "latest_invoice_status" TEXT,
    "latest_invoice_url" TEXT,
    "last_payment_status" TEXT,
    "last_payment_at" DATETIME,
    "past_due_since" DATETIME,
    "restricted_at" DATETIME,
    "billing_email" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "billing_events" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "stripe_event_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'processed',
    "summary" TEXT,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "action" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'general',
    "actor_id" INTEGER,
    "actor_label" TEXT,
    "resource" TEXT,
    "resource_id" TEXT,
    "metadata" TEXT,
    "ip_address" TEXT,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "platform_user_profiles" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "business_role" TEXT NOT NULL DEFAULT 'member',
    "title" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "agent_profiles" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "uuid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "avatar_url" TEXT,
    "template" TEXT,
    "workspace_id" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "fallback_message" TEXT,
    "lead_capture_enabled" BOOLEAN NOT NULL DEFAULT false,
    "lead_capture_fields" TEXT,
    "escalation_enabled" BOOLEAN NOT NULL DEFAULT false,
    "escalation_target" TEXT,
    "createdBy" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "leads" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "uuid" TEXT NOT NULL,
    "first_name" TEXT,
    "last_name" TEXT,
    "email" TEXT,
    "company" TEXT,
    "phone" TEXT,
    "job_title" TEXT,
    "reason" TEXT,
    "conversation_summary" TEXT,
    "source_url" TEXT,
    "agent_profile_id" INTEGER,
    "embed_id" INTEGER,
    "session_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "notes" TEXT,
    "delivered" BOOLEAN NOT NULL DEFAULT false,
    "delivery_error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "escalations" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "uuid" TEXT NOT NULL,
    "contact_name" TEXT,
    "contact_email" TEXT,
    "contact_phone" TEXT,
    "question" TEXT,
    "transcript" TEXT,
    "summary" TEXT,
    "agent_profile_id" INTEGER,
    "embed_id" INTEGER,
    "session_id" TEXT,
    "source_url" TEXT,
    "reason" TEXT NOT NULL DEFAULT 'requested',
    "status" TEXT NOT NULL DEFAULT 'open',
    "delivered" BOOLEAN NOT NULL DEFAULT false,
    "delivery_error" TEXT,
    "resolved_at" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "integrations" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "uuid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" TEXT,
    "secret_ciphered" TEXT,
    "events" TEXT,
    "last_status" TEXT,
    "last_error" TEXT,
    "last_delivery" DATETIME,
    "createdBy" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "integration_deliveries" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "integration_id" INTEGER NOT NULL,
    "event" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "status_code" INTEGER,
    "error" TEXT,
    "attemptedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "knowledge_gaps" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "normalized" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "frequency" INTEGER NOT NULL DEFAULT 1,
    "reasons" TEXT,
    "agent_profile_id" INTEGER,
    "workspace_id" INTEGER,
    "embed_id" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'open',
    "suggested_action" TEXT,
    "note" TEXT,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "quality_tests" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "uuid" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "expected_answer" TEXT,
    "expected_concepts" TEXT,
    "required_source" TEXT,
    "agent_profile_id" INTEGER,
    "workspace_id" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "quality_runs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "uuid" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "total" INTEGER NOT NULL DEFAULT 0,
    "passed" INTEGER NOT NULL DEFAULT 0,
    "needs_review" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "triggeredBy" INTEGER,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME
);

-- CreateTable
CREATE TABLE "quality_results" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "run_id" INTEGER NOT NULL,
    "test_id" INTEGER NOT NULL,
    "verdict" TEXT NOT NULL,
    "score" REAL,
    "answer" TEXT,
    "sources" TEXT,
    "detail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "conversation_reviews" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "channel" TEXT NOT NULL,
    "reference_id" TEXT NOT NULL,
    "reviewed" BOOLEAN NOT NULL DEFAULT false,
    "reviewed_by" INTEGER,
    "reviewed_at" DATETIME,
    "summary" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "label" TEXT NOT NULL,
    "value" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_events_stripe_event_id_key" ON "billing_events"("stripe_event_id");

-- CreateIndex
CREATE INDEX "billing_events_type_idx" ON "billing_events"("type");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "audit_logs_category_idx" ON "audit_logs"("category");

-- CreateIndex
CREATE INDEX "audit_logs_occurredAt_idx" ON "audit_logs"("occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "platform_user_profiles_user_id_key" ON "platform_user_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_profiles_uuid_key" ON "agent_profiles"("uuid");

-- CreateIndex
CREATE INDEX "agent_profiles_workspace_id_idx" ON "agent_profiles"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "leads_uuid_key" ON "leads"("uuid");

-- CreateIndex
CREATE INDEX "leads_status_idx" ON "leads"("status");

-- CreateIndex
CREATE INDEX "leads_createdAt_idx" ON "leads"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "escalations_uuid_key" ON "escalations"("uuid");

-- CreateIndex
CREATE INDEX "escalations_status_idx" ON "escalations"("status");

-- CreateIndex
CREATE INDEX "escalations_createdAt_idx" ON "escalations"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "integrations_uuid_key" ON "integrations"("uuid");

-- CreateIndex
CREATE INDEX "integrations_provider_idx" ON "integrations"("provider");

-- CreateIndex
CREATE INDEX "integration_deliveries_integration_id_idx" ON "integration_deliveries"("integration_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_gaps_normalized_key" ON "knowledge_gaps"("normalized");

-- CreateIndex
CREATE INDEX "knowledge_gaps_status_idx" ON "knowledge_gaps"("status");

-- CreateIndex
CREATE INDEX "knowledge_gaps_frequency_idx" ON "knowledge_gaps"("frequency");

-- CreateIndex
CREATE UNIQUE INDEX "quality_tests_uuid_key" ON "quality_tests"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "quality_runs_uuid_key" ON "quality_runs"("uuid");

-- CreateIndex
CREATE INDEX "quality_results_run_id_idx" ON "quality_results"("run_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_reviews_channel_reference_id_key" ON "conversation_reviews"("channel", "reference_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_settings_label_key" ON "platform_settings"("label");
