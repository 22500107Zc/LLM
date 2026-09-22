/**
 * Application access.
 *
 * The commercial promise used to be a billing one: pay, or AI usage is
 * suspended. It is not any more. The founder decides who is in the product,
 * payment is arranged outside it, and no payment processor is consulted to
 * answer a request.
 *
 * What these pin down is that the wiring matches that: nothing mounts a
 * subscription gate, the founder plane contains no Stripe, and the flag the
 * customer model writes is the flag request validation reads.
 */

/**
 * ACCESS CONTROL, AS THE PRODUCT ACTUALLY WORKS
 *
 * This file used to assert that a Stripe subscription decided who could use
 * the AI. It does not any more, and these tests pin down the replacement:
 *
 *   The founder decides who is in the product. Payment is arranged outside the
 *   application through a hosted link, and the application never asks Stripe
 *   anything. `users.suspended` is the access flag, and the inherited request
 *   validation checks it on every authenticated request.
 *
 * The end-to-end proof - disable a customer, watch their live session stop
 * working on the next request - lives in `founder.test.js`, which drives a
 * real server. These cover the structural guarantees.
 */

describe("no payment processor decides application access", () => {
  const fs = require("fs");
  const path = require("path");
  const SERVER_DIR = path.resolve(__dirname, "..", "..");

  const read = (relative) =>
    fs.readFileSync(path.join(SERVER_DIR, relative), "utf8");

  /** Comments discuss Stripe's absence; assertions are about code. */
  const codeOnly = (source) =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("mounts no subscription gate on any route", () => {
    const source = read("business/routes/index.js");
    expect(source).not.toMatch(/app\.use\([^)]*requireActiveSubscription/);
    expect(codeOnly(source)).not.toContain("requireActiveSubscription");
  });

  it("keeps the founder plane free of Stripe entirely", () => {
    const dir = path.join(SERVER_DIR, "business", "founder");
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".js")) continue;
      expect(codeOnly(read(path.join("business", "founder", file)))).not.toMatch(
        /stripe/i
      );
    }
  });

  it("enforces access through the flag request validation actually reads", () => {
    // The customer model must write the same flag `validatedRequest` checks.
    // Any second copy of it would eventually disagree with the enforced one.
    expect(codeOnly(read("business/models/customer.js"))).toContain("suspended");
    expect(read("utils/middleware/validatedRequest.js")).toContain(
      "user.suspended"
    );
  });

  it("re-reads the user on every request rather than trusting the token", () => {
    // This is what makes disabling immediate instead of waiting for a token to
    // expire, and what stops a disabled customer calling endpoints directly.
    const source = read("utils/middleware/validatedRequest.js");
    expect(source).toMatch(/await User\.get\(\{ id: valid\.id \}\)/);
    expect(source).toMatch(/if \(user\.suspended\)/);
  });
});

describe("every AI entry point is accounted for", () => {
  /**
   * A new upstream chat route must not appear unnoticed.
   *
   * What is guarded now is coverage, not payment: every endpoint that reaches
   * a model is either behind the customer session or on the deliberate public
   * list (the website embed widget, which serves a customer's own visitors).
   */
  const fs = require("fs");
  const path = require("path");

  const SERVER_DIR = path.resolve(__dirname, "..", "..");
  const { AI_ENDPOINTS } = require("../../business/routes");
  const known = new Set([
    ...AI_ENDPOINTS.authenticated,
    ...AI_ENDPOINTS.public,
  ]);

  /** Route files that expose model-invoking endpoints. */
  const ROUTE_FILES = [
    "endpoints/api/workspace/index.js",
    "endpoints/api/workspaceThread/index.js",
    "endpoints/api/openai/index.js",
    "endpoints/chat.js",
    "endpoints/embed/index.js",
  ];

  /** Endpoints that read stored history rather than invoking a model. */
  const READ_ONLY = /\/chats$|\/chats\//;

  function chatEndpointsIn(relativePath) {
    const full = path.join(SERVER_DIR, relativePath);
    if (!fs.existsSync(full)) return [];
    const source = fs.readFileSync(full, "utf8");

    if (
      !/ApiChatHandler|streamChatWithWorkspace|chatWithWorkspace|streamChatWithForEmbed/.test(
        source
      )
    )
      return [];

    return [...source.matchAll(/"(\/[^"]*chat[^"]*)"/g)]
      .map((match) => match[1])
      .filter((route) => !READ_ONLY.test(route));
  }

  it("accounts for every model-invoking route", () => {
    const unknown = [];
    for (const file of ROUTE_FILES)
      for (const route of chatEndpointsIn(file))
        if (!known.has(route)) unknown.push(`${file} -> ${route}`);

    expect(unknown).toEqual([]);
  });

  it("includes the developer API's thread endpoints", () => {
    // These reach ApiChatHandler exactly like the workspace ones, and were
    // once missing from the list entirely.
    expect(known.has("/v1/workspace/:slug/thread/:threadSlug/chat")).toBe(true);
    expect(
      known.has("/v1/workspace/:slug/thread/:threadSlug/stream-chat")
    ).toBe(true);
  });

  it("keeps the public embed path separate from authenticated usage", () => {
    // A website visitor has no account by design; a customer always does.
    expect(AI_ENDPOINTS.public).toContain("/embed/:embedId/stream-chat");
    expect(AI_ENDPOINTS.authenticated).not.toContain(
      "/embed/:embedId/stream-chat"
    );
  });
});

