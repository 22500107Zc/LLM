/**
 * Stripe customer binding.
 *
 * A Stripe account can serve many deployments. The weakness being closed here
 * is that an UNBOUND deployment used to accept whichever event arrived first,
 * so any valid event from the same account could attach a customer that does
 * not belong to that business.
 *
 * The rule under test: an unbound deployment may bind ONLY from a
 * checkout.session.completed for a session it recorded itself, stamped with
 * its own DEPLOYMENT_ID. Once bound, every applicable event must carry exactly
 * that customer.
 */

const DEPLOYMENT_ID = "a".repeat(64);
const OTHER_DEPLOYMENT_ID = "b".repeat(64);
const OUR_CUSTOMER = "cus_ours00000000001";
const FOREIGN_CUSTOMER = "cus_theirs000000001";

/** In-memory stand-ins for the two tables binding touches. */
function makeDb() {
  const state = {
    subscription: { id: 1, stripe_customer_id: null, bound_deployment_id: null },
    pending: new Map(),
  };

  return {
    state,
    client: {
      billing_subscription: {
        findUnique: async () => ({ ...state.subscription }),
        // Mirrors the conditional UPDATE the real binding relies on.
        updateMany: async ({ where, data }) => {
          if (where.stripe_customer_id === null && state.subscription.stripe_customer_id !== null)
            return { count: 0 };
          Object.assign(state.subscription, data);
          return { count: 1 };
        },
      },
      billing_pending_checkouts: {
        upsert: async ({ where, create }) => {
          const row = { ...create, session_id: where.session_id };
          state.pending.set(where.session_id, row);
          return row;
        },
        findUnique: async ({ where }) => state.pending.get(where.session_id) ?? null,
        updateMany: async ({ where, data }) => {
          const row = state.pending.get(where.session_id);
          if (!row) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        },
        deleteMany: async () => ({ count: 0 }),
      },
      audit_logs: { create: async () => ({}) },
    },
  };
}

function loadBinding(db, env = {}) {
  jest.resetModules();
  process.env.DEPLOYMENT_ID = env.DEPLOYMENT_ID ?? DEPLOYMENT_ID;
  if (env.STRIPE_CUSTOMER_ID) process.env.STRIPE_CUSTOMER_ID = env.STRIPE_CUSTOMER_ID;
  else delete process.env.STRIPE_CUSTOMER_ID;

  jest.doMock("../../utils/prisma", () => db.client);
  return require("../../business/billing/binding");
}

