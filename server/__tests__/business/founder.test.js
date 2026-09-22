/**
 * The founder control plane.
 *
 * These run against a real Express app over a real socket, because the things
 * worth pinning down here are HTTP-level: which status code an unauthenticated
 * request gets, whether a cookie is HttpOnly, whether a customer's own
 * credentials reach anything. Calling the handlers directly would pass while
 * the actual mounted route was wide open.
 *
 * The properties that matter:
 *   - the password exists only as a hash on the server, and no route returns it
 *   - a normal customer session is worth nothing here
 *   - nothing in the console can mark a deployment paid
 *   - provisioning writes files and never executes anything
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const PASSWORD = "correct horse battery staple 8891";

/** Audit writes go to Prisma; the trail itself is asserted through this. */
const auditEntries = [];
jest.mock("../../business/models/audit", () => ({
  AuditLog: {
    CATEGORIES: {
      BILLING: "billing",
      SECURITY: "security",
      SETTINGS: "settings",
      GENERAL: "general",
    },
    log: async (entry) => {
      auditEntries.push(entry);
      return entry;
    },
    fromRequest: async (_request, _response, entry) => {
      auditEntries.push(entry);
      return entry;
    },
    where: async () => [],
  },
}));

let stateDir;
let server;
let baseUrl;
let auth;
let provisioning;
let passwordHash;

/** Boots the founder routes on an ephemeral port. */
async function boot(env = {}) {
  jest.resetModules();
  auditEntries.length = 0;

  Object.assign(process.env, {
    NODE_ENV: "test",
    FOUNDER_CONSOLE_ENABLED: "true",
    FOUNDER_PASSWORD_HASH: passwordHash,
    PLATFORM_STATE_DIR: stateDir,
    ...env,
  });

  const express = require("express");
  const bodyParser = require("body-parser");
  const { founderRoutes } = require("../../business/founder/routes");
  auth = require("../../business/founder/auth");
  provisioning = require("../../business/services/provisioning");

  const app = express();
  app.use(bodyParser.json());
  founderRoutes(app);
  // Stands in for the customer API that sits behind this prefix in the real
  // server, so a fall-through would be visible rather than a silent 404.
  app.use("/api", (_request, response) =>
    response.status(200).json({ customerApi: true })
  );

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

async function shutdown() {
  if (!server) return;
  // `fetch` leaves keep-alive sockets open, and `close()` alone waits on them
  // forever - which shows up later as a worker that will not exit.
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  server = null;
}

/** A tiny client that carries the founder cookie and CSRF header. */
function client() {
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

    const setCookie = response.headers.get("set-cookie");
    if (setCookie) state.rawSetCookie = setCookie;

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    return { status: response.status, payload, setCookie };
  }

  return {
    state,
    get: (p, options) => call("GET", p, options),
    post: (p, body, options) => call("POST", p, { body, ...options }),
    async login(password = PASSWORD) {
      const result = await call("POST", "/api/founder/login", {
        body: { password },
      });
      if (result.setCookie) state.cookie = result.setCookie.split(";")[0];
      if (result.payload?.csrfToken) state.csrf = result.payload.csrfToken;
      return result;
    },
  };
}

beforeAll(async () => {
  const bcrypt = require("bcryptjs");
  passwordHash = bcrypt.hashSync(PASSWORD, 10);
});

beforeEach(async () => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "founder-test-"));
  await boot();
});

afterEach(async () => {
  await shutdown();
  fs.rmSync(stateDir, { recursive: true, force: true });
  delete process.env.FOUNDER_CONSOLE_ENABLED;
  delete process.env.FOUNDER_PASSWORD_HASH;
  delete process.env.PLATFORM_STATE_DIR;
});

// ------------------------------------------------------- where the secret is

