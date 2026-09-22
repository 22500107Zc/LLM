#!/usr/bin/env node
/**
 * Vercel build.
 *
 * Three things have to happen, in this order:
 *
 *   1. Point Prisma at Postgres and generate the client. A serverless instance
 *      does not keep its filesystem, so SQLite would lose every customer
 *      account on the next cold start.
 *   2. Bring the database up to the schema. SQLite's migration history is not
 *      valid against Postgres, so this uses `db push`, which takes an empty
 *      database to the current schema in one step and is a no-op afterwards.
 *   3. Build the frontend, and undo the rename its own post-build step does -
 *      it produces `_index.html` for the long-running server to render, but a
 *      static host needs a real `index.html`.
 *
 * Every step prints what it is doing and fails the build loudly. A deployment
 * that silently skipped the database step would look fine and lose data.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SERVER = path.join(ROOT, "server");
const FRONTEND = path.join(ROOT, "frontend");

function run(command, args, cwd, extraEnv = {}) {
  console.log(`\n[vercel-build] ${command} ${args.join(" ")}   (in ${cwd})`);
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
}

function fail(message) {
  console.error(`\n[vercel-build] ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------- database --

const databaseUrl = String(process.env.DATABASE_URL ?? "").trim();
if (!databaseUrl)
  fail(
    "DATABASE_URL is not set.\n" +
      "This deployment stores founder-created customer accounts, so it needs a\n" +
      "Postgres connection string. Add DATABASE_URL in the Vercel project's\n" +
      "environment variables and redeploy."
  );

if (databaseUrl.startsWith("file:") || databaseUrl.endsWith(".db"))
  fail(
    "DATABASE_URL points at a SQLite file.\n" +
      "A serverless instance does not keep its filesystem, so every customer\n" +
      "account, password hash and access decision would be lost on the next\n" +
      "cold start. Use Postgres."
  );

console.log("[vercel-build] selecting the Postgres datasource");
run("node", [path.join("scripts", "prisma-provider.cjs"), "postgresql"], ROOT);

run("npx", ["prisma", "generate", "--schema", "prisma/schema.prisma"], SERVER);

// `db push` rather than `migrate deploy`: the committed migration history is
// SQLite DDL and will not apply to Postgres.
run(
  "npx",
  ["prisma", "db", "push", "--schema", "prisma/schema.prisma", "--skip-generate"],
  SERVER
);

// ---------------------------------------------------------------- frontend --

run("npm", ["install", "--no-audit", "--no-fund"], FRONTEND);
run("npm", ["run", "build"], FRONTEND);

const dist = path.join(FRONTEND, "dist");
const renamed = path.join(dist, "_index.html");
const index = path.join(dist, "index.html");

if (fs.existsSync(renamed) && !fs.existsSync(index)) {
  fs.copyFileSync(renamed, index);
  console.log("[vercel-build] restored dist/index.html for static serving");
}

if (!fs.existsSync(index))
  fail("The frontend build produced no dist/index.html.");

console.log("\n[vercel-build] done");
