-- Customers the founder created and authorized.
--
-- The login email and password hash stay on `users`; access state stays on
-- `users.suspended`, which request validation already enforces. This table
-- holds only the business information the founder records.
CREATE TABLE "business_customers" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "business_name" TEXT NOT NULL,
    "contact_name" TEXT,
    "notes" TEXT,
    "payment_note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "business_customers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "business_customers_user_id_key" ON "business_customers"("user_id");
CREATE INDEX "business_customers_business_name_idx" ON "business_customers"("business_name");