describe("the founder secret's blast radius", () => {
  const repoRoot = path.resolve(__dirname, "..", "..", "..");

  /** Files under a directory, skipping build output and dependencies. */
  function walk(dir, matcher, found = []) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return found;
    }
    for (const entry of entries) {
      if (
        ["node_modules", ".git", "dist", "build", "storage", "coverage"].includes(
          entry.name
        )
      )
        continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, matcher, found);
      else if (matcher(full)) found.push(full);
    }
    return found;
  }

  it("is read in exactly one place on the server", () => {
    const files = walk(path.join(repoRoot, "server"), (file) =>
      file.endsWith(".js")
    ).filter(
      (file) =>
        !file.includes(`${path.sep}__tests__${path.sep}`) &&
        fs.readFileSync(file, "utf8").includes("FOUNDER_PASSWORD_HASH")
    );

    expect(files.map((file) => path.relative(repoRoot, file)).sort()).toEqual([
      path.join("server", "business", "founder", "auth.js"),
      // Listed so a settings save cannot delete it from .env.
      path.join("server", "utils", "helpers", "updateENV.js"),
    ]);
  });

  it("appears nowhere in the frontend", () => {
    const hits = walk(
      path.join(repoRoot, "frontend", "src"),
      (file) => /\.(js|jsx|ts|tsx)$/.test(file)
    ).filter((file) =>
      /FOUNDER_PASSWORD|founderPassword/i.test(fs.readFileSync(file, "utf8"))
    );
    expect(hits.map((file) => path.relative(repoRoot, file))).toEqual([]);
  });

  it("is not stored in browser storage by the console's client", () => {
    const client = fs
      .readFileSync(
        path.join(repoRoot, "frontend", "src", "models", "founder.js"),
        "utf8"
      )
      // Comments explain why these are avoided; the assertion is about code.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(client).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
  });
});

// ---------------------------------------------------------------- login ----

describe("founder login", () => {
  it("accepts the correct password and issues a session", async () => {
    const api = client();
    const result = await api.login();

    expect(result.status).toBe(200);
    expect(result.payload.success).toBe(true);
    expect(result.payload.csrfToken).toEqual(expect.any(String));
    expect(result.setCookie).toMatch(/founder_session=/);
  });

  it("refuses the wrong password", async () => {
    const api = client();
    const result = await api.login("not the password");

    expect(result.status).toBe(401);
    expect(result.payload.success).toBe(false);
    expect(result.setCookie).toBeNull();
  });

  it("refuses an empty password", async () => {
    const api = client();
    expect((await api.login("")).status).toBe(401);
  });

  it("sets the session cookie HttpOnly with SameSite, and no secret in it", async () => {
    const api = client();
    const { setCookie } = await api.login();

    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).not.toContain(PASSWORD);
    expect(setCookie).not.toContain(passwordHash);
  });

  it("never returns the password or its hash from any founder route", async () => {
    const api = client();
    await api.login();
    await api.post("/api/founder/deployments", {
      slug: "acme",
      name: "Acme",
      domain: "acme.example.com",
      port: 3101,
    });

    const bodies = await Promise.all([
      api.get("/api/founder/session"),
      api.get("/api/founder/deployments"),
      api.get("/api/founder/deployments/acme"),
      api.get("/api/founder/audit"),
    ]);

    for (const { payload } of bodies) {
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain(PASSWORD);
      expect(serialized).not.toContain(passwordHash);
      expect(serialized).not.toMatch(/FOUNDER_PASSWORD_HASH/);
    }
  });

  it("locks out after repeated failures instead of allowing unlimited guesses", async () => {
    const api = client();
    for (let attempt = 0; attempt < 5; attempt += 1)
      await api.login(`guess-${attempt}`);

    const locked = await api.login("guess-again");
    expect(locked.status).toBe(429);
    expect(locked.payload.error).toMatch(/too many/i);

    // And the lockout is not bypassed by then supplying the real password.
    const correct = await api.login(PASSWORD);
    expect(correct.status).toBe(429);
    expect(correct.setCookie).toBeNull();
  });

  it("cannot have the lockout bypassed with a forged X-Forwarded-For", async () => {
    const api = client();
    for (let attempt = 0; attempt < 5; attempt += 1)
      await api.post(
        "/api/founder/login",
        { password: `guess-${attempt}` },
        { headers: { "X-Forwarded-For": `10.0.0.${attempt}` } }
      );

    // A header anyone can set must not hand out a fresh allowance.
    const rotated = await api.post(
      "/api/founder/login",
      { password: "guess-again" },
      { headers: { "X-Forwarded-For": "203.0.113.99" } }
    );
    expect(rotated.status).toBe(429);
  });

  it("does not let failed attempts grow without bound", async () => {
    // Simulated directly: 10,001 real requests would be a slow test, and the
    // property under test is the map's size, not the transport.
    for (let index = 0; index < 10_050; index += 1)
      auth._attempts.set(`10.1.${index >> 8}.${index & 255}`, {
        count: 1,
        firstAt: Date.now(),
      });
    // One more failure triggers the prune.
    const api = client();
    await api.login("wrong");
    expect(auth._attempts.size).toBeLessThanOrEqual(10_000);
  });

  it("records failures in the audit trail without the attempted password", async () => {
    const api = client();
    await api.login("hunter2-attempt");

    const failure = auditEntries.find((e) => e.action === "founder.login_failed");
    expect(failure).toBeTruthy();
    const serialized = JSON.stringify(failure);
    expect(serialized).not.toContain("hunter2-attempt");
    // Not even the length, which narrows a guess.
    expect(serialized).not.toMatch(/"length"/);
  });

  it("signs out, and the old cookie stops working", async () => {
    const api = client();
    await api.login();
    expect((await api.get("/api/founder/deployments")).status).toBe(200);

    const out = await api.post("/api/founder/logout");
    expect(out.status).toBe(200);

    // The client still presents the same cookie; the server no longer knows it.
    expect((await api.get("/api/founder/deployments")).status).toBe(401);
  });
});

