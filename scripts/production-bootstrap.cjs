#!/usr/bin/env node
/**
 * What a brand new database needs before anyone can sign in.
 *
 * This product has no single-user mode. Every customer is an individual
 * account the founder created, which is what AnythingLLM calls multi-user
 * mode - and that lives in a `system_settings` row, not an environment
 * variable. On a database that has never been used the row does not exist, so
 * `/request-token` takes the single-user branch, tries to hash an AUTH_TOKEN
 * nobody set, and answers 500. Every customer login fails on an otherwise
 * perfectly healthy deployment.
 *
 * That is exactly what happened the first time this reached a real Supabase
 * database, and it was invisible beforehand because the test harness seeded
 * the row itself. The harness now runs this same script instead, so the two
 * can no longer drift apart.
 *
 * Idempotent: safe to run on every deployment, forever.
 *
 *   DATABASE_URL=postgresql://... node scripts/production-bootstrap.cjs
 */

const path = require("path");

/** Settings a deployment of this product cannot function without. */
const REQUIRED = [
  {
    label: "multi_user_mode",
    value: "true",
    why: "customers are individual accounts; there is no single-user mode here",
  },
];

(async () => {
  const url = String(process.env.DATABASE_URL ?? "").trim();
  if (!url) {
    console.log("[bootstrap] no DATABASE_URL; nothing to do");
    process.exit(0);
  }

  // The generated client lives at the root on Vercel (that is where the build
  // generates it, because that is where the function resolves it from) and
  // under server/ for a developer checkout. Take whichever exists.
  const roots = [
    path.resolve(__dirname, "..", "node_modules", "@prisma", "client"),
    path.resolve(
      __dirname,
      "..",
      "server",
      "node_modules",
      "@prisma",
      "client"
    ),
  ];

  let PrismaClient = null;
  const problems = [];
  for (const candidate of roots) {
    try {
      ({ PrismaClient } = require(candidate));
      break;
    } catch (error) {
      problems.push(`${candidate}: ${error.message.split("\n")[0]}`);
    }
  }
  if (!PrismaClient) {
    console.error("[bootstrap] no generated Prisma client found:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  const prisma = new PrismaClient();

  try {
    for (const { label, value, why } of REQUIRED) {
      const existing = await prisma.system_settings.findUnique({
        where: { label },
      });

      if (existing?.value === value) {
        console.log(`[bootstrap] ${label} is already ${value}`);
        continue;
      }

      await prisma.system_settings.upsert({
        where: { label },
        update: { value },
        create: { label, value },
      });
      console.log(
        `[bootstrap] set ${label}=${value} (${why})${
          existing ? ` - was ${existing.value}` : ""
        }`
      );
    }
  } catch (error) {
    console.error("[bootstrap] failed:", error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
})();
