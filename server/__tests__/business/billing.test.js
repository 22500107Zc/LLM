/**
 * Commercial billing state machine.
 * These tests cover the rules a paying customer depends on: they must never be
 * locked out by a single failed payment, and they must never keep service
 * indefinitely without paying.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-03-20T12:00:00.000Z");

function loadBilling(env = {}) {
  jest.resetModules();
  const previous = { ...process.env };
  Object.assign(process.env, {
    BILLING_ENFORCEMENT_ENABLED: "true",
    BILLING_GRACE_PERIOD_DAYS: "7",
    ...env,
  });
  const mod = require("../../business/models/billing");
  return { ...mod, restore: () => (process.env = previous) };
}

describe("Billing.evaluateAccess", () => {
  let Billing;
  let ACCESS;
  let STATUS;
  let restore;

  beforeEach(() => {
    const loaded = loadBilling();
    Billing = loaded.Billing;
    ACCESS = loaded.ACCESS;
    STATUS = loaded.STATUS;
    restore = loaded.restore;
  });

  afterEach(() => restore());

  it("allows an active subscription", () => {
    const result = Billing.evaluateAccess({ status: STATUS.ACTIVE }, NOW);
    expect(result.access).toBe(ACCESS.OK);
  });

  it("allows a trialing subscription", () => {
    expect(Billing.evaluateAccess({ status: STATUS.TRIALING }, NOW).access).toBe(
      ACCESS.OK
    );
  });

  it("warns, but does not restrict, on the first day of a failed payment", () => {
    const result = Billing.evaluateAccess(
      { status: STATUS.PAST_DUE, past_due_since: new Date(NOW.getTime() - 1 * DAY) },
      NOW
    );
    expect(result.access).toBe(ACCESS.WARNING);
    expect(result.reason).toBe("in_grace_period");
    expect(result.graceDaysRemaining).toBe(6);
  });

  it("still allows access on the final day of the grace period", () => {
    const result = Billing.evaluateAccess(
      {
        status: STATUS.PAST_DUE,
        past_due_since: new Date(NOW.getTime() - 6.9 * DAY),
      },
      NOW
    );
    expect(result.access).toBe(ACCESS.WARNING);
  });

  it("restricts once the grace period has expired", () => {
    const result = Billing.evaluateAccess(
      { status: STATUS.PAST_DUE, past_due_since: new Date(NOW.getTime() - 8 * DAY) },
      NOW
    );
    expect(result.access).toBe(ACCESS.RESTRICTED);
    expect(result.reason).toBe("grace_period_expired");
  });

  it("honours a configurable grace period", () => {
    const loaded = loadBilling({ BILLING_GRACE_PERIOD_DAYS: "30" });
    const result = loaded.Billing.evaluateAccess(
      { status: "past_due", past_due_since: new Date(NOW.getTime() - 8 * DAY) },
      NOW
    );
    expect(result.access).toBe("warning");
    loaded.restore();
  });

  it("keeps service until the paid period ends after cancellation", () => {
    const result = Billing.evaluateAccess(
      {
        status: STATUS.CANCELED,
        current_period_end: new Date(NOW.getTime() + 5 * DAY),
      },
      NOW
    );
    expect(result.access).toBe(ACCESS.WARNING);
    expect(result.reason).toBe("canceled_pending_period_end");
  });

  it("restricts after a cancelled period has elapsed", () => {
    const result = Billing.evaluateAccess(
      {
        status: STATUS.CANCELED,
        current_period_end: new Date(NOW.getTime() - 1 * DAY),
      },
      NOW
    );
    expect(result.access).toBe(ACCESS.RESTRICTED);
  });

  it("warns when a cancellation is scheduled but service is still active", () => {
    const result = Billing.evaluateAccess(
      { status: STATUS.ACTIVE, cancel_at_period_end: true },
      NOW
    );
    expect(result.access).toBe(ACCESS.WARNING);
    expect(result.reason).toBe("cancel_at_period_end");
  });

  it("treats payment_action_required as a warning inside the grace period", () => {
    const result = Billing.evaluateAccess(
      {
        status: STATUS.PAYMENT_ACTION_REQUIRED,
        past_due_since: new Date(NOW.getTime() - 2 * DAY),
      },
      NOW
    );
    expect(result.access).toBe(ACCESS.WARNING);
  });

  it("never restricts a deployment whose billing was never configured", () => {
    const result = Billing.evaluateAccess({ status: STATUS.UNCONFIGURED }, NOW);
    expect(result.access).toBe(ACCESS.OK);
  });

  it("never restricts when enforcement is disabled, even when unpaid", () => {
    const loaded = loadBilling({ BILLING_ENFORCEMENT_ENABLED: "false" });
    const result = loaded.Billing.evaluateAccess(
      { status: "unpaid", past_due_since: new Date(NOW.getTime() - 90 * DAY) },
      NOW
    );
    expect(result.access).toBe("ok");
    loaded.restore();
  });
});

describe("Billing.mapStripeStatus", () => {
  it("maps every Stripe subscription status we can receive", () => {
    const { Billing, STATUS } = loadBilling();
    expect(Billing.mapStripeStatus("active")).toBe(STATUS.ACTIVE);
    expect(Billing.mapStripeStatus("past_due")).toBe(STATUS.PAST_DUE);
    expect(Billing.mapStripeStatus("unpaid")).toBe(STATUS.UNPAID);
    expect(Billing.mapStripeStatus("canceled")).toBe(STATUS.CANCELED);
    expect(Billing.mapStripeStatus("incomplete")).toBe(STATUS.INCOMPLETE);
    expect(Billing.mapStripeStatus("incomplete_expired")).toBe(
      STATUS.INCOMPLETE_EXPIRED
    );
    expect(Billing.mapStripeStatus("trialing")).toBe(STATUS.TRIALING);
    expect(Billing.mapStripeStatus("paused")).toBe(STATUS.PAUSED);
  });

  it("falls back safely for an unknown status", () => {
    const { Billing, STATUS } = loadBilling();
    expect(Billing.mapStripeStatus("something_new")).toBe(STATUS.UNCONFIGURED);
  });
});

describe("commercial plan definition", () => {
  it("is fixed at $3,888.88 per month in USD", () => {
    jest.resetModules();
    const config = require("../../business/config");
    expect(config.PLAN.amountCents).toBe(388888);
    expect(config.PLAN.currency).toBe("usd");
    expect(config.PLAN.interval).toBe("month");
    expect(config.PLAN.displayPrice).toBe("$3,888.88");
  });
});
