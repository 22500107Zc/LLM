/**
 * Vercel serverless entry point.
 *
 * WHAT THIS IS
 *
 * The same application, assembled for a runtime with no durable filesystem and
 * no long-running process. It mounts the parts of the product that genuinely
 * work there and deliberately leaves out the parts that do not, rather than
 * mounting everything and letting a customer discover the difference by
 * hitting an error.
 *
 * WHAT WORKS HERE
 *
 *   - the founder console and its API (/api/founder/*)
 *   - customer login (/api/request-token) and session validation
 *   - the business API (/api/business/*) and the platform surface
 *   - admin, workspace, invite and system endpoints
 *
 * WHAT DOES NOT, AND WHY
 *
 *   - Document upload and parsing. The collector is a second long-running
 *     Node service on its own port; there is nothing here to run it.
 *   - Native embeddings (@xenova/transformers) and LanceDB. Both persist to
 *     local disk, which this runtime does not keep, and together they are
 *     larger than a function bundle is allowed to be. Retrieval runs on
 *     pgvector against the same Postgres instead - see selectVectorStore.
 *   - Agent websockets. Vercel supports websockets, but through its own
 *     upgrade mechanism rather than the express-ws the product uses.
 *
 * See VERCEL.md for the measurements behind each of those.
 *
 * PERSISTENCE
 *
 * DATABASE_URL must point at Postgres. On SQLite every customer account, every
 * password hash and every access decision would be lost the next time the
 * function cold-starts. This file refuses to pretend otherwise: it fails
 * loudly at boot rather than serving a login page backed by a disk that is
 * about to disappear.
 */

const path = require("path");

const SERVER_DIR = path.resolve(__dirname, "..", "server");

// Anything that insists on a writable path gets the one writable path there
// is. It is per-instance and temporary, which is correct for scratch space and
// would be wrong for anything else.
process.env.STORAGE_DIR = process.env.STORAGE_DIR || "/tmp/storage";
require("fs").mkdirSync(path.join(process.env.STORAGE_DIR, "tmp"), {
  recursive: true,
});

/**
 * Retrieval, on the one database this deployment already has.
 *
 * The default vector store is LanceDB, which writes to local disk and is not
 * in this bundle - requiring it here would crash the chat endpoint with a
 * module error the customer would see. pgvector is the alternative that needs
 * no second service: it is the `pg` client against the same Postgres.
 *
 * Nothing here creates a table or an extension. If the database has no
 * `vector` extension the provider answers "no embeddings" - which is true -
 * and conversation still works; only retrieval over uploaded documents does
 * not, and document upload is unavailable here anyway.
 */
/**
 * Turns off the parts of the product this runtime cannot actually run.
 *
 * Agent chat is the one that bites silently: the default chat mode is
 * "automatic", and with a tool-calling model that sends every message to the
 * agent flow, which answers with a websocket address. Here that address goes
 * nowhere, so the customer would watch the chat hang with no error at all.
 */
function disableWhatCannotWork() {
  process.env.DISABLE_AGENT_CHAT = "true";
}

/**
 * Supabase Postgres, from a serverless function.
 *
 * A function scales to many instances, each with its own connection pool, and
 * a Postgres server has a fixed number of connections. Supabase answers that
 * with a pooler; this makes sure we actually use it rather than opening a
 * direct connection per instance and exhausting the server under load.
 *
 *   - `pgbouncer=true` tells Prisma to stop using prepared statements, which
 *     a transaction-mode pooler cannot keep across queries.
 *   - `connection_limit=1` is right for a function: the instance handles one
 *     request at a time and the pooler does the sharing.
 *
 * Both are added only when absent, so an explicit choice in the connection
 * string always wins. A direct (non-pooled) URL is left exactly as given -
 * migrations need one, and silently rewriting it would break them.
 */
