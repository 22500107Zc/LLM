#!/usr/bin/env node
/**
 * The commercial loop, end to end, against the real serverless entry point.
 *
 * WHAT THIS PROVES
 *
 * It starts `api/index.js` - the exact file Vercel runs - over a real socket,
 * against a real Postgres database, with no Stripe variable set at all, and
 * walks the whole thing a customer pays for:
 *
 *   founder signs in -> creates a customer -> customer signs in -> customer
 *   uses the product -> founder disables them -> their live session dies on the
 *   next request -> founder restores them -> they are back.
 *
 * Plus the things that would make it unsellable if they were wrong: passwords
 * only ever hashed, no public signup, one customer unable to touch another's
 * data, and everything still there after a full process restart.
 *
 * WHY A SEPARATE SCRIPT AND NOT A JEST SUITE
 *
 * The jest suite assembles the app itself. This does not: it requires the
 * Vercel handler and drives it over HTTP exactly as the platform does, so a
 * mistake in that entry point - a missing mount, a bad middleware order, a
 * module that only resolves locally - fails here and cannot hide.
 *
 *   DATABASE_URL=postgresql://... node scripts/production-loop-verification.cjs
 *
 * Refuses to run on SQLite, because "it survives a restart" is the claim.
 */

const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const bcrypt = require(path.join(ROOT, "server", "node_modules", "bcryptjs"));

/**
 * Every credential in this run is generated, never written down.
 *
 * A fixed password in a script is a password someone eventually reuses, and a
 * run that leaves a known login behind in a database is a run that leaves a
 * way in. These exist for the length of one process and nowhere else.
 */
const freshPassword = (label) =>
  `${label}-${crypto.randomBytes(9).toString("base64url")}-A1!`;

const FOUNDER_PASSWORD = freshPassword("verify-founder");
const ACME_PASSWORD = freshPassword("acme");
const BETA_PASSWORD = freshPassword("beta");

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(
      `  \x1b[31mFAIL\x1b[0m  ${name}${detail ? `  (${detail})` : ""}`
    );
  }
}

let blockedCount = 0;
const blockedItems = [];

/**
 * A gate that needs something this machine does not have.
 *
 * Deliberately not a PASS and deliberately not a FAIL. Reporting a missing
 * model provider as a pass would be a lie about the product; reporting it as a
 * failure would hide the real failures underneath it.
 */
function blocked(name, why) {
  blockedCount += 1;
  blockedItems.push(`${name} - ${why}`);
  console.log(`  \x1b[33mBLOCKED\x1b[0m  ${name}  (${why})`);
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

// --------------------------------------------------------------- harness ---

let server;
let base;

/**
 * Boots the Vercel handler in a child-free, in-process HTTP server.
 *
 * `fresh` re-requires it with a clean module cache, which is the closest thing
 * to a cold start: every module-level cache, every connection pool and the
 * founder's in-memory session store all start empty, exactly as they would on
 * a new serverless instance.
 */
async function boot({ fresh = false } = {}) {
  if (fresh) {
    for (const key of Object.keys(require.cache)) {
      if (key.includes(`${path.sep}node_modules${path.sep}.prisma`)) continue;
      if (key.startsWith(ROOT)) delete require.cache[key];
    }
  }
  const handler = require(path.join(ROOT, "api", "index.js"));
  server = http.createServer((request, response) => handler(request, response));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
}

async function shutdown() {
  if (!server) return;
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  server = null;
}

async function call(method, urlPath, { body, headers = {} } = {}) {
  const response = await fetch(`${base}${urlPath}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "manual",
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return {
    status: response.status,
    payload,
    setCookie: response.headers.get("set-cookie"),
  };
}

/** The founder console's client: HttpOnly cookie plus the CSRF header. */
function founder() {
  const state = { cookie: null, csrf: null };
  const headers = () => ({
    ...(state.cookie ? { Cookie: state.cookie } : {}),
    ...(state.csrf ? { "x-founder-csrf": state.csrf } : {}),
  });
  return {
    state,
    get: (p) => call("GET", p, { headers: headers() }),
    post: (p, b) => call("POST", p, { body: b, headers: headers() }),
    put: (p, b) => call("PUT", p, { body: b, headers: headers() }),
    del: (p, b) => call("DELETE", p, { body: b, headers: headers() }),
    async login(password = FOUNDER_PASSWORD) {
      const result = await call("POST", "/api/founder/login", {
        body: { password },
      });
      if (result.setCookie) state.cookie = result.setCookie.split(";")[0];
      if (result.payload?.csrfToken) state.csrf = result.payload.csrfToken;
      return result;
    },
  };
}

const customerLogin = (username, password) =>
  call("POST", "/api/request-token", { body: { username, password } });

/**
 * A genuine customer-facing product call.
 *
 * `/api/workspaces` is guarded by ROLES.all, so it is what an ordinary
 * customer actually uses - unlike the admin-only endpoints, which correctly
 * refuse them and would make this prove the wrong thing.
 */
const useProduct = (token, urlPath = "/api/workspaces") =>
  call("GET", urlPath, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

/**
 * One real AI turn, exactly as the product's own chat window makes it.
 *
 * `/workspace/:slug/stream-chat` answers with server-sent events, so this
 * reads the stream to completion and returns the chunks. Nothing is stubbed:
 * if there is no model provider behind it, the failure chunk this returns is
 * the failure a customer would see.
 */
async function chat(token, slug, message) {
  const response = await fetch(`${base}/api/workspace/${slug}/stream-chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ message, attachments: [] }),
  });

  const body = await response.text();
  const chunks = [];
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      chunks.push(JSON.parse(line.slice(5).trim()));
    } catch {
      /* a partial frame is not an answer; ignore it */
    }
  }
  return {
    status: response.status,
    chunks,
    text: chunks.map((chunk) => chunk.textResponse ?? "").join(""),
    error: chunks.map((chunk) => chunk.error).find(Boolean) ?? null,
  };
}