// ----------------------------------------------------------- authorization -

describe("founder authorization", () => {
  it("refuses every founder route without a session", async () => {
    const api = client();
    for (const route of [
      "/api/founder/deployments",
      "/api/founder/deployments/acme",
      "/api/founder/deployments/acme/payment-link",
      "/api/founder/deployments/acme/events",
      "/api/founder/audit",
    ])
      expect((await api.get(route)).status).toBe(401);

    expect((await api.post("/api/founder/deployments", { slug: "x" })).status).toBe(
      401
    );
  });

  it("does not accept a normal customer session", async () => {
    // A valid customer JWT for this deployment, exactly as the product issues
    // it. The founder plane knows nothing about it.
    const jwt = require("jsonwebtoken");
    process.env.JWT_SECRET = "test-jwt-secret-for-customer-tokens";
    const customerToken = jwt.sign(
      { id: 1, username: "owner", role: "admin" },
      process.env.JWT_SECRET
    );

    const api = client();
    const withBearer = await api.get("/api/founder/deployments", {
      headers: { Authorization: `Bearer ${customerToken}` },
    });
    expect(withBearer.status).toBe(401);

    // Nor as a cookie of any name the customer could set.
    const asCookie = await api.get("/api/founder/deployments", {
      headers: { Cookie: `founder_session=${customerToken}` },
    });
    expect(asCookie.status).toBe(401);
  });

  it("refuses a mutating request without the CSRF header", async () => {
    const api = client();
    await api.login();

    const noToken = await api.post(
      "/api/founder/deployments",
      { slug: "acme", domain: "acme.example.com", port: 3101 },
      { csrf: null, headers: { "x-founder-csrf": "" } }
    );
    expect(noToken.status).toBe(403);

    const wrongToken = await api.post(
      "/api/founder/deployments",
      { slug: "acme", domain: "acme.example.com", port: 3101 },
      { headers: { "x-founder-csrf": "b".repeat(48) } }
    );
    expect(wrongToken.status).toBe(403);

    // Nothing was written by either refusal.
    expect(provisioning.listDeployments()).toHaveLength(0);
  });

  it("answers 404 everywhere when the console is not enabled", async () => {
    await shutdown();
    await boot({ FOUNDER_CONSOLE_ENABLED: "false" });

    const api = client();
    expect((await api.get("/api/founder/deployments")).status).toBe(404);
    expect((await api.post("/api/founder/logout")).status).toBe(404);

    // The login page can still tell the difference, without learning anything.
    const session = await api.get("/api/founder/session");
    expect(session.status).toBe(200);
    expect(session.payload.available).toBe(false);
    expect(session.payload.authenticated).toBe(false);
    expect(JSON.stringify(session.payload)).not.toContain(passwordHash);
  });

  it("stays unavailable on a deployment with no state directory - a customer's own box", async () => {
    await shutdown();
    await boot({ PLATFORM_STATE_DIR: path.join(stateDir, "does-not-exist") });

    const api = client();
    const login = await api.login();
    expect(login.status).toBe(401);
    expect(login.payload.error).toMatch(/state directory/i);
    expect((await api.get("/api/founder/deployments")).status).toBe(404);
  });

  it("does not shadow the customer API mounted behind it", async () => {
    const api = client();
    const customer = await api.get("/api/workspace/anything");
    expect(customer.status).toBe(200);
    expect(customer.payload.customerApi).toBe(true);
  });
});