function tuneDatabaseUrl() {
  const raw = String(process.env.DATABASE_URL ?? "").trim();
  if (!raw.startsWith("postgres")) return;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return; // persistenceProblem() will have its say
  }

  const pooled =
    url.port === "6543" ||
    url.hostname.includes("pooler.") ||
    url.hostname.startsWith("pgbouncer");
  if (!pooled) return;

  if (!url.searchParams.has("pgbouncer"))
    url.searchParams.set("pgbouncer", "true");
  if (!url.searchParams.has("connection_limit"))
    url.searchParams.set("connection_limit", "1");

  process.env.DATABASE_URL = url.toString();
}

function selectVectorStore() {
  if (!process.env.VECTOR_DB) process.env.VECTOR_DB = "pgvector";
  if (process.env.VECTOR_DB !== "pgvector") return;
  if (!process.env.PGVECTOR_CONNECTION_STRING)
    process.env.PGVECTOR_CONNECTION_STRING = process.env.DATABASE_URL;
}

/**
 * Refuses to boot on a database that cannot survive a cold start.
 *
 * Returning a clear 500 is better than appearing to work: a founder would
 * otherwise create a customer, see it succeed, and find it gone an hour later.
 */
function persistenceProblem() {
  const url = String(process.env.DATABASE_URL ?? "").trim();
  if (!url)
    return "DATABASE_URL is not set. This deployment needs a Postgres connection string; customer accounts cannot be stored on a serverless filesystem.";
  if (url.startsWith("file:") || url.endsWith(".db"))
    return "DATABASE_URL points at a SQLite file. A serverless instance does not keep its filesystem, so every customer account would be lost on the next cold start. Use Postgres.";
  return null;
}

let app = null;
let bootError = null;

function build() {
  const express = require("express");
  const bodyParser = require("body-parser");
  const cors = require("cors");

  const application = express();
  application.disable("x-powered-by");

  // Vercel terminates TLS and forwards the client address. Without this,
  // `request.ip` is the proxy, and the founder login rate limit would count
  // every attempt in the world against one bucket.
  application.set("trust proxy", true);

  application.use(cors({ origin: true }));
  application.use(bodyParser.text({ limit: "10mb" }));
  application.use(bodyParser.json({ limit: "10mb" }));
  application.use(bodyParser.urlencoded({ extended: true, limit: "10mb" }));

  // The founder plane first, on its own prefix, exactly as the long-running
  // server mounts it - ahead of the customer API and sharing none of its
  // middleware.
  const { founderRoutes } = require(
    path.join(SERVER_DIR, "business", "founder", "routes")
  );
  founderRoutes(application);

  const apiRouter = express.Router();
  application.use("/api", apiRouter);

  const { requireAuthenticatedMode } = require(
    path.join(SERVER_DIR, "business", "middleware", "requireAuthenticatedMode")
  );
  apiRouter.use(requireAuthenticatedMode);

  // The product's own endpoints. Login lives in systemEndpoints.
  require(path.join(SERVER_DIR, "endpoints", "system")).systemEndpoints(
    apiRouter
  );
  require(path.join(SERVER_DIR, "endpoints", "admin")).adminEndpoints(
    apiRouter
  );
  require(path.join(SERVER_DIR, "endpoints", "invite")).inviteEndpoints(
    apiRouter
  );
  require(path.join(SERVER_DIR, "endpoints", "workspaces")).workspaceEndpoints(
    apiRouter
  );
  require(
    path.join(SERVER_DIR, "endpoints", "workspaceThreads")
  ).workspaceThreadEndpoints(apiRouter);
  require(path.join(SERVER_DIR, "endpoints", "chat")).chatEndpoints(apiRouter);

  // The commercial business API.
  require(path.join(SERVER_DIR, "business", "routes")).businessEndpoints(
    apiRouter
  );

  // Features this runtime cannot host answer with something a business person
  // can act on. No status code a customer would read as a crash, no stack
  // trace, and no infrastructure vocabulary - they did not buy a deployment,
  // they bought a product.
  const unavailable = (feature) => (_request, response) =>
    response.status(503).json({
      error: "feature_unavailable",
      message: `${feature} is not enabled on your plan yet. Everything else works normally - contact support if you need it.`,
    });

  apiRouter.use("/document", unavailable("Document upload"));
  apiRouter.use("/agent-invocation", unavailable("Agent automations"));

  // Endpoint groups the product has and this runtime does not mount.
  //
  // Each of these exists in the long-running server. Here they would need a
  // filesystem, a websocket or a second service, so they are not mounted -
  // and without this the call lands on Express's default handler and the
  // browser gets an HTML error page where it asked for JSON, which a customer
  // sees as a screen that simply broke.
  const NOT_ON_THIS_RUNTIME = [
    "/ext",
    "/model-routers",
    "/embed",
    "/embeds",
    "/utils",
    "/agent-skills",
    "/agent-flows",
    "/mcp-servers",
    "/mobile",
    "/web-push",
    "/telegram",
    "/scheduled-jobs",
    "/memories",
    "/community-hub",
    "/browser-extension",
    "/experimental",
    "/v1",
  ];
  for (const prefix of NOT_ON_THIS_RUNTIME)
    apiRouter.use(prefix, unavailable("That feature"));

  // Anything else under /api is simply not a route. Saying "not on your plan"
  // here would be worse than useless - it would tell someone probing
  // /api/signup that signup exists somewhere, which it does not.
  apiRouter.use((_request, response) =>
    response.status(404).json({ error: "not_found" })
  );

  // Nothing below Express should ever reach a customer as a stack trace.
  application.use((error, request, response, _next) => {
    console.error(
      "[vercel] unhandled error:",
      request.method,
      request.url,
      error
    );
    if (response.headersSent) return response.end();
    return response.status(500).json({
      error: "server_error",
      message:
        "Something went wrong on our side. It has been logged - please try again.",
    });
  });

  return application;
}

