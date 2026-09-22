/**
 * Founder-controlled customer accounts.
 *
 * The product model these pin down:
 *
 *   One application. The founder decides who is in it. Payment happens
 *   outside, through a Stripe-hosted link sent by email, and the application
 *   never asks Stripe anything. A customer account works because the founder
 *   created it and has not disabled it.
 *
 * These run against a real Express app over a real socket and a real database,
 * because the things worth pinning down are HTTP- and persistence-level:
 * whether a disabled customer's existing session really stops working, whether
 * a password is really only ever a hash, whether a customer's credentials
 * really buy nothing on the founder API.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");

const FOUNDER_PASSWORD = "correct horse battery staple 8891";
const CUSTOMER_PASSWORD = "Acme!Str0ng-Pass";

let server;
let baseUrl;
let auth;
let Customer;
let User;
let prisma;
let founderHash;
let dbFile;

/** A disposable SQLite database, migrated, per test file run. */
function prepareDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "founder-db-"));
  dbFile = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbFile}`;

  const { execFileSync } = require("child_process");
  execFileSync(
    "npx",
    ["prisma", "migrate", "deploy", "--schema", "prisma/schema.prisma"],
    {
      cwd: path.resolve(__dirname, "..", ".."),
      env: { ...process.env, DATABASE_URL: `file:${dbFile}` },
      stdio: "ignore",
    }
  );
  return dir;
}

let dbDir;

async function boot(env = {}) {
  Object.assign(process.env, {
    NODE_ENV: "test",
    JWT_SECRET: "test-jwt-secret-for-the-founder-suite",
    FOUNDER_CONSOLE_ENABLED: "true",
    FOUNDER_PASSWORD_HASH: founderHash,
    DATABASE_URL: `file:${dbFile}`,
    ...env,
  });

  const express = require("express");
  const bodyParser = require("body-parser");
  const { founderRoutes } = require("../../business/founder/routes");
  const { systemEndpoints } = require("../../endpoints/system");
  const {
    validatedRequest,
  } = require("../../utils/middleware/validatedRequest");

  auth = require("../../business/founder/auth");

  const app = express();
  app.use(bodyParser.json());

  // The founder plane, mounted exactly as the real server mounts it: on the
  // app, ahead of the customer API router.
  founderRoutes(app);

  const apiRouter = express.Router();
  app.use("/api", apiRouter);
  systemEndpoints(apiRouter);

  // Stands in for a protected product endpoint. It is behind the SAME
  // validation the real product uses, which is the thing under test.
  apiRouter.get("/protected-product", [validatedRequest], (_request, res) =>
    res.status(200).json({ ok: true })
  );

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

async function shutdown() {
  if (!server) return;
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  server = null;
}

/** Founder client: carries the HttpOnly cookie and the CSRF header. */
function founderClient() {
  const state = { cookie: null, csrf: null };

  async function call(method, urlPath, { body, headers = {}, csrf } = {}) {
    const response = await fetch(`${baseUrl}${urlPath}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(state.cookie ? { Cookie: state.cookie } : {}),
        ...(method !== "GET" && (csrf ?? state.csrf)
          ? { "x-founder-csrf": csrf ?? state.csrf }
          : {}),
        ...headers,
      },
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

  return {
    state,
    get: (p, o) => call("GET", p, o),
    post: (p, b, o) => call("POST", p, { body: b, ...o }),
    put: (p, b, o) => call("PUT", p, { body: b, ...o }),
    del: (p, b, o) => call("DELETE", p, { body: b, ...o }),
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

/** Signs a customer in the way the real login endpoint does. */
async function customerLogin(email, password) {
  const response = await fetch(`${baseUrl}/api/request-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: email, password }),
  });
  return { status: response.status, payload: await response.json() };
}

/** Calls a protected product endpoint with a customer's session token. */
async function useProduct(token) {
  const response = await fetch(`${baseUrl}/api/protected-product`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, payload };
}

/** Creates a customer through the founder API and returns it. */
async function createCustomer(api, overrides = {}) {
  const result = await api.post("/api/founder/customers", {
    businessName: "Acme Corporation",
    email: "dana@acme.test",
    password: CUSTOMER_PASSWORD,
    contactName: "Dana Reyes",
    ...overrides,
  });
  return result;
}

beforeAll(async () => {
  const bcrypt = require("bcryptjs");
  founderHash = bcrypt.hashSync(FOUNDER_PASSWORD, 10);
  dbDir = prepareDatabase();

  prisma = require("../../utils/prisma");
  const { SystemSettings } = require("../../models/systemSettings");
  // Customers are individual accounts, which is multi-user mode.
  await prisma.system_settings.upsert({
    where: { label: "multi_user_mode" },
    update: { value: "true" },
    create: { label: "multi_user_mode", value: "true" },
  });
  expect(await SystemSettings.isMultiUserMode()).toBe(true);

  Customer = require("../../business/models/customer").Customer;
  User = require("../../models/user").User;
  await boot();
}, 120_000);

afterAll(async () => {
  await shutdown();
  await prisma?.$disconnect?.();
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.business_customers.deleteMany({});
  await prisma.users.deleteMany({});
  auth._sessions.clear();
  auth._attempts.clear();
  // The login limiter is real product behaviour; a suite that signs in fifty
  // times would trip it and fail for the wrong reason.
  require("../../business/founder/routes").founderRoutes.resetRateLimit();
});

// ===================================================== no public signup =====

describe("there is no public signup", () => {
  it("exposes no registration endpoint", async () => {
    for (const route of [
      "/api/signup",
      "/api/register",
      "/api/customers",
      "/api/system/register",
      "/api/founder/signup",
    ]) {
      const response = await fetch(`${baseUrl}${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "intruder@example.test",
          password: CUSTOMER_PASSWORD,
        }),
      });
      expect([401, 403, 404]).toContain(response.status);
    }
    expect(await User.count()).toBe(0);
  });

  it("refuses customer creation without a founder session", async () => {
    const api = founderClient();
    const result = await createCustomer(api);
    expect(result.status).toBe(401);
    expect(await User.count()).toBe(0);
  });

  it("has no route that creates an account from a payment", async () => {
    // A webhook must not be able to conjure a login. Nothing in the founder
    // API accepts a Stripe event, and the customer routes need a session.
    for (const route of [
      "/api/founder/customers/from-payment",
      "/api/founder/webhook",
      "/api/founder/stripe",
    ]) {
      const response = await fetch(`${baseUrl}${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "checkout.session.completed" }),
      });
      expect([401, 404]).toContain(response.status);
    }
    expect(await User.count()).toBe(0);
  });
});

// ==================================================== founder auth ==========

describe("founder authentication", () => {
  it("succeeds with the correct password", async () => {
    const api = founderClient();
    const result = await api.login();
    expect(result.status).toBe(200);
    expect(result.payload.success).toBe(true);
    expect(result.setCookie).toMatch(/founder_session=/);
    expect(result.setCookie).toMatch(/HttpOnly/i);
  });

  it("fails with the wrong password", async () => {
    const api = founderClient();
    const result = await api.login("not the password");
    expect(result.status).toBe(401);
    expect(result.setCookie).toBeNull();
  });

  it("never returns the founder secret to the browser", async () => {
    const api = founderClient();
    await api.login();
    await createCustomer(api);

    const responses = await Promise.all([
      api.get("/api/founder/session"),
      api.get("/api/founder/customers"),
      api.get("/api/founder/audit"),
    ]);
    for (const { payload } of responses) {
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain(FOUNDER_PASSWORD);
      expect(serialized).not.toContain(founderHash);
    }
  });

  it("signs out, and the old cookie stops working", async () => {
    const api = founderClient();
    await api.login();
    expect((await api.get("/api/founder/customers")).status).toBe(200);
    expect((await api.post("/api/founder/logout")).status).toBe(200);
    expect((await api.get("/api/founder/customers")).status).toBe(401);
  });

  it("rate limits repeated failures", async () => {
    const api = founderClient();
    for (let i = 0; i < 5; i += 1) await api.login(`guess-${i}`);
    expect((await api.login(FOUNDER_PASSWORD)).status).toBe(429);
  });

  it("requires the CSRF token on a mutating request", async () => {
    const api = founderClient();
    await api.login();
    const result = await createCustomer(api, {});
    expect(result.status).toBe(201);

    const forged = await api.post(
      "/api/founder/customers",
      { businessName: "B", email: "b@b.test", password: CUSTOMER_PASSWORD },
      { headers: { "x-founder-csrf": "b".repeat(48) } }
    );
    expect(forged.status).toBe(403);
  });
});

// =============================== a customer cannot reach founder functions ==

describe("customer credentials buy nothing on the founder API", () => {
  it("rejects a valid customer session on every founder route", async () => {
    const api = founderClient();
    await api.login();
    const created = await createCustomer(api);
    const id = created.payload.customer.id;

    const signin = await customerLogin("dana@acme.test", CUSTOMER_PASSWORD);
    expect(signin.payload.valid).toBe(true);
    const customerToken = signin.payload.token;
    // Their token genuinely works for the product.
    expect((await useProduct(customerToken)).status).toBe(200);

    const asCustomer = (p, method = "GET", body) =>
      fetch(`${baseUrl}${p}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${customerToken}`,
          Cookie: `founder_session=${customerToken}`,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

    for (const route of [
      "/api/founder/customers",
      `/api/founder/customers/${id}`,
      "/api/founder/audit",
    ])
      expect((await asCustomer(route)).status).toBe(401);

    expect(
      (
        await asCustomer("/api/founder/customers", "POST", {
          businessName: "Mine",
          email: "mine@x.test",
          password: CUSTOMER_PASSWORD,
        })
      ).status
    ).toBe(401);

    expect(
      (await asCustomer(`/api/founder/customers/${id}/access`, "POST", {
        access: "active",
      })).status
    ).toBe(401);

    // And nothing was created by any of it.
    expect(await prisma.business_customers.count()).toBe(1);
  });
});

// ================================================= creating a customer ======

describe("the founder creates a customer", () => {
  it("creates an account with the email and password the founder supplies", async () => {
    const api = founderClient();
    await api.login();

    const result = await createCustomer(api);
    expect(result.status).toBe(201);
    expect(result.payload.customer.loginEmail).toBe("dana@acme.test");
    expect(result.payload.customer.businessName).toBe("Acme Corporation");
    expect(result.payload.customer.access).toBe("active");
  });

  it("hashes the password and never stores the plaintext", async () => {
    const api = founderClient();
    await api.login();
    await createCustomer(api);

    const row = await prisma.users.findFirst({
      where: { username: "dana@acme.test" },
    });
    expect(row.password).toMatch(/^\$2[aby]\$/);
    expect(row.password).not.toContain(CUSTOMER_PASSWORD);

    // Nowhere else in the database either.
    const everything = JSON.stringify([
      await prisma.users.findMany(),
      await prisma.business_customers.findMany(),
      await prisma.audit_logs.findMany(),
      await prisma.event_logs.findMany(),
    ]);
    expect(everything).not.toContain(CUSTOMER_PASSWORD);
  });

  it("never returns a password or hash from the founder API", async () => {
    const api = founderClient();
    await api.login();
    const created = await createCustomer(api);
    const id = created.payload.customer.id;

    const bodies = JSON.stringify([
      created.payload,
      (await api.get("/api/founder/customers")).payload,
      (await api.get(`/api/founder/customers/${id}`)).payload,
      (await api.get("/api/founder/audit")).payload,
    ]);
    expect(bodies).not.toContain(CUSTOMER_PASSWORD);
    expect(bodies).not.toMatch(/\$2[aby]\$/);
  });

  it("gives the customer an account that cannot administer others", async () => {
    const api = founderClient();
    await api.login();
    await createCustomer(api);
    const row = await prisma.users.findFirst({
      where: { username: "dana@acme.test" },
    });
    // An admin would see every other customer's workspaces.
    expect(row.role).toBe("default");
  });

  it("refuses a duplicate login email", async () => {
    const api = founderClient();
    await api.login();
    expect((await createCustomer(api)).status).toBe(201);

    const again = await createCustomer(api, { businessName: "Other" });
    expect(again.status).toBe(400);
    expect(again.payload.error).toMatch(/already exists/i);
    expect(await User.count()).toBe(1);
  });

  it("refuses an invalid email, and creates no user", async () => {
    const api = founderClient();
    await api.login();
    for (const email of ["", "not-an-email", "no@domain", "a b@c.test"]) {
      const result = await createCustomer(api, { email });
      expect(result.status).toBe(400);
    }
    expect(await User.count()).toBe(0);
  });

  it("refuses a missing business name", async () => {
    const api = founderClient();
    await api.login();
    const result = await createCustomer(api, { businessName: "  " });
    expect(result.status).toBe(400);
    expect(await User.count()).toBe(0);
  });

  it("leaves no orphaned login when the customer record cannot be written", async () => {
    const api = founderClient();
    await api.login();
    const spy = jest
      .spyOn(prisma.business_customers, "create")
      .mockRejectedValueOnce(new Error("disk on fire"));

    const result = await createCustomer(api);
    expect(result.status).toBe(400);
    // A user row with no customer behind it would be an invisible login.
    expect(await User.count()).toBe(0);
    spy.mockRestore();
  });
});

// ====================================================== customer login ======

describe("customer login", () => {
  beforeEach(async () => {
    const api = founderClient();
    await api.login();
    await createCustomer(api);
  });

  it("lets an active founder-created customer sign in", async () => {
    const result = await customerLogin("dana@acme.test", CUSTOMER_PASSWORD);
    expect(result.payload.valid).toBe(true);
    expect(result.payload.token).toEqual(expect.any(String));
  });

  it("refuses an unknown email", async () => {
    const result = await customerLogin("nobody@acme.test", CUSTOMER_PASSWORD);
    expect(result.payload.valid).toBe(false);
    expect(result.payload.token).toBeNull();
  });

  it("refuses the wrong password", async () => {
    const result = await customerLogin("dana@acme.test", "wrong-password-here");
    expect(result.payload.valid).toBe(false);
    expect(result.payload.token).toBeNull();
  });

  it("lets a signed-in customer use the product", async () => {
    const { payload } = await customerLogin(
      "dana@acme.test",
      CUSTOMER_PASSWORD
    );
    expect((await useProduct(payload.token)).status).toBe(200);
  });

  it("refuses the product without a token", async () => {
    expect((await useProduct(null)).status).toBe(401);
  });
});

// ============================================== disable / restore access ====

describe("founder-controlled access", () => {
  let api;
  let id;

  beforeEach(async () => {
    api = founderClient();
    await api.login();
    id = (await createCustomer(api)).payload.customer.id;
  });

  it("disables a customer", async () => {
    const result = await api.post(`/api/founder/customers/${id}/access`, {
      access: "disabled",
    });
    expect(result.status).toBe(200);
    expect(result.payload.customer.access).toBe("disabled");
  });

  it("stops a disabled customer logging in", async () => {
    await api.post(`/api/founder/customers/${id}/access`, {
      access: "disabled",
    });
    const result = await customerLogin("dana@acme.test", CUSTOMER_PASSWORD);
    expect(result.payload.valid).toBe(false);
    expect(result.payload.token).toBeNull();
  });

  it("kills an ALREADY ISSUED session the moment access is disabled", async () => {
    // The important one. A customer who was signed in before being disabled
    // must not keep working until their token expires.
    const { payload } = await customerLogin(
      "dana@acme.test",
      CUSTOMER_PASSWORD
    );
    const token = payload.token;
    expect((await useProduct(token)).status).toBe(200);

    await api.post(`/api/founder/customers/${id}/access`, {
      access: "disabled",
    });

    const after = await useProduct(token);
    expect(after.status).toBe(401);
    expect(after.payload.error).toMatch(/suspend/i);
  });

  it("restores access, and they can sign in again", async () => {
    await api.post(`/api/founder/customers/${id}/access`, {
      access: "disabled",
    });
    const restored = await api.post(`/api/founder/customers/${id}/access`, {
      access: "active",
    });
    expect(restored.payload.customer.access).toBe("active");

    const result = await customerLogin("dana@acme.test", CUSTOMER_PASSWORD);
    expect(result.payload.valid).toBe(true);
    expect((await useProduct(result.payload.token)).status).toBe(200);
  });

  it("rejects an unknown access state", async () => {
    const result = await api.post(`/api/founder/customers/${id}/access`, {
      access: "cancelled-by-stripe",
    });
    expect(result.status).toBe(400);
  });

  it("does not delete anything when access is disabled", async () => {
    await api.post(`/api/founder/customers/${id}/access`, {
      access: "disabled",
    });
    expect(await prisma.business_customers.count()).toBe(1);
    expect(await User.count()).toBe(1);
  });
});

// ============================================ credentials the founder sets ==

describe("founder-managed credentials", () => {
  let api;
  let id;

  beforeEach(async () => {
    api = founderClient();
    await api.login();
    id = (await createCustomer(api)).payload.customer.id;
  });

  it("resets the password: the old one stops working, the new one works", async () => {
    const next = "A-Wh0lly-Different!1";
    const result = await api.post(`/api/founder/customers/${id}/password`, {
      password: next,
    });
    expect(result.status).toBe(200);

    expect(
      (await customerLogin("dana@acme.test", CUSTOMER_PASSWORD)).payload.valid
    ).toBe(false);
    expect((await customerLogin("dana@acme.test", next)).payload.valid).toBe(
      true
    );
  });

  it("stores the reset password as a hash, not plaintext", async () => {
    const next = "A-Wh0lly-Different!1";
    await api.post(`/api/founder/customers/${id}/password`, {
      password: next,
    });
    const row = await prisma.users.findFirst({
      where: { username: "dana@acme.test" },
    });
    expect(row.password).toMatch(/^\$2[aby]\$/);
    expect(row.password).not.toContain(next);
  });

  it("changes the email: the old one stops working, the new one works", async () => {
    const result = await api.post(`/api/founder/customers/${id}/email`, {
      email: "newdana@acme.test",
    });
    expect(result.status).toBe(200);
    expect(result.payload.customer.loginEmail).toBe("newdana@acme.test");

    expect(
      (await customerLogin("dana@acme.test", CUSTOMER_PASSWORD)).payload.valid
    ).toBe(false);
    expect(
      (await customerLogin("newdana@acme.test", CUSTOMER_PASSWORD)).payload
        .valid
    ).toBe(true);
  });

  it("refuses an email another customer already uses", async () => {
    await createCustomer(api, {
      businessName: "Beta",
      email: "beta@beta.test",
    });
    const result = await api.post(`/api/founder/customers/${id}/email`, {
      email: "beta@beta.test",
    });
    expect(result.status).toBe(400);
    expect(result.payload.error).toMatch(/already exists/i);
  });

  it("has no route that reads a password back", async () => {
    for (const route of [
      `/api/founder/customers/${id}/password`,
      `/api/founder/customers/${id}/credentials`,
    ]) {
      const result = await api.get(route);
      expect([404, 405]).toContain(result.status);
    }
  });
});

// ================================================= editing and removal ======

describe("editing and removal", () => {
  let api;
  let id;

  beforeEach(async () => {
    api = founderClient();
    await api.login();
    id = (await createCustomer(api)).payload.customer.id;
  });

  it("updates business information", async () => {
    const result = await api.put(`/api/founder/customers/${id}`, {
      businessName: "Acme Holdings",
      contactName: "Sam Ito",
      paymentNote: "Paid 12 Sep",
    });
    expect(result.status).toBe(200);
    expect(result.payload.customer.businessName).toBe("Acme Holdings");
    expect(result.payload.customer.paymentNote).toBe("Paid 12 Sep");
    // Editing the business must not disturb the login.
    expect(result.payload.customer.loginEmail).toBe("dana@acme.test");
  });

  it("lists customers with their access state", async () => {
    await createCustomer(api, {
      businessName: "Beta",
      email: "beta@beta.test",
    });
    await api.post(`/api/founder/customers/${id}/access`, {
      access: "disabled",
    });

    const listed = await api.get("/api/founder/customers");
    expect(listed.payload.counts).toEqual({
      total: 2,
      active: 1,
      disabled: 1,
    });
  });

  it("refuses removal without the business name typed back", async () => {
    const result = await api.del(`/api/founder/customers/${id}`, {
      confirmBusinessName: "wrong",
    });
    expect(result.status).toBe(400);
    expect(await prisma.business_customers.count()).toBe(1);
  });

  it("removes the customer and their login when confirmed", async () => {
    const result = await api.del(`/api/founder/customers/${id}`, {
      confirmBusinessName: "Acme Corporation",
    });
    expect(result.status).toBe(200);
    expect(await prisma.business_customers.count()).toBe(0);
    expect(await User.count()).toBe(0);

    expect(
      (await customerLogin("dana@acme.test", CUSTOMER_PASSWORD)).payload.valid
    ).toBe(false);
  });

  it("404s for a customer that does not exist", async () => {
    expect((await api.get("/api/founder/customers/999999")).status).toBe(404);
    expect(
      (await api.post("/api/founder/customers/999999/access", {
        access: "active",
      })).status
    ).toBe(404);
  });
});

// ======================================= access does not depend on Stripe ===

describe("Stripe is outside application authorization", () => {
  /** Every Stripe-shaped variable, removed. */
  const STRIPE_KEYS = [
    "STRIPE_SECRET_KEY",
    "STRIPE_PUBLISHABLE_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICE_ID",
    "STRIPE_PRODUCT_ID",
    "STRIPE_PAYMENT_LINK",
    "STRIPE_CUSTOMER_ID",
    "STRIPE_SUBSCRIPTION_ID",
  ];

  let saved;

  beforeEach(() => {
    saved = {};
    for (const key of STRIPE_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });

  it("creates a customer and signs them in with no Stripe credential at all", async () => {
    const api = founderClient();
    await api.login();
    expect((await createCustomer(api)).status).toBe(201);

    const signin = await customerLogin("dana@acme.test", CUSTOMER_PASSWORD);
    expect(signin.payload.valid).toBe(true);
    expect((await useProduct(signin.payload.token)).status).toBe(200);
  });

  it("never answers 402 to an active customer", async () => {
    const api = founderClient();
    await api.login();
    await createCustomer(api);
    const { payload } = await customerLogin(
      "dana@acme.test",
      CUSTOMER_PASSWORD
    );

    const result = await useProduct(payload.token);
    expect(result.status).not.toBe(402);
    expect(result.status).toBe(200);
  });

  it("mounts no subscription gate on any AI endpoint", () => {
    // The gate used to answer 402 based on Stripe state. Access is the
    // founder's decision now, so nothing mounts it.
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "business", "routes", "index.js"),
      "utf8"
    );
    expect(source).not.toMatch(/app\.use\([^)]*requireActiveSubscription/);
  });

  it("keeps Stripe out of the founder plane's code entirely", () => {
    const dir = path.resolve(__dirname, "..", "..", "business", "founder");
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".js")) continue;
      const source = fs
        .readFileSync(path.join(dir, file), "utf8")
        // Comments explain why Stripe is absent; the assertion is about code.
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(source).not.toMatch(/stripe/i);
    }
  });

  it("does not treat a customer model as knowing anything about payment state", () => {
    const source = fs
      .readFileSync(
        path.resolve(__dirname, "..", "..", "business", "models", "customer.js"),
        "utf8"
      )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(source).not.toMatch(/stripe|subscription|invoice|webhook/i);
  });
});

// ============================================ one customer cannot see another

describe("customers are isolated from each other", () => {
  it("cannot authenticate as another customer", async () => {
    const api = founderClient();
    await api.login();
    await createCustomer(api);
    await createCustomer(api, {
      businessName: "Beta Industries",
      email: "sam@beta.test",
      password: "Beta!Str0ng-Pass",
    });

    // Beta's password does not open Acme's account, or the reverse.
    expect(
      (await customerLogin("dana@acme.test", "Beta!Str0ng-Pass")).payload.valid
    ).toBe(false);
    expect(
      (await customerLogin("sam@beta.test", CUSTOMER_PASSWORD)).payload.valid
    ).toBe(false);
  });

  it("gives each customer a separate identity in their session", async () => {
    const api = founderClient();
    await api.login();
    await createCustomer(api);
    await createCustomer(api, {
      businessName: "Beta Industries",
      email: "sam@beta.test",
      password: "Beta!Str0ng-Pass",
    });

    const acme = await customerLogin("dana@acme.test", CUSTOMER_PASSWORD);
    const beta = await customerLogin("sam@beta.test", "Beta!Str0ng-Pass");

    expect(acme.payload.user.id).not.toBe(beta.payload.user.id);
    expect(acme.payload.token).not.toBe(beta.payload.token);
  });

  it("restricts a customer to workspaces they belong to", async () => {
    // This is the inherited isolation primitive the product already uses, and
    // the reason customers are `default` and never `admin`.
    const { Workspace } = require("../../models/workspace");
    const api = founderClient();
    await api.login();
    const acmeId = (await createCustomer(api)).payload.customer.userId;
    const betaId = (
      await createCustomer(api, {
        businessName: "Beta Industries",
        email: "sam@beta.test",
        password: "Beta!Str0ng-Pass",
      })
    ).payload.customer.userId;

    const { workspace: acmeWorkspace } = await Workspace.new(
      "Acme Workspace",
      acmeId
    );
    const { workspace: betaWorkspace } = await Workspace.new(
      "Beta Workspace",
      betaId
    );

    const acmeUser = await User.get({ id: acmeId });
    const visible = await Workspace.whereWithUser(acmeUser);
    const slugs = visible.map((w) => w.slug);

    expect(slugs).toContain(acmeWorkspace.slug);
    expect(slugs).not.toContain(betaWorkspace.slug);
  });
});

// ==================================================== the audit trail =======

describe("auditability", () => {
  it("records what the founder did, without any password", async () => {
    const api = founderClient();
    await api.login();
    const id = (await createCustomer(api)).payload.customer.id;
    await api.post(`/api/founder/customers/${id}/access`, {
      access: "disabled",
    });
    await api.post(`/api/founder/customers/${id}/password`, {
      password: "A-Wh0lly-Different!1",
    });

    const rows = await prisma.audit_logs.findMany({
      where: { action: { startsWith: "founder." } },
    });
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "founder.login_succeeded",
        "founder.customer_created",
        "founder.customer_disabled",
        "founder.customer_password_reset",
      ])
    );

    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(CUSTOMER_PASSWORD);
    expect(serialized).not.toContain("A-Wh0lly-Different!1");
    expect(serialized).not.toContain(FOUNDER_PASSWORD);
  });
});

// ============================================ the secret's blast radius =====

describe("the founder secret's blast radius", () => {
  const repoRoot = path.resolve(__dirname, "..", "..", "..");

  function walk(dir, matcher, found = []) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return found;
    }
    for (const entry of entries) {
      if (
        [
          "node_modules",
          ".git",
          "dist",
          "build",
          "storage",
          "coverage",
        ].includes(entry.name)
      )
        continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, matcher, found);
      else if (matcher(full)) found.push(full);
    }
    return found;
  }

  it("is read in exactly one place on the server", () => {
    const files = walk(path.join(repoRoot, "server"), (f) => f.endsWith(".js"))
      .filter(
        (file) =>
          !file.includes(`${path.sep}__tests__${path.sep}`) &&
          fs.readFileSync(file, "utf8").includes("FOUNDER_PASSWORD_HASH")
      )
      .map((file) => path.relative(repoRoot, file))
      .sort();

    expect(files).toEqual([
      path.join("server", "business", "founder", "auth.js"),
      // Listed only so a settings save cannot delete it from .env.
      path.join("server", "utils", "helpers", "updateENV.js"),
    ]);
  });

  it("appears nowhere in the frontend", () => {
    const hits = walk(path.join(repoRoot, "frontend", "src"), (f) =>
      /\.(js|jsx|ts|tsx)$/.test(f)
    ).filter((file) =>
      /FOUNDER_PASSWORD|founderPassword/i.test(fs.readFileSync(file, "utf8"))
    );
    expect(hits.map((f) => path.relative(repoRoot, f))).toEqual([]);
  });

  it("is not kept in browser storage by the console's client", () => {
    const client = fs
      .readFileSync(
        path.join(repoRoot, "frontend", "src", "models", "founder.js"),
        "utf8"
      )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(client).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
  });
});