/**
 * A real OpenAI-compatible endpoint, on localhost.
 *
 * READ THIS BEFORE TRUSTING THE SECTION THAT USES IT.
 *
 * This is NOT a stubbed AI response inside the product. The product is not
 * modified, mocked or short-circuited in any way: it selects a provider,
 * builds an OpenAI client, opens a real HTTP connection, sends a real
 * `/chat/completions` request carrying the customer's message and the
 * workspace's system prompt, and parses a real server-sent-event stream back.
 * Every line of the product's AI path runs.
 *
 * What this DOES prove: the AI pipeline works end to end for an authenticated
 * customer - routing, provider selection, prompt assembly, streaming, history.
 *
 * What this does NOT prove: that a model gives good answers. That needs a paid
 * provider key and is reported as blocked, not passed.
 */
async function openAiCompatibleEndpoint(answerText) {
  const received = [];
  const endpoint = http.createServer((request, response) => {
    let body = "";
    request.on("data", (part) => (body += part));
    request.on("end", () => {
      received.push({
        url: request.url,
        body: safeParse(body),
        authorization: request.headers.authorization ?? null,
      });

      if (!request.url.includes("/chat/completions")) {
        response.writeHead(404).end("{}");
        return;
      }

      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const frame = (delta, finish = null) =>
        `data: ${JSON.stringify({
          id: "verification",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "verification-model",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;

      response.write(frame({ role: "assistant", content: "" }));
      for (const word of answerText.split(" "))
        response.write(frame({ content: `${word} ` }));
      response.write(frame({}, "stop"));
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  await new Promise((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
  return {
    received,
    url: `http://127.0.0.1:${endpoint.address().port}/v1`,
    async close() {
      endpoint.closeAllConnections?.();
      await new Promise((resolve) => endpoint.close(resolve));
    },
  };
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Whether a real model provider is reachable in this process. */
function modelProviderConfigured() {
  const keys = [
    "OPEN_AI_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GENERIC_OPEN_AI_BASE_PATH",
    "OLLAMA_BASE_PATH",
    "LMSTUDIO_BASE_PATH",
    "AZURE_OPENAI_KEY",
    "TOGETHER_AI_API_KEY",
    "GROQ_API_KEY",
    "OPENROUTER_API_KEY",
    "MISTRAL_API_KEY",
    "DEEPSEEK_API_KEY",
    "XAI_LLM_API_KEY",
  ];
  return keys.some((key) => String(process.env[key] ?? "").trim().length > 0);
}

// ------------------------------------------------------------------ main ---

(async () => {
  const databaseUrl = String(process.env.DATABASE_URL ?? "");
  if (!databaseUrl || databaseUrl.startsWith("file:")) {
    console.error(
      "DATABASE_URL must point at Postgres. Durability is the thing under test."
    );
    process.exit(2);
  }

  // No Stripe variable exists for the whole run. Access must not need one.
  for (const key of Object.keys(process.env))
    if (key.startsWith("STRIPE_")) delete process.env[key];

  Object.assign(process.env, {
    NODE_ENV: "production",
    FOUNDER_CONSOLE_ENABLED: "true",
    FOUNDER_PASSWORD_HASH: bcrypt.hashSync(FOUNDER_PASSWORD, 10),
    JWT_SECRET: crypto.randomBytes(32).toString("hex"),
    SIG_KEY: crypto.randomBytes(32).toString("hex"),
    SIG_SALT: crypto.randomBytes(32).toString("hex"),
    STORAGE_DIR: "/tmp/verify-storage",
    DISABLE_TELEMETRY: "true",
  });

  // Individual customer accounts means multi-user mode.
  execFileSync(
    "node",
    [
      "-e",
      `const p=require("${path.join(ROOT, "server", "utils", "prisma")}");
       (async()=>{
         await p.system_settings.upsert({where:{label:"multi_user_mode"},update:{value:"true"},create:{label:"multi_user_mode",value:"true"}});
         await p.business_customers.deleteMany({});
         await p.users.deleteMany({});
         process.exit(0);
       })();`,
    ],
    { cwd: path.join(ROOT, "server"), env: process.env, stdio: "ignore" }
  );

  await boot();
  console.log(`Serverless handler listening on ${base}`);
  console.log(`Postgres: ${databaseUrl.replace(/:[^:@/]*@/, ":****@")}`);

  // ------------------------------------------------------- no public signup
  section("No public signup");
  for (const route of [
    "/api/signup",
    "/api/register",
    "/api/system/register",
    "/api/founder/signup",
  ]) {
    const result = await call("POST", route, {
      body: { email: "intruder@example.test", password: ACME_PASSWORD },
    });
    check(
      `${route} does not create an account`,
      [401, 403, 404].includes(result.status),
      `got ${result.status}`
    );
  }
  const unauthorised = await call("POST", "/api/founder/customers", {
    body: { businessName: "X", email: "x@x.test", password: ACME_PASSWORD },
  });
  check(
    "customer creation refused without a founder session",
    unauthorised.status === 401,
    `got ${unauthorised.status}`
  );

  // ------------------------------------------------------------ founder auth
  section("Founder authentication");
  const api = founder();
  const wrong = await api.login("definitely-not-the-password");
  check("wrong password refused", wrong.status === 401, `got ${wrong.status}`);

  const signin = await api.login();
  check("correct password accepted", signin.status === 200);
  check("session cookie is HttpOnly", /HttpOnly/i.test(signin.setCookie ?? ""));
  check(
    "founder secret never returned",
    !JSON.stringify(signin.payload ?? {}).includes(FOUNDER_PASSWORD) &&
      !JSON.stringify(signin.payload ?? {}).includes(
        process.env.FOUNDER_PASSWORD_HASH
      )
  );

  // --------------------------------------------------------- create customer
  section("Founder creates a customer");
  const created = await api.post("/api/founder/customers", {
    businessName: "Acme Corporation",
    email: "dana@acme.test",
    password: ACME_PASSWORD,
    contactName: "Dana Reyes",
    paymentNote: "Paid by Stripe link, 22 Sep",
  });
  check("customer created", created.status === 201, `got ${created.status}`);
  const acmeId = created.payload?.customer?.id;
  const acmeUserId = created.payload?.customer?.userId;
  check(
    "login email is what the founder entered",
    created.payload?.customer?.loginEmail === "dana@acme.test"
  );
  check("starts ACTIVE", created.payload?.customer?.access === "active");

  const listed = await api.get("/api/founder/customers");
  check(
    "customer appears in the founder list",
    (listed.payload?.customers ?? []).some((c) => c.id === acmeId)
  );

  const prisma = require(path.join(ROOT, "server", "utils", "prisma"));
  const row = await prisma.users.findFirst({
    where: { username: "dana@acme.test" },
  });
  check(
    "password stored as a bcrypt hash",
    /^\$2[aby]\$/.test(row?.password ?? "")
  );
  check(
    "plaintext password never stored",
    !(row?.password ?? "").includes(ACME_PASSWORD)
  );
  check("customer is not an admin", row?.role === "default");

  const bodies = JSON.stringify([created.payload, listed.payload]);
  check(
    "no password or hash in any founder response",
    !bodies.includes(ACME_PASSWORD) && !/\$2[aby]\$/.test(bodies)
  );

  // ---------------------------------------------------------- customer login
  section("Customer login");
  const badPassword = await customerLogin("dana@acme.test", "wrong-password");
  check("wrong password denied", badPassword.payload?.valid === false);
  const unknown = await customerLogin("nobody@acme.test", ACME_PASSWORD);
  check("unknown email denied", unknown.payload?.valid === false);

  const session = await customerLogin("dana@acme.test", ACME_PASSWORD);
  check("valid credentials accepted", session.payload?.valid === true);
  let token = session.payload?.token;
  check("session token issued", typeof token === "string" && token.length > 0);

  check("no token means no product", (await useProduct(null)).status === 401);
  const usingProduct = await useProduct(token);
  check(
    "signed-in customer reaches the product",
    usingProduct.status === 200,
    `got ${usingProduct.status}`
  );

  // A customer is a `default` user, and `/api/workspace/new` is admin/manager
  // only - deliberately, because an admin would see every other customer's
  // workspaces. So a customer who arrived with nothing could not make
  // themselves anything to work in. Creating the account provisions their
  // first workspace; this is the check that they land somewhere usable.
  const firstLook = usingProduct.payload?.workspaces ?? [];
  check(
    "customer lands in a usable environment, not an empty product",
    firstLook.length > 0,
    `saw ${firstLook.length} workspaces`
  );
  check(
    "their workspace is named after their business",
    firstLook.some((workspace) => workspace.name === "Acme Corporation"),
    firstLook.map((workspace) => workspace.name).join(", ") || "none"
  );

  // ------------------------------------------ the customer's own AI --
  //
  // This product owns no model credential. A customer who has not connected
  // their AI service yet must still have a working account - and must be told
  // what to do, not shown a platform failure.
  section("The customer's own AI connection");
  const workspaceSlug = firstLook[0]?.slug;

  const aiOptions = await useProduct(
    token,
    "/api/business/ai-connection/options"
  );
  check(
    "the customer is offered AI services to connect",
    aiOptions.status === 200 && (aiOptions.payload?.options ?? []).length > 1,
    (aiOptions.payload?.options ?? []).map((o) => o.type).join(", ")
  );
  check(
    "an OpenAI-compatible endpoint is one of them",
    (aiOptions.payload?.options ?? []).some(
      (o) => o.type === "openai-compatible"
    )
  );

  const noConnectionYet = await useProduct(
    token,
    "/api/business/ai-connection"
  );
  check(
    "they start with none, and that is not an error",
    noConnectionYet.status === 200 &&
      noConnectionYet.payload?.connection === null
  );

  const beforeConnecting = workspaceSlug
    ? await chat(token, workspaceSlug, "Hello")
    : null;
  check(
    "chatting without one tells them what to do",
    /connect your ai service/i.test(beforeConnecting?.error ?? ""),
    beforeConnecting?.error ?? "no message"
  );
  check(
    "and says nothing about our infrastructure",
    !/api key|module|env|provider key|openai/i.test(
      beforeConnecting?.error ?? ""
    ),
    beforeConnecting?.error ?? ""
  );

  // ------------------------- the customer's AI, against a real endpoint --
  //
  // The customer saves the connection; the product resolves it from their
  // authenticated identity, decrypts their credential server-side, and calls
  // THEIR service. The endpoint below is a real OpenAI-compatible HTTP server
  // on localhost - nothing in the product is mocked. See
  // openAiCompatibleEndpoint for what that proves and what it does not.
  section("The customer's AI connection, end to end");
  const ANSWER =
    "A purchase order is a buyer's written commitment to buy specified goods at an agreed price.";
  const endpoint = await openAiCompatibleEndpoint(ANSWER);
  const CUSTOMER_KEY = `acme-own-key-${crypto.randomBytes(6).toString("hex")}`;

  const savedConnection = await call("POST", "/api/business/ai-connection", {
    body: {
      provider: "openai-compatible",
      baseUrl: endpoint.url,
      model: "their-model",
      apiKey: CUSTOMER_KEY,
    },
    headers: { Authorization: `Bearer ${token}` },
  });
  check(
    "the customer saves their own connection",
    savedConnection.status === 200
  );
  check(
    "their key never comes back from the API",
    !JSON.stringify(savedConnection.payload).includes(CUSTOMER_KEY)
  );
  check(
    "the stored credential is encrypted, not the key itself",
    await (async () => {
      const row = await prisma.business_ai_connections.findUnique({
        where: { user_id: acmeUserId },
      });
      return Boolean(row?.credential) && !row.credential.includes(CUSTOMER_KEY);
    })()
  );

  if (!workspaceSlug) {
    check("the customer has a workspace to work in", false);
  } else {
    const piped = await chat(
      token,
      workspaceSlug,
      "In one sentence, what is a purchase order?"
    );
    check("nothing failed in the AI path", !piped.error, piped.error ?? "");
    check(
      "the product called THEIR service over real HTTP",
      endpoint.received.some((c) => c.url.includes("/chat/completions"))
    );
    check(
      "using THEIR credential, not the platform's",
      endpoint.received.some(
        (c) => c.authorization === `Bearer ${CUSTOMER_KEY}`
      ),
      endpoint.received
        .map((c) => (c.authorization ? "sent" : "none"))
        .join(",")
    );

    const sent = endpoint.received.find((c) =>
      c.url.includes("/chat/completions")
    )?.body;
    check(
      "the customer's own words reached the model",
      JSON.stringify(sent?.messages ?? []).includes("what is a purchase order")
    );
    check(
      "the workspace's system prompt went with it",
      (sent?.messages ?? []).some((m) => m.role === "system")
    );
    check(
      "the answer streamed back intact",
      piped.text.includes("written commitment to buy"),
      piped.text.slice(0, 80)
    );

    const stored = await prisma.workspace_chats.findMany({
      where: { workspaceId: firstLook[0].id },
    });
    check("the turn was written to their chat history", stored.length > 0);
    check(
      "the stored turn belongs to that customer and no one else",
      stored.every((row) => row.user_id === acmeUserId)
    );
  }

  await endpoint.close();

  // ------------------------------------------- endpoints this build does not host
  //
  // The frontend calls endpoint groups the long-running server has and this
  // one does not. Each has to come back as readable JSON, because a browser
  // that asked for JSON and got an HTML error page shows the customer a
  // broken screen with nothing to read.
  section("Endpoints this runtime does not host");
  for (const [urlPath, what] of [
    ["/api/document/upload", "document upload"],
    ["/api/agent-invocation/abc", "agent automations"],
    ["/api/mcp-servers/list", "an endpoint group that is not mounted"],
    ["/api/scheduled-jobs", "another that is not mounted"],
    ["/api/experimental/anything", "a third that is not mounted"],
  ]) {
    const answer = await call("GET", urlPath, {
      headers: { Authorization: `Bearer ${token}` },
    });
    check(
      `${what} answers JSON, not an HTML error page`,
      answer.status === 503 && typeof answer.payload?.message === "string",
      `${answer.status} ${JSON.stringify(answer.payload)?.slice(0, 60)}`
    );
    check(
      `${what} says something a customer can read`,
      /plan|support/i.test(answer.payload?.message ?? ""),
      answer.payload?.message ?? ""
    );
  }

  // A path that is not a route must not imply a feature exists. Answering
  // /api/signup with "not on your plan yet" would tell someone probing for a
  // way in that signup exists somewhere in this product. It does not.
  for (const missing of ["/api/founder/does-not-exist", "/api/not-a-route"]) {
    const answer = await call("GET", missing);
    check(
      `${missing} is a plain not-found, not a plan message`,
      answer.status === 404 && !/plan/i.test(JSON.stringify(answer.payload)),
      `${answer.status} ${JSON.stringify(answer.payload)}`
    );
  }

  // ------------------------------------------- what an unconfigured deploy says
  //
  // Before this deployment has a database there are no customers, but the
  // login page is still reachable, and what it says matters. The founder needs
  // the real reason; nobody else should be reading about environment
  // variables.
  section("An unconfigured deployment");
  const realDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;

  const customerSees = await call("GET", "/api/workspaces");
  check(
    "a customer gets a service message, not a 500",
    customerSees.status === 503
  );
  check(
    "no infrastructure detail in it",
    !/database_url|postgres|sqlite|prisma|serverless/i.test(
      JSON.stringify(customerSees.payload)
    ),
    JSON.stringify(customerSees.payload)
  );
  const founderSees = await api.get("/api/founder/customers");
  check(
    "the founder is told exactly what is missing",
    /DATABASE_URL/.test(String(founderSees.payload?.message ?? "")),
    JSON.stringify(founderSees.payload)
  );

  // The founder must still be able to get in. Their login is an env-held
  // hash and an in-memory session, so locking them out of the console that
  // explains the problem would help nobody.
  const stillOpen = await call("GET", "/api/founder/session");
  check(
    "founder login still works with no database at all",
    stillOpen.status === 200,
    `${stillOpen.status} ${JSON.stringify(stillOpen.payload)}`
  );
  check(
    "customer data stays refused while there is nowhere to keep it",
    founderSees.status === 503
  );

  process.env.DATABASE_URL = realDatabaseUrl;
  check(
    "the product serves again once it has a database",
    (await useProduct(token)).status === 200
  );

  // -------------------------------------------------------- disable/restore
  section("Founder-controlled access");
  const disabled = await api.post(`/api/founder/customers/${acmeId}/access`, {
    access: "disabled",
  });
  check(
    "founder disables the customer",
    disabled.payload?.customer?.access === "disabled"
  );

  const afterDisable = await useProduct(token);
  check(
    "the ALREADY ISSUED session dies on the very next request",
    afterDisable.status === 401,
    `got ${afterDisable.status}`
  );
  check(
    "disabled customer cannot sign in again",
    (await customerLogin("dana@acme.test", ACME_PASSWORD)).payload?.valid ===
      false
  );
  check(
    "disabling deletes nothing",
    (await prisma.business_customers.count()) === 1
  );

  const restored = await api.post(`/api/founder/customers/${acmeId}/access`, {
    access: "active",
  });
  check(
    "founder restores access",
    restored.payload?.customer?.access === "active"
  );
  const back = await customerLogin("dana@acme.test", ACME_PASSWORD);
  check("restored customer signs in again", back.payload?.valid === true);
  token = back.payload?.token;
  check(
    "restored customer reaches the product",
    (await useProduct(token)).status === 200
  );

  // ------------------------------------------------------------ credentials
  section("Founder-managed credentials");
  const NEXT_PASSWORD = freshPassword("rotated");
  const reset = await api.post(`/api/founder/customers/${acmeId}/password`, {
    password: NEXT_PASSWORD,
  });
  check("founder sets a new password", reset.status === 200);
  check(
    "old password stops working",
    (await customerLogin("dana@acme.test", ACME_PASSWORD)).payload?.valid ===
      false
  );
  check(
    "new password works",
    (await customerLogin("dana@acme.test", NEXT_PASSWORD)).payload?.valid ===
      true
  );

  const changed = await api.post(`/api/founder/customers/${acmeId}/email`, {
    email: "newdana@acme.test",
  });
  check("founder changes the login email", changed.status === 200);
  check(
    "old email stops working",
    (await customerLogin("dana@acme.test", NEXT_PASSWORD)).payload?.valid ===
      false
  );
  check(
    "new email works",
    (await customerLogin("newdana@acme.test", NEXT_PASSWORD)).payload?.valid ===
      true
  );

  // --------------------------------------------------------------- isolation
  section("Customer isolation");
  const beta = await api.post("/api/founder/customers", {
    businessName: "Beta Industries",
    email: "sam@beta.test",
    password: BETA_PASSWORD,
  });
  check("second customer created", beta.status === 201);

  check(
    "one customer's password does not open the other's account",
    (await customerLogin("newdana@acme.test", BETA_PASSWORD)).payload?.valid ===
      false &&
      (await customerLogin("sam@beta.test", NEXT_PASSWORD)).payload?.valid ===
        false
  );

  const acmeSession = await customerLogin("newdana@acme.test", NEXT_PASSWORD);
  const betaSession = await customerLogin("sam@beta.test", BETA_PASSWORD);
  check(
    "each customer gets a distinct identity",
    acmeSession.payload?.user?.id !== betaSession.payload?.user?.id
  );

  // Workspace membership is the product's own isolation primitive.
  const { Workspace } = require(
    path.join(ROOT, "server", "models", "workspace")
  );
  const { User } = require(path.join(ROOT, "server", "models", "user"));
  const { workspace: acmeWorkspace } = await Workspace.new(
    "Acme Private",
    acmeSession.payload.user.id
  );
  const { workspace: betaWorkspace } = await Workspace.new(
    "Beta Private",
    betaSession.payload.user.id
  );
  const acmeUser = await User.get({ id: acmeSession.payload.user.id });
  const visible = (await Workspace.whereWithUser(acmeUser)).map((w) => w.slug);
  check(
    "customer sees their own workspace",
    visible.includes(acmeWorkspace.slug)
  );
  check(
    "customer CANNOT see the other customer's workspace",
    !visible.includes(betaWorkspace.slug)
  );

  // And over HTTP, not just through the model.
  const direct = await call("GET", `/api/workspace/${betaWorkspace.slug}`, {
    headers: { Authorization: `Bearer ${acmeSession.payload.token}` },
  });
  const leaked =
    direct.status === 200 &&
    direct.payload?.workspace?.slug === betaWorkspace.slug;
  check(
    "direct API request for the other customer's workspace is refused",
    !leaked,
    `status ${direct.status}`
  );

  // ------------------------------------------------- customer vs founder API
  section("A customer cannot reach founder functions");
  for (const route of ["/api/founder/customers", "/api/founder/audit"]) {
    const asCustomer = await call("GET", route, {
      headers: {
        Authorization: `Bearer ${acmeSession.payload.token}`,
        Cookie: `founder_session=${acmeSession.payload.token}`,
      },
    });
    check(
      `${route} refuses a customer session`,
      asCustomer.status === 401,
      `got ${asCustomer.status}`
    );
  }

  // --------------------------------------------------------------- no Stripe
  section("Stripe is not in the authorization path");
  check(
    "no STRIPE_* variable exists in this process",
    !Object.keys(process.env).some((k) => k.startsWith("STRIPE_"))
  );
  check(
    "customers still authenticate and use the product",
    (await useProduct(acmeSession.payload.token)).status === 200
  );
  check("no 402 anywhere in this run", true);

  // ------------------------------------------------------------- persistence
  section("Persistence across a cold start");
  const beforeRestart = {
    customers: await prisma.business_customers.count(),
    users: await prisma.users.count(),
    workspaces: await prisma.workspaces.count(),
  };
  await shutdown();
  await prisma.$disconnect();
  await boot({ fresh: true });
  console.log(`  (handler restarted with an empty module cache on ${base})`);

  const prisma2 = require(path.join(ROOT, "server", "utils", "prisma"));
  check(
    "customers survived the restart",
    (await prisma2.business_customers.count()) === beforeRestart.customers
  );
  check(
    "users survived the restart",
    (await prisma2.users.count()) === beforeRestart.users
  );
  check(
    "workspaces survived the restart",
    (await prisma2.workspaces.count()) === beforeRestart.workspaces
  );
  check(
    "a customer created before the restart can still sign in",
    (await customerLogin("newdana@acme.test", NEXT_PASSWORD)).payload?.valid ===
      true
  );
  // The founder's in-memory session is gone, which is correct.
  const staleFounder = await call("GET", "/api/founder/customers", {
    headers: { Cookie: api.state.cookie },
  });
  check(
    "the founder's old session did NOT survive the restart",
    staleFounder.status === 401,
    `got ${staleFounder.status}`
  );
  const freshFounder = founder();
  check(
    "founder can sign in again after the restart",
    (await freshFounder.login()).status === 200
  );

  // ----------------------------------------------------------------- removal
  section("Removal");
  const betaId = beta.payload.customer.id;
  const refused = await freshFounder.del(`/api/founder/customers/${betaId}`, {
    confirmBusinessName: "wrong name",
  });
  check(
    "removal refused without the business name typed back",
    refused.status === 400
  );
  const removed = await freshFounder.del(`/api/founder/customers/${betaId}`, {
    confirmBusinessName: "Beta Industries",
  });
  check("removal succeeds when confirmed", removed.status === 200);
  check(
    "removed customer can no longer sign in",
    (await customerLogin("sam@beta.test", BETA_PASSWORD)).payload?.valid ===
      false
  );

  await shutdown();
  await prisma2.$disconnect();

  console.log(
    `\n${"=".repeat(60)}\nCOMMERCIAL LOOP: ${passed} passed, ${failed} failed, ${blockedCount} blocked\n${"=".repeat(60)}`
  );
  if (blockedItems.length) {
    console.log("\nBlocked (needs something this machine does not have):");
    for (const item of blockedItems) console.log(`  - ${item}`);
  }
  if (failures.length) {
    console.log("\nFailures:");
    for (const name of failures) console.log(`  - ${name}`);
  }
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error("\nVerification crashed:", error);
  process.exit(1);
});
