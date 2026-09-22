/**
 * Subscription enforcement behaviour.
 *
 * The commercial promise is specific: a failed payment warns, then suspends AI
 * usage, and NEVER deletes data or locks the owner out of billing. These tests
 * pin that behaviour down.
 */

function loadGate(env = {}) {
  jest.resetModules();
  Object.assign(process.env, {
    BILLING_ENFORCEMENT_ENABLED: "true",
    BILLING_GRACE_PERIOD_DAYS: "7",
    BILLING_RESTRICT_INTERNAL_CHAT: "true",
    BILLING_RESTRICT_PUBLIC_AGENTS: "true",
    ...env,
  });
  return require("../../business/middleware/billingGate");
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
  };
}

/** Stubs the billing model so no database is required. */
function stubAccess(access) {
  jest.doMock("../../business/models/billing", () => {
    const actual = jest.requireActual("../../business/models/billing");
    return {
      ...actual,
      Billing: {
        ...actual.Billing,
        currentAccess: async () => ({
          record: {},
          access,
          status: access === "restricted" ? "past_due" : "active",
          statusLabel: access === "restricted" ? "Past due" : "Active",
          reason: access === "restricted" ? "grace_period_expired" : null,
          message: access === "restricted" ? "Billing is overdue." : null,
        }),
      },
    };
  });
}

describe("requireActiveSubscription (internal AI usage)", () => {
  afterEach(() => jest.resetModules());

  it("blocks internal chat with 402 when restricted", async () => {
    stubAccess("restricted");
    const gate = loadGate();
    const response = mockResponse();
    let passed = false;

    await gate.requireActiveSubscription({}, response, () => {
      passed = true;
    });

    expect(passed).toBe(false);
    expect(response.statusCode).toBe(402);
    expect(response.payload.error).toBe("subscription_restricted");
  });

  it("allows internal chat during the grace period", async () => {
    stubAccess("warning");
    const gate = loadGate();
    const response = mockResponse();
    let passed = false;

    await gate.requireActiveSubscription({}, response, () => {
      passed = true;
    });

    expect(passed).toBe(true);
    expect(response.statusCode).toBeNull();
  });

  it("allows internal chat when billing is healthy", async () => {
    stubAccess("ok");
    const gate = loadGate();
    const response = mockResponse();
    let passed = false;
    await gate.requireActiveSubscription({}, response, () => {
      passed = true;
    });
    expect(passed).toBe(true);
  });

  it("never blocks when enforcement is switched off, even if restricted", async () => {
    stubAccess("restricted");
    const gate = loadGate({ BILLING_ENFORCEMENT_ENABLED: "false" });
    const response = mockResponse();
    let passed = false;
    await gate.requireActiveSubscription({}, response, () => {
      passed = true;
    });
    expect(passed).toBe(true);
  });

  it("respects BILLING_RESTRICT_INTERNAL_CHAT=false", async () => {
    stubAccess("restricted");
    const gate = loadGate({ BILLING_RESTRICT_INTERNAL_CHAT: "false" });
    const response = mockResponse();
    let passed = false;
    await gate.requireActiveSubscription({}, response, () => {
      passed = true;
    });
    expect(passed).toBe(true);
  });
});

describe("requireActiveSubscriptionForPublic (website agents)", () => {
  afterEach(() => jest.resetModules());

  it("blocks a public agent when restricted", async () => {
    stubAccess("restricted");
    const gate = loadGate();
    const response = mockResponse();
    let passed = false;

    await gate.requireActiveSubscriptionForPublic({}, response, () => {
      passed = true;
    });

    expect(passed).toBe(false);
    expect(response.statusCode).toBe(503);
    expect(response.payload.type).toBe("abort");
  });

  it("never reveals billing detail to a website visitor", async () => {
    stubAccess("restricted");
    const gate = loadGate();
    const response = mockResponse();
    await gate.requireActiveSubscriptionForPublic({}, response, () => {});

    const serialized = JSON.stringify(response.payload).toLowerCase();
    for (const leak of [
      "billing",
      "payment",
      "subscription",
      "past_due",
      "overdue",
      "invoice",
      "stripe",
    ])
      expect(serialized).not.toContain(leak);
  });

  it("allows a public agent during the grace period", async () => {
    stubAccess("warning");
    const gate = loadGate();
    const response = mockResponse();
    let passed = false;
    await gate.requireActiveSubscriptionForPublic({}, response, () => {
      passed = true;
    });
    expect(passed).toBe(true);
  });
});

describe("automations gating", () => {
  afterEach(() => jest.resetModules());

  it("halts scheduled automations when restricted", async () => {
    stubAccess("restricted");
    const gate = loadGate();
    expect(await gate.automationsPermitted()).toBe(false);
  });

  it("runs automations during the grace period", async () => {
    stubAccess("warning");
    const gate = loadGate();
    expect(await gate.automationsPermitted()).toBe(true);
  });
});

