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

/**
 * Whether this deployment has somewhere durable to keep customer accounts.
 *
 * A missing or SQLite DATABASE_URL does not fail the build. Failing it would
 * leave no deployment at all to look at, and the useful thing is a real URL
 * that serves the application and says plainly what it still needs. The
 * request handler refuses every API call in that state, so nothing can be
 * created and then quietly lost.
 */
function persistenceState() {
  const url = String(process.env.DATABASE_URL ?? "").trim();
  if (!url) return { ok: false, why: "DATABASE_URL is not set." };
  if (url.startsWith("file:") || url.endsWith(".db"))
    return { ok: false, why: "DATABASE_URL points at a SQLite file." };
  return { ok: true };
}

const persistence = persistenceState();

console.log("[vercel-build] selecting the Postgres datasource");
run("node", [path.join("scripts", "prisma-provider.cjs"), "postgresql"], ROOT);

// Generated from the ROOT, because that is where the function resolves
// @prisma/client from - Vercel installs only the root manifest, so
// server/node_modules does not exist there at all. Generating does not touch
// a database.
run(
  "npx",
  [
    "prisma",
    "generate",
    "--schema",
    path.join("server", "prisma", "schema.prisma"),
  ],
  ROOT
);

/**
 * The connection schema changes must go through.
 *
 * Supabase offers two poolers and they are not interchangeable. The
 * transaction pooler (6543) hands a different backend connection to every
 * statement, so it cannot hold the session-scoped advisory lock Prisma's
 * migration engine takes before touching the schema - `db push` against it
 * does not fail, it simply waits forever, which is exactly how the previous
 * deployment hung.
 *
 * DDL therefore goes through DIRECT_URL, the session pooler on 5432, where a
 * connection belongs to one client for its lifetime. Runtime traffic is
 * unaffected and keeps using DATABASE_URL.
 *
 * `pgbouncer=true` is stripped if it is present: it tells Prisma to give up
 * prepared statements, which the session pooler has no need for.
 *
 * With no DIRECT_URL this returns DATABASE_URL, so a deployment against a
 * plain Postgres with no pooler behaves exactly as it did before.
 */
function migrationUrl() {
  const direct = String(process.env.DIRECT_URL ?? "").trim();
  if (!direct) return null;

  let url;
  try {
    url = new URL(direct);
  } catch {
    fail("DIRECT_URL is not a valid connection string.");
  }
  if (!url.protocol.startsWith("postgres"))
    fail("DIRECT_URL must be a PostgreSQL connection string.");

  url.searchParams.delete("pgbouncer");
  url.searchParams.delete("connection_limit");
  // A hang is worse than a failure: make the engine give up and say so.
  if (!url.searchParams.has("connect_timeout"))
    url.searchParams.set("connect_timeout", "30");

  return url.toString();
}

if (persistence.ok) {
  const direct = migrationUrl();
  console.log(
    direct
      ? "[vercel-build] applying the schema through DIRECT_URL (session pooler)"
      : "[vercel-build] no DIRECT_URL set; applying the schema through DATABASE_URL"
  );

  // `db push` rather than `migrate deploy`: the committed migration history is
  // SQLite DDL and will not apply to Postgres.
  run(
    "npx",
    [
      "prisma",
      "db",
      "push",
      "--schema",
      path.join("server", "prisma", "schema.prisma"),
      "--skip-generate",
    ],
    ROOT,
    direct ? { DATABASE_URL: direct } : {}
  );

  // A schema is not a usable deployment. This puts the settings a brand new
  // database needs in place - without them every customer login answers 500
  // on an otherwise healthy deployment. Idempotent; runs on every deploy.
  run(
    "node",
    [path.join("scripts", "production-bootstrap.cjs")],
    ROOT,
    direct ? { DATABASE_URL: direct } : {}
  );
} else {
  console.warn(
    [
      "",
      "=".repeat(72),
      `[vercel-build] NO DATABASE: ${persistence.why}`,
      "",
      "The site will build and serve, but every API request will answer 500",
      "with this reason. Founder-created customer accounts, password hashes",
      "and access state cannot be stored on a serverless filesystem - a cold",
      "start would lose all of it.",
      "",
      "To finish: add a Postgres DATABASE_URL to this project's environment",
      "variables and redeploy. The schema is created automatically.",
      "=".repeat(72),
      "",
    ].join("\n")
  );
}