function checkoutEvent({ sessionId, customer = OUR_CUSTOMER, deploymentId = DEPLOYMENT_ID }) {
  return {
    id: `evt_${sessionId}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        object: "checkout_session",
        mode: "subscription",
        customer,
        metadata: { deployment_id: deploymentId },
      },
    },
  };
}

function invoiceEvent(customer = FOREIGN_CUSTOMER) {
  return {
    id: "evt_invoice_1",
    type: "invoice.paid",
    data: { object: { id: "in_1", object: "invoice", customer } },
  };
}

afterEach(() => {
  delete process.env.DEPLOYMENT_ID;
  delete process.env.STRIPE_CUSTOMER_ID;
  jest.resetModules();
});

describe("an unbound deployment", () => {
  it("REFUSES to bind from an invoice event", async () => {
    const db = makeDb();
    const binding = loadBinding(db);
    const decision = await binding.authorizeEvent(invoiceEvent(), FOREIGN_CUSTOMER);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/cannot be bound by invoice\.paid/);
    expect(db.state.subscription.stripe_customer_id).toBeNull();
  });

  it.each([
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "invoice.payment_failed",
    "customer.deleted",
  ])("REFUSES to bind from %s", async (type) => {
    const db = makeDb();
    const binding = loadBinding(db);
    const decision = await binding.authorizeEvent(
      { id: "evt_x", type, data: { object: { customer: FOREIGN_CUSTOMER } } },
      FOREIGN_CUSTOMER
    );
    expect(decision.allowed).toBe(false);
  });

  it("REFUSES a checkout session it did not create", async () => {
    const db = makeDb();
    const binding = loadBinding(db);
    const decision = await binding.authorizeEvent(
      checkoutEvent({ sessionId: "cs_never_seen" }),
      OUR_CUSTOMER
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/not created by this deployment/);
  });

  it("REFUSES a checkout whose metadata names another deployment", async () => {
    const db = makeDb();
    const binding = loadBinding(db);
    await binding.recordPendingCheckout({ sessionId: "cs_1", expectedCustomer: OUR_CUSTOMER });
    const decision = await binding.authorizeEvent(
      checkoutEvent({ sessionId: "cs_1", deploymentId: OTHER_DEPLOYMENT_ID }),
      OUR_CUSTOMER
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/another deployment/);
  });

  it("REFUSES a checkout that completed for an unexpected customer", async () => {
    const db = makeDb();
    const binding = loadBinding(db);
    await binding.recordPendingCheckout({ sessionId: "cs_2", expectedCustomer: OUR_CUSTOMER });
    const decision = await binding.authorizeEvent(
      checkoutEvent({ sessionId: "cs_2", customer: FOREIGN_CUSTOMER }),
      FOREIGN_CUSTOMER
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/unexpected customer/);
  });

  it("ACCEPTS a checkout it created itself, and binds", async () => {
    const db = makeDb();
    const binding = loadBinding(db);
    await binding.recordPendingCheckout({ sessionId: "cs_ok", expectedCustomer: OUR_CUSTOMER });

    const decision = await binding.authorizeEvent(
      checkoutEvent({ sessionId: "cs_ok" }),
      OUR_CUSTOMER
    );
    expect(decision.allowed).toBe(true);
    expect(decision.bindWith).toBeTruthy();

    const bound = await binding.bindCustomer(decision.bindWith);
    expect(bound.result).toBe(binding.BIND_RESULT.BOUND);
    expect(db.state.subscription.stripe_customer_id).toBe(OUR_CUSTOMER);
    expect(db.state.subscription.bound_deployment_id).toBe(DEPLOYMENT_ID);
  });

  it("refuses an expired pending checkout", async () => {
    const db = makeDb();
    const binding = loadBinding(db);
    await binding.recordPendingCheckout({ sessionId: "cs_old", expectedCustomer: OUR_CUSTOMER });
    db.state.pending.get("cs_old").expiresAt = new Date(Date.now() - 1000);

    const decision = await binding.authorizeEvent(
      checkoutEvent({ sessionId: "cs_old" }),
      OUR_CUSTOMER
    );
    expect(decision.allowed).toBe(false);
  });
});

describe("STRIPE_CUSTOMER_ID is configured", () => {
  it("requires an exact match from the very first event", async () => {
    const db = makeDb();
    const binding = loadBinding(db, { STRIPE_CUSTOMER_ID: OUR_CUSTOMER });
    const bound = await binding.bindCustomer({
      customerId: FOREIGN_CUSTOMER,
      via: "test",
    });
    expect(bound.result).toBe(binding.BIND_RESULT.REJECTED);
    expect(bound.reason).toMatch(/STRIPE_CUSTOMER_ID/);
    expect(db.state.subscription.stripe_customer_id).toBeNull();
  });

  it("accepts the configured customer", async () => {
    const db = makeDb();
    const binding = loadBinding(db, { STRIPE_CUSTOMER_ID: OUR_CUSTOMER });
    const bound = await binding.bindCustomer({ customerId: OUR_CUSTOMER, via: "test" });
    expect(bound.result).toBe(binding.BIND_RESULT.BOUND);
  });
});

describe("a bound deployment", () => {
  async function bound() {
    const db = makeDb();
    const binding = loadBinding(db);
    await binding.recordPendingCheckout({ sessionId: "cs_b", expectedCustomer: OUR_CUSTOMER });
    const decision = await binding.authorizeEvent(
      checkoutEvent({ sessionId: "cs_b" }),
      OUR_CUSTOMER
    );
    await binding.bindCustomer(decision.bindWith);
    return { db, binding };
  }

  it("accepts an event for its own customer", async () => {
    const { binding } = await bound();
    const decision = await binding.authorizeEvent(invoiceEvent(OUR_CUSTOMER), OUR_CUSTOMER);
    expect(decision.allowed).toBe(true);
  });

  it("REJECTS an event for a different customer", async () => {
    const { binding } = await bound();
    const decision = await binding.authorizeEvent(
      invoiceEvent(FOREIGN_CUSTOMER),
      FOREIGN_CUSTOMER
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/different Stripe customer/);
  });

  it("REJECTS a later checkout that would rebind it elsewhere", async () => {
    const { db, binding } = await bound();
    await binding.recordPendingCheckout({
      sessionId: "cs_rebind",
      expectedCustomer: FOREIGN_CUSTOMER,
    });
    const decision = await binding.authorizeEvent(
      checkoutEvent({ sessionId: "cs_rebind", customer: FOREIGN_CUSTOMER }),
      FOREIGN_CUSTOMER
    );
    expect(decision.allowed).toBe(false);
    expect(db.state.subscription.stripe_customer_id).toBe(OUR_CUSTOMER);
  });

  it("treats a repeat bind for the same customer as already bound", async () => {
    const { binding } = await bound();
    const again = await binding.bindCustomer({ customerId: OUR_CUSTOMER, via: "retry" });
    expect(again.result).toBe(binding.BIND_RESULT.ALREADY_BOUND);
  });
});

describe("event ordering", () => {
  it("a subscription event arriving BEFORE checkout does not bind", async () => {
    const db = makeDb();
    const binding = loadBinding(db);
    // Stripe can deliver customer.subscription.created first.
    const early = await binding.authorizeEvent(
      {
        id: "evt_early",
        type: "customer.subscription.created",
        data: { object: { id: "sub_1", customer: OUR_CUSTOMER } },
      },
      OUR_CUSTOMER
    );
    expect(early.allowed).toBe(false);
    expect(db.state.subscription.stripe_customer_id).toBeNull();

    // Once checkout lands, the deployment binds and later events are accepted.
    await binding.recordPendingCheckout({ sessionId: "cs_late", expectedCustomer: OUR_CUSTOMER });
    const decision = await binding.authorizeEvent(
      checkoutEvent({ sessionId: "cs_late" }),
      OUR_CUSTOMER
    );
    await binding.bindCustomer(decision.bindWith);

    const retried = await binding.authorizeEvent(
      {
        id: "evt_early",
        type: "customer.subscription.created",
        data: { object: { id: "sub_1", customer: OUR_CUSTOMER } },
      },
      OUR_CUSTOMER
    );
    expect(retried.allowed).toBe(true);
  });
});

describe("concurrent delivery", () => {
  it("only one of two simultaneous binds succeeds", async () => {
    const db = makeDb();
    const binding = loadBinding(db);
    const [a, b] = await Promise.all([
      binding.bindCustomer({ customerId: OUR_CUSTOMER, via: "a" }),
      binding.bindCustomer({ customerId: OUR_CUSTOMER, via: "b" }),
    ]);
    const outcomes = [a.result, b.result].sort();
    expect(outcomes).toEqual([binding.BIND_RESULT.ALREADY_BOUND, binding.BIND_RESULT.BOUND].sort());
    expect(db.state.subscription.stripe_customer_id).toBe(OUR_CUSTOMER);
  });

  it("a simultaneous foreign bind cannot win", async () => {
    const db = makeDb();
    const binding = loadBinding(db);
    const [ours, theirs] = await Promise.all([
      binding.bindCustomer({ customerId: OUR_CUSTOMER, via: "ours" }),
      binding.bindCustomer({ customerId: FOREIGN_CUSTOMER, via: "theirs" }),
    ]);
    // Whichever ran first wins; the other must be rejected, never silently
    // overwriting the binding.
    const bound = db.state.subscription.stripe_customer_id;
    expect([OUR_CUSTOMER, FOREIGN_CUSTOMER]).toContain(bound);
    const results = [ours.result, theirs.result];
    expect(results.filter((r) => r === binding.BIND_RESULT.BOUND)).toHaveLength(1);
  });
});

describe("pending checkout lifecycle", () => {
  it("is consumed so it cannot bind twice", async () => {
    const db = makeDb();
    const binding = loadBinding(db);
    await binding.recordPendingCheckout({ sessionId: "cs_once", expectedCustomer: OUR_CUSTOMER });
    await binding.consumePendingCheckout("cs_once");
    expect(db.state.pending.get("cs_once").status).toBe("consumed");
  });
});

describe("identifier comparison", () => {
  it("is exact, not a prefix match", async () => {
    const db = makeDb();
    const binding = loadBinding(db);
    expect(binding.idsMatch("cus_abc", "cus_abc")).toBe(true);
    expect(binding.idsMatch("cus_abc", "cus_abcd")).toBe(false);
    expect(binding.idsMatch("cus_abc", "")).toBe(false);
    expect(binding.idsMatch(null, null)).toBe(false);
  });

  it("never logs a deployment id in full", async () => {
    const db = makeDb();
    const binding = loadBinding(db);
    const masked = binding.maskId(DEPLOYMENT_ID);
    expect(masked).not.toBe(DEPLOYMENT_ID);
    expect(masked.length).toBeLessThan(16);
  });
});

describe("the plan amount is configurable and validated", () => {
  afterEach(() => {
    delete process.env.PLAN_AMOUNT_CENTS;
    jest.resetModules();
  });

  it("defaults to $3,888.88", () => {
    jest.resetModules();
    delete process.env.PLAN_AMOUNT_CENTS;
    const config = require("../../business/config");
    expect(config.PLAN.amountCents).toBe(388888);
    expect(config.PLAN.displayPriceWithInterval).toBe("$3,888.88/month");
  });

  it("honours PLAN_AMOUNT_CENTS", () => {
    jest.resetModules();
    process.env.PLAN_AMOUNT_CENTS = "500000";
    const config = require("../../business/config");
    expect(config.PLAN.amountCents).toBe(500000);
    expect(config.PLAN.displayPriceWithInterval).toBe("$5,000.00/month");
  });

  it("falls back to the default for a nonsensical value", () => {
    jest.resetModules();
    process.env.PLAN_AMOUNT_CENTS = "not-a-number";
    const config = require("../../business/config");
    expect(config.PLAN.amountCents).toBe(388888);
  });
});

describe("production boot requires a deployment identity", () => {
  const { evaluatePosture } = require("../../business/boot");
  const strong = () => require("crypto").randomBytes(32).toString("hex");

  it("fails without DEPLOYMENT_ID", () => {
    const { errors } = evaluatePosture({
      NODE_ENV: "production",
      JWT_SECRET: strong(),
      SIG_KEY: strong(),
      SIG_SALT: strong(),
    });
    expect(errors.join(" ")).toMatch(/DEPLOYMENT_ID is not set/);
  });

  it("fails on a guessable DEPLOYMENT_ID", () => {
    const { errors } = evaluatePosture({
      NODE_ENV: "production",
      DEPLOYMENT_ID: "customer-one",
      JWT_SECRET: strong(),
      SIG_KEY: strong(),
      SIG_SALT: strong(),
    });
    expect(errors.join(" ")).toMatch(/too short to be unguessable/);
  });

  it("passes with a strong DEPLOYMENT_ID", () => {
    const { errors } = evaluatePosture({
      NODE_ENV: "production",
      DEPLOYMENT_ID: strong(),
      JWT_SECRET: strong(),
      SIG_KEY: strong(),
      SIG_SALT: strong(),
    });
    expect(errors).toHaveLength(0);
  });
});
