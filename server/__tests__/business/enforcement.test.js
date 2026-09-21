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
