#!/usr/bin/env node
/**
 * Selects the Prisma datasource provider.
 *
 *   node scripts/prisma-provider.cjs postgresql
 *   node scripts/prisma-provider.cjs sqlite
 *
 * WHY THIS EXISTS
 *
 * Prisma requires the datasource `provider` to be a literal in the schema; it
 * cannot read one from the environment. This product has to run in two places
 * that disagree about it:
 *
 *   - a container with a disk, where SQLite is right and is what every
 *     existing deployment already uses
 *   - a serverless runtime with no durable disk, where SQLite would silently
 *     lose every customer account on the next cold start
 *
 * Rather than keep two schemas that drift apart, this rewrites the single
 * provider line in place. It touches nothing else, and it is idempotent.
 *
 * It does NOT run migrations. SQLite's migration history is not valid against
 * Postgres, so the Postgres path uses `prisma db push` from the build, which
 * brings an empty database up to the schema in one step.
 */

const fs = require("fs");
const path = require("path");

const SCHEMA = path.resolve(
  __dirname,
  "..",
  "server",
  "prisma",
  "schema.prisma"
);
const SUPPORTED = new Set(["sqlite", "postgresql"]);

const requested = String(process.argv[2] ?? "").trim();
if (!SUPPORTED.has(requested)) {
  console.error(
    `Usage: node scripts/prisma-provider.cjs <${[...SUPPORTED].join("|")}>`
  );
  process.exit(1);
}

let schema;
try {
  schema = fs.readFileSync(SCHEMA, "utf8");
} catch (error) {
  console.error(`Could not read ${SCHEMA}: ${error.message}`);
  process.exit(1);
}

/**
 * Finds the provider line of the LIVE `datasource db` block.
 *
 * Done line by line rather than with one regex over the whole file, because
 * the schema also carries a commented-out `datasource db` block showing the
 * Postgres alternative. A regex spanning the file matches that comment first
 * and rewrites documentation instead of configuration - which looks like it
 * worked and changes nothing.
 */
function findProviderLine(lines) {
  let inDatasource = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().startsWith("//")) continue; // never a comment
    if (/^\s*datasource\s+db\s*\{/.test(line)) {
      inDatasource = true;
      continue;
    }
    if (!inDatasource) continue;
    if (/^\s*\}/.test(line)) {
      inDatasource = false;
      continue;
    }
    const match = line.match(/^(\s*provider\s*=\s*")([a-z]+)(".*)$/);
    if (match) return { index, prefix: match[1], current: match[2], suffix: match[3] };
  }
  return null;
}

const lines = schema.split("\n");
const found = findProviderLine(lines);
if (!found) {
  console.error("Could not find the live datasource provider in the schema.");
  process.exit(1);
}

if (found.current === requested) {
  console.log(`[prisma-provider] already ${requested}`);
  process.exit(0);
}

lines[found.index] = `${found.prefix}${requested}${found.suffix}`;
fs.writeFileSync(SCHEMA, lines.join("\n"));
console.log(
  `[prisma-provider] ${found.current} -> ${requested} (line ${found.index + 1})`
);
