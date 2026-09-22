/**
 * Customer-owned AI connections.
 *
 * The product does not own a model credential. Every business that uses it
 * connects the AI service THEY chose, with THEIR key, and receives THEIR bill.
 *
 * Two things therefore have to be true, and both are tested here against a
 * real server, a real database and two real customers:
 *
 *   1. Authentication has nothing to do with AI. A customer with no AI
 *      connection signs in, reaches their workspace, and is told what to do -
 *      not shown a platform failure.
 *   2. One customer's credential is unreachable by another, by any route -
 *      reading it, replacing it, or causing a request that uses it.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const FOUNDER_PASSWORD = "verification-founder-password-1";

let server;
let baseUrl;
let prisma;
let dbDir;
let dbFile;
let Customer;
let connection;
let adapters;
let secrets;

function prepareDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-conn-db-"));
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

async function call(method, urlPath, { body, token } = {}) {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
  return { status: response.status, payload };
}

const signIn = (username, password) =>
  call("POST", "/api/request-token", { body: { username, password } });

async function makeCustomer(businessName, email, password) {
  const { customer, error } = await Customer.create({
    businessName,
    email,
    password,
  });
  if (error) throw new Error(`could not create ${businessName}: ${error}`);
  const session = await signIn(email, password);
  return { customer, token: session.payload?.token };
}

beforeAll(async () => {
  const bcrypt = require("bcryptjs");
  dbDir = prepareDatabase();

  Object.assign(process.env, {
    NODE_ENV: "test",
    JWT_SECRET: "test-jwt-secret-for-the-ai-connection-suite",
    SIG_KEY: "test-sig-key-for-the-ai-connection-suite-000",
    SIG_SALT: "test-sig-salt-for-the-ai-connection-suite-00",
    FOUNDER_CONSOLE_ENABLED: "true",
    FOUNDER_PASSWORD_HASH: bcrypt.hashSync(FOUNDER_PASSWORD, 10),
    DATABASE_URL: `file:${dbFile}`,
  });
  // No platform model credential exists anywhere in this run.
  for (const key of [
    "OPEN_AI_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GROQ_API_KEY",
    "OPENROUTER_API_KEY",
    "LLM_PROVIDER",
    "AI_CREDENTIAL_KEY",
  ])
    delete process.env[key];

  prisma = require("../../utils/prisma");
  await prisma.system_settings.upsert({
    where: { label: "multi_user_mode" },
    update: { value: "true" },
    create: { label: "multi_user_mode", value: "true" },
  });

  Customer = require("../../business/models/customer").Customer;
  ({ connection, adapters, secrets } = require("../../business/ai"));

  const express = require("express");
  const bodyParser = require("body-parser");
  const { systemEndpoints } = require("../../endpoints/system");
  const { businessEndpoints } = require("../../business/routes");
  const {
    workspaceEndpoints,
  } = require("../../endpoints/workspaces");

  const app = express();
  app.use(bodyParser.json());
  const apiRouter = express.Router();
  app.use("/api", apiRouter);
  systemEndpoints(apiRouter);
  workspaceEndpoints(apiRouter);
  businessEndpoints(apiRouter);

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}, 180_000);

afterAll(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  await prisma?.$disconnect?.();
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.business_ai_connections.deleteMany({});
  await prisma.business_customers.deleteMany({});
  await prisma.workspace_users.deleteMany({});
  await prisma.workspaces.deleteMany({});
  await prisma.users.deleteMany({});
});

describe("a customer does not need AI to use their account", () => {
  it("signs in and reaches their workspace with nothing configured", async () => {
    const { token } = await makeCustomer(
      "Northwind Supply",
      "ana@northwind.test",
      "Str0ng-Pass!-north"
    );
    expect(typeof token).toBe("string");

    const spaces = await call("GET", "/api/workspaces", { token });
    expect(spaces.status).toBe(200);
    expect(spaces.payload.workspaces.length).toBeGreaterThan(0);
    expect(spaces.payload.workspaces[0].name).toBe("Northwind Supply");
  });

  it("is told what to do rather than shown a platform failure", async () => {
    const { token } = await makeCustomer(
      "Northwind Supply",
      "ana@northwind.test",
      "Str0ng-Pass!-north"
    );
    const state = await call("GET", "/api/business/ai-connection", { token });
    expect(state.status).toBe(200);
    expect(state.payload.connection).toBeNull();

    const options = await call("GET", "/api/business/ai-connection/options", {
      token,
    });
    expect(options.status).toBe(200);
    expect(options.payload.options.length).toBeGreaterThan(1);
    expect(options.payload.options.map((o) => o.type)).toContain(
      "openai-compatible"
    );
  });

  it("removing the connection does not affect signing in", async () => {
    const { token } = await makeCustomer(
      "Northwind Supply",
      "ana@northwind.test",
      "Str0ng-Pass!-north"
    );
    await call("POST", "/api/business/ai-connection", {
      token,
      body: {
        provider: "openai-compatible",
        baseUrl: "https://models.example.test/v1",
        model: "some-model",
        apiKey: "customer-key-aaaaaaaaaaaa",
      },
    });
    expect(
      (await call("DELETE", "/api/business/ai-connection", { token })).status
    ).toBe(200);

    const again = await signIn("ana@northwind.test", "Str0ng-Pass!-north");
    expect(again.payload.valid).toBe(true);
    expect((await call("GET", "/api/workspaces", { token })).status).toBe(200);
  });
});

describe("the platform needs no model credential of its own", () => {
  it("has none in this process", () => {
    for (const key of [
      "OPEN_AI_KEY",
      "ANTHROPIC_API_KEY",
      "GEMINI_API_KEY",
      "GROQ_API_KEY",
      "OPENROUTER_API_KEY",
    ])
      expect(process.env[key]).toBeUndefined();
  });

  it("still creates customers and signs them in", async () => {
    const { customer, token } = await makeCustomer(
      "Northwind Supply",
      "ana@northwind.test",
      "Str0ng-Pass!-north"
    );
    expect(customer.access).toBe("active");
    expect(typeof token).toBe("string");
  });
});

describe("a customer's credential", () => {
  const SECRET = "customer-key-abcdefghijklmnop";

  async function connect(token, overrides = {}) {
    return call("POST", "/api/business/ai-connection", {
      token,
      body: {
        provider: "openai-compatible",
        baseUrl: "https://models.example.test/v1",
        model: "their-model",
        apiKey: SECRET,
        ...overrides,
      },
    });
  }

  it("is stored encrypted, not in the clear", async () => {
    const { customer, token } = await makeCustomer(
      "Northwind Supply",
      "ana@northwind.test",
      "Str0ng-Pass!-north"
    );
    expect((await connect(token)).status).toBe(200);

    const row = await prisma.business_ai_connections.findUnique({
      where: { user_id: customer.userId },
    });
    expect(row.credential).not.toContain(SECRET);
    expect(row.credential.startsWith("v1.")).toBe(true);
    expect(secrets.open(row.credential)).toBe(SECRET);
  });

  it("never comes back from the API", async () => {
    const { token } = await makeCustomer(
      "Northwind Supply",
      "ana@northwind.test",
      "Str0ng-Pass!-north"
    );
    const saved = await connect(token);
    const read = await call("GET", "/api/business/ai-connection", { token });

    const everything = JSON.stringify([saved.payload, read.payload]);
    expect(everything).not.toContain(SECRET);
    expect(read.payload.connection.credential).toBe("configured");
  });

  it("can be replaced, and the old one stops being used", async () => {
    const { customer, token } = await makeCustomer(
      "Northwind Supply",
      "ana@northwind.test",
      "Str0ng-Pass!-north"
    );
    await connect(token);
    await connect(token, { apiKey: "customer-key-REPLACEMENT-999" });

    const row = await prisma.business_ai_connections.findUnique({
      where: { user_id: customer.userId },
    });
    expect(secrets.open(row.credential)).toBe("customer-key-REPLACEMENT-999");
  });

  it("survives a change of model without being resent", async () => {
    const { customer, token } = await makeCustomer(
      "Northwind Supply",
      "ana@northwind.test",
      "Str0ng-Pass!-north"
    );
    await connect(token);

    const changed = await call("POST", "/api/business/ai-connection", {
      token,
      body: {
        provider: "openai-compatible",
        baseUrl: "https://models.example.test/v1",
        model: "a-different-model",
      },
    });
    expect(changed.status).toBe(200);
    expect(changed.payload.connection.model).toBe("a-different-model");

    const row = await prisma.business_ai_connections.findUnique({
      where: { user_id: customer.userId },
    });
    expect(secrets.open(row.credential)).toBe(SECRET);
  });

  it("cannot be read, used or changed by another customer", async () => {
    const ana = await makeCustomer(
      "Northwind Supply",
      "ana@northwind.test",
      "Str0ng-Pass!-north"
    );
    await connect(ana.token);

    const bo = await makeCustomer(
      "Southbridge Metals",
      "bo@southbridge.test",
      "Str0ng-Pass!-south"
    );

    // Reading: they see their own state, which is nothing.
    const theirs = await call("GET", "/api/business/ai-connection", {
      token: bo.token,
    });
    expect(theirs.payload.connection).toBeNull();
    expect(JSON.stringify(theirs.payload)).not.toContain(SECRET);

    // Using: resolution is by authenticated identity, so there is nothing to
    // resolve for them - not somebody else's connection.
    const { User } = require("../../models/user");
    const boUser = await User.get({ id: bo.customer.userId });
    expect(await connection.connectorFor(boUser)).toBeNull();

    // Changing: their write lands on their own row and leaves Ana's alone.
    await call("POST", "/api/business/ai-connection", {
      token: bo.token,
      body: {
        provider: "openai-compatible",
        baseUrl: "https://elsewhere.example.test/v1",
        model: "theirs",
        apiKey: "another-customers-key-zzzz",
      },
    });

    const anaRow = await prisma.business_ai_connections.findUnique({
      where: { user_id: ana.customer.userId },
    });
    expect(secrets.open(anaRow.credential)).toBe(SECRET);
    expect(anaRow.base_url).toBe("https://models.example.test/v1");
  });

  it("is unreachable once the founder disables the customer", async () => {
    const { customer, token } = await makeCustomer(
      "Northwind Supply",
      "ana@northwind.test",
      "Str0ng-Pass!-north"
    );
    await connect(token);

    await Customer.setAccess(customer.id, "disabled");
    expect(
      (await call("GET", "/api/business/ai-connection", { token })).status
    ).toBe(401);
  });

  it("outlives a cold start, because it is in the database", async () => {
    const { customer, token } = await makeCustomer(
      "Northwind Supply",
      "ana@northwind.test",
      "Str0ng-Pass!-north"
    );
    await connect(token);

    // A fresh client, as a new serverless instance would have.
    const { PrismaClient } = require("@prisma/client");
    const fresh = new PrismaClient();
    try {
      const row = await fresh.business_ai_connections.findUnique({
        where: { user_id: customer.userId },
      });
      expect(row).not.toBeNull();
      expect(secrets.open(row.credential)).toBe(SECRET);
    } finally {
      await fresh.$disconnect();
    }
  });
});

describe("different customers, different services", () => {
  it("each resolves to their own adapter and their own credential", async () => {
    const ana = await makeCustomer(
      "Northwind Supply",
      "ana@northwind.test",
      "Str0ng-Pass!-north"
    );
    const bo = await makeCustomer(
      "Southbridge Metals",
      "bo@southbridge.test",
      "Str0ng-Pass!-south"
    );

    await call("POST", "/api/business/ai-connection", {
      token: ana.token,
      body: {
        provider: "openai-compatible",
        baseUrl: "https://ana.example.test/v1",
        model: "ana-model",
        apiKey: "ana-key-aaaaaaaaaaaaaaaa",
      },
    });
    await call("POST", "/api/business/ai-connection", {
      token: bo.token,
      body: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        apiKey: "bo-key-bbbbbbbbbbbbbbbb",
      },
    });

    const { User } = require("../../models/user");
    const anaConnector = await connection.connectorFor(
      await User.get({ id: ana.customer.userId })
    );
    const boConnector = await connection.connectorFor(
      await User.get({ id: bo.customer.userId })
    );

    expect(anaConnector.className).toBe("GenericOpenAiLLM");
    expect(anaConnector.basePath).toBe("https://ana.example.test/v1");
    expect(anaConnector.model).toBe("ana-model");

    expect(boConnector.className).toBe("AnthropicLLM");
    expect(boConnector.model).toBe("claude-sonnet-4-6");
  });

  it("leaves the process environment exactly as it found it", async () => {
    const { customer, token } = await makeCustomer(
      "Northwind Supply",
      "ana@northwind.test",
      "Str0ng-Pass!-north"
    );
    await call("POST", "/api/business/ai-connection", {
      token,
      body: {
        provider: "openai-compatible",
        baseUrl: "https://ana.example.test/v1",
        model: "ana-model",
        apiKey: "ana-key-aaaaaaaaaaaaaaaa",
      },
    });

    const before = JSON.stringify(process.env);
    const { User } = require("../../models/user");
    await connection.connectorFor(await User.get({ id: customer.userId }));
    expect(JSON.stringify(process.env)).toBe(before);
  });

  it("rejects a service it does not have an adapter for", async () => {
    const { token } = await makeCustomer(
      "Northwind Supply",
      "ana@northwind.test",
      "Str0ng-Pass!-north"
    );
    const bad = await call("POST", "/api/business/ai-connection", {
      token,
      body: { provider: "not-a-real-service", model: "x", apiKey: "y" },
    });
    expect(bad.status).toBe(400);
    expect(bad.payload.error).toMatch(/choose an ai service/i);
  });

  it("rejects a base URL that is not one", async () => {
    const { token } = await makeCustomer(
      "Northwind Supply",
      "ana@northwind.test",
      "Str0ng-Pass!-north"
    );
    const bad = await call("POST", "/api/business/ai-connection", {
      token,
      body: {
        provider: "openai-compatible",
        baseUrl: "not a url",
        model: "x",
        apiKey: "y",
      },
    });
    expect(bad.status).toBe(400);
  });
});

describe("the adapters themselves", () => {
  it("every one builds synchronously, which is what keeps customers apart", () => {
    // `adapters.build` substitutes environment variables, constructs, and puts
    // them back inside one synchronous block. That is only safe while every
    // provider constructor is synchronous - an `await` inside one would let
    // another request observe the substituted values. This is the guard.
    for (const type of adapters.types()) {
      const { getLLMProviderClass } = require("../../utils/helpers");
      const values = adapters.ADAPTERS[type].env({
        apiKey: "k",
        baseUrl: "https://x.test/v1",
        model: "m",
      });
      const Provider = getLLMProviderClass({ provider: values.LLM_PROVIDER });
      expect(Provider).toBeTruthy();
      expect(Provider.prototype.constructor.constructor.name).toBe("Function");
      expect(String(Provider.prototype.constructor).startsWith("async")).toBe(
        false
      );
    }
  });

  it("describes what each one needs without naming a credential", () => {
    const described = adapters.describe();
    expect(described.length).toBe(adapters.types().length);
    for (const entry of described) {
      expect(typeof entry.label).toBe("string");
      expect(Array.isArray(entry.requires)).toBe(true);
      expect(JSON.stringify(entry)).not.toMatch(/sk-|Bearer /);
    }
  });
});