// ------------------------------------------------------------ provisioning -

describe("provisioning a business", () => {
  const acme = {
    slug: "acme",
    name: "Acme Corporation",
    domain: "acme.example.com",
    port: 3101,
  };

  it("creates the deployment and hands back the operator's next command", async () => {
    const api = client();
    await api.login();

    const result = await api.post("/api/founder/deployments", acme);
    expect(result.status).toBe(201);
    expect(result.payload.success).toBe(true);
    expect(result.payload.deployment.slug).toBe("acme");
    // The privileged step is named, not performed.
    expect(result.payload.nextCommand).toBe("./scripts/operator.sh update acme");

    const envFile = path.join(stateDir, "acme", ".env");
    expect(fs.existsSync(envFile)).toBe(true);
    expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
  });

  it("starts the new business unpaid, awaiting the webhook", async () => {
    const api = client();
    await api.login();
    await api.post("/api/founder/deployments", acme);

    const env = fs.readFileSync(path.join(stateDir, "acme", ".env"), "utf8");
    expect(env).toMatch(/^BILLING_ENFORCEMENT_ENABLED=true$/m);
    expect(env).toMatch(/^BILLING_REQUIRE_ACTIVATION=true$/m);
    expect(env).toMatch(/^STRIPE_SUBSCRIPTION_ID=$/m);

    const listed = await api.get("/api/founder/deployments");
    expect(listed.payload.deployments[0].awaitingActivation).toBe(true);
  });

  it("returns only presence flags, never a secret value", async () => {
    const api = client();
    await api.login();
    await api.post("/api/founder/deployments", acme);

    const env = fs.readFileSync(path.join(stateDir, "acme", ".env"), "utf8");
    const deploymentId = env.match(/^DEPLOYMENT_ID=(.+)$/m)[1];
    const jwtSecret = env.match(/^JWT_SECRET=(.+)$/m)[1];

    const listed = await api.get("/api/founder/deployments");
    const detail = await api.get("/api/founder/deployments/acme");

    for (const { payload } of [listed, detail]) {
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain(deploymentId);
      expect(serialized).not.toContain(jwtSecret);
    }
    expect(listed.payload.deployments[0].hasDeploymentId).toBe(true);
  });

  it("refuses an invalid slug, and writes nothing", async () => {
    const api = client();
    await api.login();

    for (const slug of [
      "../escape",
      "a",
      "has space",
      "x".repeat(40),
      "-leading",
      "trailing-",
      "double--hyphen",
      "storage",
    ]) {
      const result = await api.post("/api/founder/deployments", {
        ...acme,
        slug,
      });
      expect(result.status).toBe(400);
      expect(result.payload.problems.join(" ")).toMatch(/slug/i);
    }
    expect(fs.readdirSync(stateDir)).toHaveLength(0);
  });

  it("normalizes a slug's case rather than rejecting it", async () => {
    const api = client();
    await api.login();

    const result = await api.post("/api/founder/deployments", {
      ...acme,
      slug: "Acme",
      domain: "ACME.Example.com",
    });
    expect(result.status).toBe(201);
    expect(result.payload.deployment.slug).toBe("acme");
    expect(result.payload.deployment.domain).toBe("acme.example.com");
    expect(fs.readdirSync(stateDir)).toEqual(["acme"]);
  });

  it("refuses a slug that would traverse out of the state directory", async () => {
    const api = client();
    await api.login();

    const result = await api.post("/api/founder/deployments", {
      ...acme,
      slug: "../../etc",
    });
    expect(result.status).toBe(400);
    expect(fs.existsSync(path.join(stateDir, "..", "..", "etc", ".env"))).toBe(
      false
    );
  });

  it("refuses a second business on the same port or domain", async () => {
    const api = client();
    await api.login();
    await api.post("/api/founder/deployments", acme);

    const samePort = await api.post("/api/founder/deployments", {
      slug: "beta",
      domain: "beta.example.com",
      port: 3101,
    });
    expect(samePort.status).toBe(400);
    expect(samePort.payload.problems.join(" ")).toMatch(/already used/i);

    const sameDomain = await api.post("/api/founder/deployments", {
      slug: "gamma",
      domain: "acme.example.com",
      port: 3102,
    });
    expect(sameDomain.status).toBe(400);
    expect(sameDomain.payload.problems.join(" ")).toMatch(/already used/i);
  });

  it("does not let a crafted name inject another env variable", async () => {
    const api = client();
    await api.login();

    const result = await api.post("/api/founder/deployments", {
      ...acme,
      name: "Acme\nSTRIPE_SECRET_KEY=sk_live_stolen",
    });
    expect(result.status).toBe(400);
    expect(fs.existsSync(path.join(stateDir, "acme", ".env"))).toBe(false);
  });

  it("records the provisioning in the audit trail", async () => {
    const api = client();
    await api.login();
    await api.post("/api/founder/deployments", acme);

    const entry = auditEntries.find(
      (e) => e.action === "founder.provisioned_deployment"
    );
    expect(entry).toBeTruthy();
    expect(entry.resourceId).toBe("acme");
    expect(entry.metadata.awaitingActivation).toBe(true);
  });
});

