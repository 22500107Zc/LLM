const path = require("path");
const { PrismaClient } = require("@prisma/client");

/**
 * The Prisma schema now reads its URL from DATABASE_URL so a deployment (or a
 * disposable test run) can own its database file. Default it to the historical
 * location before the client is built, so nothing changes for an existing
 * install that has never set it.
 */
if (!process.env.DATABASE_URL) {
  const storageDir =
    process.env.STORAGE_DIR ?? path.resolve(__dirname, "../../storage");
  process.env.DATABASE_URL = `file:${path.join(storageDir, "anythingllm.db")}`;
}

// npx prisma introspect
// npx prisma generate
// npx prisma migrate dev --name init -> ensures that db is in sync with schema
// npx prisma migrate reset -> resets the db

const logLevels = ["error", "info", "warn"]; // add "query" to debug query logs
const prisma = new PrismaClient({
  log: logLevels,
});

module.exports = prisma;