// ---------------------------------------------------------------- frontend --

// yarn, not npm, and with the committed lockfile.
//
// npm produced a tree where `regenerator-runtime` - a transitive dependency
// the speech-to-text component imports directly - was not hoisted to the top
// level, and rollup could not resolve it. frontend/yarn.lock pins the exact
// tree this frontend is known to build against.
//
// NODE_ENV is forced to development for the install only: Vercel sets it to
// production, which makes a package manager skip devDependencies, and vite -
// the thing that builds the frontend - is one of them.
run("yarn", ["install", "--frozen-lockfile"], FRONTEND, {
  NODE_ENV: "development",
});
run("yarn", ["build"], FRONTEND, { NODE_ENV: "production" });

const dist = path.join(FRONTEND, "dist");
const renamed = path.join(dist, "_index.html");
const index = path.join(dist, "index.html");

if (fs.existsSync(renamed) && !fs.existsSync(index)) {
  fs.copyFileSync(renamed, index);
  console.log("[vercel-build] restored dist/index.html for static serving");
}

if (!fs.existsSync(index))
  fail("The frontend build produced no dist/index.html.");

// ------------------------------------------------------------- leak gate --

/**
 * Refuses to publish a frontend that contains a server secret.
 *
 * This is not hypothetical. Upstream's vite config carried
 * `define: { "process.env": process.env }`, which inlines the build machine's
 * entire environment into the bundle. On a laptop that is noise; on this
 * runner it published FOUNDER_PASSWORD_HASH, JWT_SECRET, SIG_KEY and SIG_SALT
 * to anyone who opened the JavaScript.
 *
 * The config is fixed. This exists because the next way it happens will not
 * look like the last one: it searches the built files for the VALUES of the
 * secrets this build actually holds, so any future route to the same outcome
 * fails the build instead of shipping.
 */
const SECRET_KEYS = [
  "FOUNDER_PASSWORD_HASH",
  "JWT_SECRET",
  "SIG_KEY",
  "SIG_SALT",
  "DATABASE_URL",
  "DIRECT_URL",
  "OPEN_AI_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "AZURE_OPENAI_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_LLM_API_KEY",
  "TOGETHER_AI_API_KEY",
  "PGVECTOR_CONNECTION_STRING",
];

function builtFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...builtFiles(full));
    else if (/\.(js|css|html|json|map)$/.test(entry.name)) found.push(full);
  }
  return found;
}

const secrets = SECRET_KEYS.map((key) => [key, String(process.env[key] ?? "")])
  // A short value would match by accident and say nothing.
  .filter(([, value]) => value.trim().length >= 12);

const leaks = [];
for (const file of builtFiles(dist)) {
  const contents = fs.readFileSync(file, "utf8");
  for (const [key, value] of secrets)
    if (contents.includes(value))
      leaks.push(`${key} in ${path.relative(dist, file)}`);
}

if (leaks.length) {
  // The names, never the values - a build log is not a safe place either.
  console.error("\n[vercel-build] SECRETS FOUND IN THE FRONTEND BUNDLE:");
  for (const leak of leaks) console.error(`  - ${leak}`);
  fail(
    "Refusing to publish. Fix the leak, then rotate every secret listed above - they are compromised from the moment a build carrying them is served."
  );
}

console.log(
  `[vercel-build] leak gate: checked ${secrets.length} secret value(s) against the built frontend, none present`
);

console.log("\n[vercel-build] done");