// ------------------------------------------------------------ payment link -

describe("the payment link", () => {
  const acme = {
    slug: "acme",
    name: "Acme Corporation",
    domain: "acme.example.com",
    port: 3101,
  };
  const link = "https://buy.stripe.com/test_abc123";

  async function provisionAcme(api, extra = {}) {
    await api.login();
    return api.post("/api/founder/deployments", { ...acme, ...extra });
  }

  it("is bound to that deployment's own identifier", async () => {
    const api = client();
    await provisionAcme(api, { paymentLink: link });

    const env = fs.readFileSync(path.join(stateDir, "acme", ".env"), "utf8");
    const deploymentId = env.match(/^DEPLOYMENT_ID=(.+)$/m)[1];

    const result = await api.get("/api/founder/deployments/acme/payment-link");
    expect(result.status).toBe(200);

    const url = new URL(result.payload.url);
    expect(url.origin).toBe("https://buy.stripe.com");
    expect(url.searchParams.get("client_reference_id")).toBe(deploymentId);
  });

  it("gives each business a different link, so a payment cannot land on the wrong one", async () => {
    const api = client();
    await provisionAcme(api, { paymentLink: link });
    await api.post("/api/founder/deployments", {
      slug: "beta",
      name: "Beta",
      domain: "beta.example.com",
      port: 3102,
      paymentLink: link,
    });

    const first = await api.get("/api/founder/deployments/acme/payment-link");
    const second = await api.get("/api/founder/deployments/beta/payment-link");

    const a = new URL(first.payload.url).searchParams.get("client_reference_id");
    const b = new URL(second.payload.url).searchParams.get("client_reference_id");
    expect(a).toEqual(expect.any(String));
    expect(a).not.toBe(b);
  });

  it("refuses to hand out a link when none is configured", async () => {
    const api = client();
    await provisionAcme(api);

    const result = await api.get("/api/founder/deployments/acme/payment-link");
    expect(result.status).toBe(400);
    expect(result.payload.configured).toBe(false);
    expect(result.payload.url).toBeUndefined();
  });

  it("refuses a link that is not Stripe-hosted https", async () => {
    const api = client();
    await api.login();

    for (const bad of [
      "http://buy.stripe.com/test_abc",
      "https://buy.stripe.com.evil.example/test_abc",
      "https://evil.example/pay",
      "javascript:alert(1)",
    ]) {
      const provisioned = await api.post("/api/founder/deployments", {
        ...acme,
        slug: "acme",
        paymentLink: bad,
      });
      expect(provisioned.status).toBe(400);
    }
    expect(fs.existsSync(path.join(stateDir, "acme"))).toBe(false);
  });

  it("records a link added after provisioning, leaving the secrets intact", async () => {
    const api = client();
    await provisionAcme(api);
    const before = fs.readFileSync(path.join(stateDir, "acme", ".env"), "utf8");
    const deploymentId = before.match(/^DEPLOYMENT_ID=(.+)$/m)[1];
    const jwtSecret = before.match(/^JWT_SECRET=(.+)$/m)[1];

    const saved = await api.post("/api/founder/deployments/acme/payment-link", {
      paymentLink: link,
    });
    expect(saved.status).toBe(200);
    // Configuration is read at boot, so the console says what has to happen.
    expect(saved.payload.nextCommand).toBe("./scripts/operator.sh update acme");

    const after = fs.readFileSync(path.join(stateDir, "acme", ".env"), "utf8");
    expect(after).toMatch(new RegExp(`^STRIPE_PAYMENT_LINK=${link}$`, "m"));
    expect(after).toMatch(new RegExp(`^DEPLOYMENT_ID=${deploymentId}$`, "m"));
    expect(after).toMatch(new RegExp(`^JWT_SECRET=${jwtSecret}$`, "m"));
    // Exactly one, not appended alongside the original empty value.
    expect(after.match(/^STRIPE_PAYMENT_LINK=/gm)).toHaveLength(1);
    expect(fs.statSync(path.join(stateDir, "acme", ".env")).mode & 0o777).toBe(
      0o600
    );
  });

  it("refuses to record a link that is not Stripe-hosted", async () => {
    const api = client();
    await provisionAcme(api);

    const result = await api.post("/api/founder/deployments/acme/payment-link", {
      paymentLink: "https://evil.example/pay",
    });
    expect(result.status).toBe(400);

    const env = fs.readFileSync(path.join(stateDir, "acme", ".env"), "utf8");
    expect(env).not.toContain("evil.example");
  });

  it("answers 404 for a deployment that does not exist", async () => {
    const api = client();
    await api.login();
    expect(
      (await api.get("/api/founder/deployments/nope/payment-link")).status
    ).toBe(404);
    expect((await api.get("/api/founder/deployments/nope")).status).toBe(404);
  });
});