/**
 * Answers before Express exists.
 *
 * Both failure paths here run when the Express app could not be built, so they
 * cannot use `response.status().json()` - those are Express helpers. Vercel's
 * Node runtime happens to add its own, but relying on them means the code that
 * reports a misconfiguration is the code most likely to throw while doing it.
 * Plain Node works everywhere.
 */
function fail(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

/**
 * Whether this request came from the founder's own console.
 *
 * The founder is the person who can fix a misconfiguration and needs to be
 * told what it is. A customer is not, and telling them which environment
 * variable is missing is both useless to them and more than they should know
 * about how this runs.
 */
const isFounderSurface = (request) =>
  String(request.url ?? "").startsWith("/api/founder");

/**
 * The founder's surface that genuinely does not touch the database.
 *
 * Login is an env-held bcrypt hash and an in-memory session; the audit write
 * that follows already fails soft. Refusing these would lock the one person
 * who can fix a misconfiguration out of the console that tells them what is
 * wrong. Everything else stays refused - nothing here reads or writes
 * customer data.
 */
const DATABASE_FREE = [
  "/api/founder/login",
  "/api/founder/session",
  "/api/founder/logout",
  "/api/founder/readiness",
];

const needsDatabase = (request) =>
  !DATABASE_FREE.includes(String(request.url ?? "").split("?")[0]);

module.exports = (request, response) => {
  const problem = needsDatabase(request) ? persistenceProblem() : null;
  if (problem) {
    console.error("[vercel] refusing to serve:", problem);
    return fail(
      response,
      503,
      isFounderSurface(request)
        ? { error: "misconfigured", message: problem }
        : {
            error: "unavailable",
            message:
              "The service is not available right now. Please try again shortly.",
          }
    );
  }

  if (!app && !bootError) {
    tuneDatabaseUrl();
    selectVectorStore();
    disableWhatCannotWork();
    try {
      app = build();
    } catch (error) {
      bootError = error;
      console.error("[vercel] failed to build the application:", error);
    }
  }
  if (bootError)
    // The reason stays in the logs. A customer gets nothing they could use,
    // and no stack trace.
    return fail(response, 500, {
      error: "boot_failed",
      message: "The application could not start. This has been logged.",
    });

  return app(request, response);
};
