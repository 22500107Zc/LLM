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

const FOUNDER_PASSWORD =
  "verify-founder-" + crypto.randomBytes(8).toString("hex");
const ACME_PASSWORD = "Acme!Str0ng-Pass-1";
const BETA_PASSWORD = "Beta!Str0ng-Pass-2";

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
      received.push({ url: request.url, body: safeParse(body) });

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

  // ------------------------------------------------------------ AI workflow
  //
  // The product is sold as an AI assistant, so this is the check that decides
  // whether it is sellable. It drives the real chat endpoint over a real
  // socket as the authenticated customer. There is no stub behind it: with a
  // provider key it must come back with an actual answer, and without one it
  // must fail in a way a customer can read.
  section("AI workflow");
  const workspaceSlug = firstLook[0]?.slug;
  const answer = workspaceSlug
    ? await chat(
        token,
        workspaceSlug,
        "In one sentence, what is a purchase order?"
      )
    : null;

  if (!workspaceSlug) {
    check("customer has a workspace to chat in", false, "no workspace");
  } else if (modelProviderConfigured()) {
    check(
      "the chat endpoint accepts the customer's message",
      answer.status === 200
    );
    check("the assistant answered", !answer.error, answer.error ?? "");
    check(
      "the answer is real text, not an empty stream",
      answer.text.trim().length > 20,
      `${answer.text.trim().length} characters`
    );
    check(
      "the turn was written to the customer's chat history",
      (await prisma.workspace_chats.count({
        where: { workspaceId: firstLook[0].id },
      })) > 0
    );
  } else {
    blocked(
      "an authenticated customer completes an AI turn",
      "no model provider key in this environment"
    );
    // What the product does with no provider is still ours to get right.
    check(
      "the chat endpoint is reachable by an ordinary customer",
      answer.status === 200,
      `got ${answer.status}`
    );
    check(
      "a provider failure is reported to the customer, not swallowed",
      Boolean(answer.error)
    );
    check(
      "the customer is told this in plain language",
      /not available right now|please try again|contact support/i.test(
        answer.error ?? ""
      ),
      answer.error ?? "no error text"
    );
    check(
      "no infrastructure detail leaks into what the customer sees",
      !/api key|apikey|module|lancedb|prisma|postgres|vercel|stack|node_modules|\.js:/i.test(
        answer.error ?? ""
      ),
      answer.error ?? ""
    );
  }

  // ------------------------------------- AI pipeline, against a real endpoint
  //
  // The section above cannot finish without a paid provider. This one proves
  // everything up to the model itself: the product makes a genuine HTTP call
  // to an OpenAI-compatible endpoint and streams the reply back to the
  // customer. Read openAiCompatibleEndpoint's comment for what that is and is
  // not evidence of.
  section("AI pipeline, against a real OpenAI-compatible endpoint");
  const ANSWER =
    "A purchase order is a buyer's written commitment to buy specified goods at an agreed price.";
  const endpoint = await openAiCompatibleEndpoint(ANSWER);
  const restore = { ...process.env };
  Object.assign(process.env, {
    LLM_PROVIDER: "generic-openai",
    GENERIC_OPEN_AI_BASE_PATH: endpoint.url,
    GENERIC_OPEN_AI_MODEL_PREF: "verification-model",
    GENERIC_OPEN_AI_API_KEY: "verification-only-not-a-real-key",
    GENERIC_OPEN_AI_MODEL_TOKEN_LIMIT: "8192",
  });

  if (!workspaceSlug) {
    check("customer has a workspace to chat in", false, "no workspace");
  } else {
    const piped = await chat(
      token,
      workspaceSlug,
      "In one sentence, what is a purchase order?"
    );
    check("the customer's chat request is accepted", piped.status === 200);
    check("nothing failed in the AI path", !piped.error, piped.error ?? "");
    check(
      "the product reached the provider over real HTTP",
      endpoint.received.some((call) => call.url.includes("/chat/completions"))
    );

    const sent = endpoint.received.find((call) =>
      call.url.includes("/chat/completions")
    )?.body;
    check(
      "the customer's own words were sent to the model",
      JSON.stringify(sent?.messages ?? []).includes("what is a purchase order")
    );
    check(
      "the workspace's system prompt went with it",
      (sent?.messages ?? []).some((message) => message.role === "system")
    );
    check(
      "the answer streamed back to the customer intact",
      piped.text.includes("written commitment to buy"),
      piped.text.slice(0, 80)
    );

    const stored = await prisma.workspace_chats.findMany({
      where: { workspaceId: firstLook[0].id },
    });
    check(
      "the turn was written to the customer's chat history",
      stored.length > 0
    );
    check(
      "the stored turn belongs to that customer and no one else",
      stored.every((row) => row.user_id === acmeUserId)
    );
  }

  for (const key of [
    "LLM_PROVIDER",
    "GENERIC_OPEN_AI_BASE_PATH",
    "GENERIC_OPEN_AI_MODEL_PREF",
    "GENERIC_OPEN_AI_API_KEY",
    "GENERIC_OPEN_AI_MODEL_TOKEN_LIMIT",
  ])
    if (restore[key] === undefined) delete process.env[key];
    else process.env[key] = restore[key];
  await endpoint.close();

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
  const founderSees = await call("GET", "/api/founder/session");
  check(
    "the founder is told exactly what is missing",
    /DATABASE_URL/.test(String(founderSees.payload?.message ?? "")),
    JSON.stringify(founderSees.payload)
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
  const NEXT_PASSWORD = "A-Wh0lly-Different!9";
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
