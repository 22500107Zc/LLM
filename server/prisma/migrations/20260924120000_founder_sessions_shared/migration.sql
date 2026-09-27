-- Founder sessions and login attempts, somewhere every instance can see.
--
-- Both were in-memory Maps. On a runtime that scales, only the instance that
-- served the login knew the session, so most founder requests answered 401 on
-- a valid session; and the login lockout counted per instance, multiplying the
-- allowed guesses by however many were warm.
CREATE TABLE "business_founder_sessions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "token_hash" TEXT NOT NULL,
    "csrf" TEXT NOT NULL,
    "expires_at" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "business_founder_sessions_token_hash_key" ON "business_founder_sessions"("token_hash");
CREATE INDEX "business_founder_sessions_expires_at_idx" ON "business_founder_sessions"("expires_at");

CREATE TABLE "business_founder_login_attempts" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "attempt_key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "first_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" DATETIME
);

CREATE UNIQUE INDEX "business_founder_login_attempts_attempt_key_key" ON "business_founder_login_attempts"("attempt_key");