describe("billing reporting stays inert", () => {
  /**
   * The billing model is kept for reporting an operator may still want, but it
   * must never conclude that a customer should be locked out - that decision
   * does not belong to it any more.
   */
  function evaluate(env = {}, record = null) {
    jest.resetModules();
    Object.assign(process.env, {
      BILLING_ENFORCEMENT_ENABLED: "false",
      ...env,
    });
    const { Billing } = require("../../business/models/billing");
    return Billing.evaluateAccess(record);
  }

  it("reports OK when no subscription exists at all", () => {
    const access = evaluate({}, null);
    expect(access.access).toBe("ok");
  });

  it("still reports OK with no subscription even if enforcement is switched on", () => {
    // A missing Stripe configuration must never be read as "lock them out".
    const access = evaluate({ BILLING_ENFORCEMENT_ENABLED: "true" }, null);
    expect(access.access).toBe("ok");
    expect(access.reason).toBe("unconfigured");
  });

  it("has no activation flag left to gate a customer with", () => {
    const fs = require("fs");
    const path = require("path");
    const config = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "business", "config.js"),
      "utf8"
    );
    expect(config).not.toContain("BILLING_REQUIRE_ACTIVATION");
  });
});

describe("the operator status endpoint's token guard", () => {
  function guard(env = {}) {
    jest.resetModules();
    Object.assign(process.env, { HEALTHCHECK_TOKEN: "", ...env });
    return require("../../business/middleware").strictHealthTokenGuard;
  }

  function mockResponse() {
    return {
      statusCode: null,
      payload: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.payload = body;
        return this;
      },
      sendStatus(code) {
        this.statusCode = code;
        return this;
      },
    };
  }

  afterEach(() => {
    delete process.env.HEALTHCHECK_TOKEN;
  });

  it("refuses entirely when no token is configured", () => {
    const response = mockResponse();
    let reached = false;
    guard()({ headers: {} }, response, () => {
      reached = true;
    });

    // 404, not 401: an unconfigured deployment does not admit the route exists.
    expect(response.statusCode).toBe(404);
    expect(reached).toBe(false);
  });

  it("refuses a wrong token", () => {
    const response = mockResponse();
    let reached = false;
    guard({ HEALTHCHECK_TOKEN: "the-real-token" })(
      { headers: { "x-health-token": "not-it" } },
      response,
      () => {
        reached = true;
      }
    );
    expect(response.statusCode).toBe(401);
    expect(reached).toBe(false);
  });

  it("admits the configured token", () => {
    const response = mockResponse();
    let reached = false;
    guard({ HEALTHCHECK_TOKEN: "the-real-token" })(
      { headers: { "x-health-token": "the-real-token" } },
      response,
      () => {
        reached = true;
      }
    );
    expect(reached).toBe(true);
    expect(response.statusCode).toBeNull();
  });
});