// ----------------------------------------------------------- payment events

describe("payment events", () => {
  it("reports a deployment that is not running rather than failing", async () => {
    const api = client();
    await api.login();
    await api.post("/api/founder/deployments", {
      slug: "acme",
      name: "Acme",
      domain: "acme.example.com",
      // Nothing is listening here.
      port: 3199,
    });

    const detail = await api.get("/api/founder/deployments/acme");
    expect(detail.status).toBe(200);
    expect(detail.payload.live.reachable).toBe(false);
    expect(detail.payload.live.reason).toEqual(expect.any(String));

    const events = await api.get("/api/founder/deployments/acme/events");
    expect(events.status).toBe(200);
    expect(events.payload.events).toBeNull();
  });

  it("exposes no route that could activate a deployment", async () => {
    const api = client();
    await api.login();
    await api.post("/api/founder/deployments", {
      slug: "acme",
      name: "Acme",
      domain: "acme.example.com",
      port: 3199,
    });

    // Every shape an "activate this one" endpoint might take.
    for (const attempt of [
      "/api/founder/deployments/acme/activate",
      "/api/founder/deployments/acme/billing",
      "/api/founder/deployments/acme/events/bind",
      "/api/founder/deployments/acme/subscription",
      "/api/founder/run",
      "/api/founder/exec",
    ]) {
      const result = await api.post(attempt, { status: "active" });
      // Falls through to the customer API stub or 404s; never handled here.
      expect([200, 404]).toContain(result.status);
      expect(result.payload?.success).not.toBe(true);
    }

    // And the deployment is still unpaid.
    const env = fs.readFileSync(path.join(stateDir, "acme", ".env"), "utf8");
    expect(env).toMatch(/^BILLING_REQUIRE_ACTIVATION=true$/m);
    expect(env).toMatch(/^STRIPE_SUBSCRIPTION_ID=$/m);
  });
});