describe("restriction is suspension, not deletion", () => {
  it("the policy never enables data deletion", () => {
    jest.resetModules();
    const config = require("../../business/config");
    expect(config.billingPolicy.deleteDataOnCancellation).toBe(false);
  });

  it("the restricted message tells the customer their data is retained", () => {
    jest.resetModules();
    process.env.BILLING_ENFORCEMENT_ENABLED = "true";
    const { Billing } = require("../../business/models/billing");
    const result = Billing.evaluateAccess(
      {
        status: "past_due",
        past_due_since: new Date(Date.now() - 60 * 86_400_000),
      },
      new Date()
    );
    expect(result.access).toBe("restricted");
    expect(result.message.toLowerCase()).toContain("data is retained");
  });
});

describe("every AI entry point is actually gated", () => {
  /**
   * Middleware that works is not the same as middleware that is mounted.
   *
   * The gate is attached per path, so an endpoint that reaches a model
   * without a mount is a way to keep using the product after payment stops -
   * and it fails silently, because everything still works. This walks the
   * real route files and fails if any of them reaches ApiChatHandler or the
   * chat helpers without appearing in the mount list.
   */
  const fs = require("fs");
  const path = require("path");

  const SERVER_DIR = path.resolve(__dirname, "..", "..");
  const { GATED_AI_PATHS } = require("../../business/routes");
  const gated = new Set([
    ...GATED_AI_PATHS.authenticated,
    ...GATED_AI_PATHS.public,
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

    // Only files that actually invoke a model are worth scanning.
    if (!/ApiChatHandler|streamChatWithWorkspace|chatWithWorkspace|streamChatWithForEmbed/.test(source))
      return [];

    return [...source.matchAll(/"(\/[^"]*chat[^"]*)"/g)]
      .map((match) => match[1])
      .filter((route) => !READ_ONLY.test(route));
  }

  it("mounts the gate on every model-invoking route", () => {
    const ungated = [];
    for (const file of ROUTE_FILES)
      for (const route of chatEndpointsIn(file))
        if (!gated.has(route)) ungated.push(`${file} -> ${route}`);

    expect(ungated).toEqual([]);
  });

  it("covers the developer API's thread endpoints", () => {
    // These reach ApiChatHandler exactly like the workspace ones, and were
    // once missing, which let a restricted deployment keep using the model.
    expect(gated.has("/v1/workspace/:slug/thread/:threadSlug/chat")).toBe(true);
    expect(gated.has("/v1/workspace/:slug/thread/:threadSlug/stream-chat")).toBe(
      true
    );
  });

  it("gates public website agents separately from authenticated usage", () => {
    // A visitor must never be shown the deployment's billing state.
    expect(GATED_AI_PATHS.public).toContain("/embed/:embedId/stream-chat");
    expect(GATED_AI_PATHS.authenticated).not.toContain(
      "/embed/:embedId/stream-chat"
    );
  });
});

describe("a newly provisioned business starts unpaid", () => {
  /** Evaluates access with a specific policy, no database involved. */
  function evaluate(env, record) {
    jest.resetModules();
    Object.assign(process.env, {
      BILLING_ENFORCEMENT_ENABLED: "true",
      BILLING_REQUIRE_ACTIVATION: "false",
      ...env,
    });
    const { Billing } = require("../../business/models/billing");
    return Billing.evaluateAccess(record);
  }

  afterEach(() => {
    delete process.env.BILLING_REQUIRE_ACTIVATION;
  });

  it("restricts AI usage while it is awaiting its first payment", () => {
    const access = evaluate({ BILLING_REQUIRE_ACTIVATION: "true" }, null);

    expect(access.access).toBe("restricted");
    expect(access.reason).toBe("awaiting_activation");
    // The customer is told what to do, and told their data is untouched.
    expect(access.message).toMatch(/payment/i);
    expect(access.message).toMatch(/no data is affected/i);
  });

  it("is activated by a real subscription, not by an operator toggle", () => {
    const active = evaluate(
      { BILLING_REQUIRE_ACTIVATION: "true" },
      { status: "active", cancel_at_period_end: false }
    );
    expect(active.access).toBe("ok");
  });

  it("leaves an existing unconfigured deployment alone when the flag is off", () => {
    // This is the pre-existing promise: never punish a paying customer for the
    // operator not having wired Stripe up. Provisioning opts new customers in;
    // nothing opts an existing one in behind their back.
    const access = evaluate({}, null);
    expect(access.access).toBe("ok");
    expect(access.reason).toBe("unconfigured");
  });

  it("does not restrict when enforcement itself is off", () => {
    const access = evaluate(
      {
        BILLING_ENFORCEMENT_ENABLED: "false",
        BILLING_REQUIRE_ACTIVATION: "true",
      },
      null
    );
    expect(access.access).toBe("ok");
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
