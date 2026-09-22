-- One customer's own connection to the AI service they chose and pay for.
--
-- This product has no platform-wide model credential. `credential` holds an
-- AES-256-GCM sealed value (server/business/ai/secrets.js); it is never
-- returned by an API and never reaches a browser.
CREATE TABLE "business_ai_connections" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "base_url" TEXT,
    "model" TEXT,
    "embedding_model" TEXT,
    "credential" TEXT,
    "settings" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "business_ai_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "business_ai_connections_user_id_key" ON "business_ai_connections"("user_id");
