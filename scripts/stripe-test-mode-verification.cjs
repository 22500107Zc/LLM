#!/usr/bin/env node
/**
 * Stripe TEST-MODE end-to-end verification.
 *
 * Exercises the full commercial billing lifecycle against Stripe's test mode:
 * Checkout creation, signed webhook receipt, subscription activation, a failed
 * payment entering the grace state, restriction after the grace period,
 * recovery after payment, cancellation at period end, and replay protection.
 *
 * SAFETY
 *   - Refuses to run against a live key. Test mode only, always.
 *   - Creates no real charge: Stripe test mode uses test cards and no money
 *     moves.
 *   - Mutates the target deployment's billing state, so it must be pointed at
 *     a disposable deployment.
 *
 * REQUIREMENTS
 *   STRIPE_SECRET_KEY      a sk_test_... key
 *   STRIPE_WEBHOOK_SECRET  the whsec_... for the endpoint under test
 *   STRIPE_PRICE_ID        a recurring price matching PLAN_AMOUNT_CENTS
 *   BASE_URL               the deployment under test (default localhost:3001)
 *   TEST_USER / TEST_PASSWORD  an owner account on that deployment
 *
 * Without them the script exits reporting
 *   BLOCKED: STRIPE TEST CREDENTIALS REQUIRED
 * and verifies nothing.
 *
 *   BASE_URL=http://localhost:3001 \
 *   STRIPE_SECRET_KEY=sk_test_... STRIPE_WEBHOOK_SECRET=whsec_... \
 *   STRIPE_PRICE_ID=price_... TEST_USER=owner TEST_PASSWORD=... \
 *     node scripts/stripe-test-mode-verification.cjs
 */

const crypto = require("crypto");
const {
  SERVER_DIR,
  assertSafeTarget,
  Results,
  apiClient,
  path,
} = require("./lib/harness.cjs");

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3001";
assertSafeTarget(BASE_URL, { suiteName: "The Stripe verification suite" });

const SECRET = process.env.STRIPE_SECRET_KEY ?? "";
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";
const PRICE_ID = process.env.STRIPE_PRICE_ID ?? "";
const PLAN_AMOUNT_CENTS = Number(process.env.PLAN_AMOUNT_CENTS ?? 388888);

const api = apiClient(BASE_URL);
const results = new Results("STRIPE TEST-MODE VERIFICATION");
const call = (p, o) => api.call(p, o);

(async () => {
  try {
    await run();
  } catch (error) {
    console.error(`\n\x1b[31mSuite aborted: ${error.message}\x1b[0m`);
    results.record("Suite completed without crashing", false, error.message);
  }
  results.finish();
})();

async function run() {
  results.section("PRECONDITIONS");

  // A live key must never be used here, whatever else is set.
  if (SECRET.startsWith("sk_live_")) {
    console.error(
      "\n\x1b[31mRefusing to run: STRIPE_SECRET_KEY is a LIVE key. This suite is test mode only.\x1b[0m\n"
    );
    process.exit(2);
  }

  const missing = [
    !SECRET && "STRIPE_SECRET_KEY",
    !WEBHOOK_SECRET && "STRIPE_WEBHOOK_SECRET",
    !PRICE_ID && "STRIPE_PRICE_ID",
  ].filter(Boolean);

  if (missing.length) {
    console.log(
      [
        "",
        "\x1b[33m================================================================\x1b[0m",
        "\x1b[33m  BLOCKED: STRIPE TEST CREDENTIALS REQUIRED\x1b[0m",
        "",
        `  Missing: ${missing.join(", ")}`,
        "",
        "  Supply Stripe TEST-mode credentials and re-run:",
        "",
        "    BASE_URL=" + BASE_URL + " \\",
        "    STRIPE_SECRET_KEY=sk_test_... STRIPE_WEBHOOK_SECRET=whsec_... \\",
        "    STRIPE_PRICE_ID=price_... TEST_USER=owner TEST_PASSWORD=... \\",
        "      node scripts/stripe-test-mode-verification.cjs",
        "\x1b[33m================================================================\x1b[0m",
        "",
      ].join("\n")
    );
    results.blocked(
      "Stripe test-mode lifecycle verification",
      `STRIPE TEST CREDENTIALS REQUIRED (missing ${missing.join(", ")})`
    );
    return;
  }

  results.record("Using a Stripe TEST key (never live)", SECRET.startsWith("sk_test_"));

  const Stripe = require(path.join(SERVER_DIR, "node_modules", "stripe"));
  const stripe = new Stripe(SECRET, { apiVersion: process.env.STRIPE_API_VERSION });

  const token = await login();
  if (!token) return;
  api.setToken(token);

  results.section("PRICE VALIDATION");

  const price = await stripe.prices.retrieve(PRICE_ID);
  results.record(
    "The configured price matches the commercial amount",
    price.unit_amount === PLAN_AMOUNT_CENTS &&
      price.recurring?.interval === "month" &&
      price.active === true,
    `${price.unit_amount} ${price.currency} / ${price.recurring?.interval}`
  );

  const verify = await call("/business/billing/verify-price");
  results.record(
    "The deployment agrees the price is correct",
    verify.json?.verified === true,
    verify.json?.reason ?? ""
  );

  results.section("CHECKOUT CREATION");

  const checkout = await call("/business/billing/checkout", {
    method: "POST",
    body: { email: `stripe-verify-${Date.now()}@example.invalid`, name: "Stripe Verification" },
  });
  results.record(
    "Checkout session created",
    checkout.json?.success === true && !!checkout.json?.url,
    checkout.json?.error ?? checkout.json?.sessionId
  );
  const sessionId = checkout.json?.sessionId;
  if (!sessionId) return;

  const session = await stripe.checkout.sessions.retrieve(sessionId);
  results.record(
    "The session carries this deployment's identity",
    !!session.metadata?.deployment_id,
    "deployment_id present in metadata"
  );
  const customerId =
    typeof session.customer === "string" ? session.customer : session.customer?.id;
  results.record("The session is bound to a customer", !!customerId, customerId);

  results.section("WEBHOOK SIGNATURE AND BINDING");

  const post = (body, header) =>
    fetch(`${BASE_URL}/api/billing/stripe/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(header ? { "stripe-signature": header } : {}) },
      body,
    });

  const sign = (payload, timestamp = Math.floor(Date.now() / 1000)) => {
    const signature = crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(`${timestamp}.${payload}`)
      .digest("hex");
    return `t=${timestamp},v1=${signature}`;
  };

  const completed = event("checkout.session.completed", {
    id: sessionId,
    object: "checkout_session",
    mode: "subscription",
    customer: customerId,
    metadata: session.metadata,
    customer_details: { email: session.customer_email },
  });

  results.record("Unsigned webhook is rejected", (await post(completed, null)).status === 400);
  results.record(
    "Wrongly signed webhook is rejected",
    (await post(completed, "t=1,v1=deadbeef")).status === 400
  );
  const tampered = completed.replace(sessionId, "cs_tampered_0000");
  results.record(
    "Tampered body is rejected",
    (await post(tampered, sign(completed))).status === 400
  );

  const first = await post(completed, sign(completed));
  results.record("Correctly signed checkout is accepted", first.status === 200);

  const replay = await post(completed, sign(completed));
  const replayBody = await replay.json().catch(() => ({}));
  results.record("Replayed event is ignored", replayBody?.duplicate === true);

  const summaryAfterBind = await call("/business/billing/summary");
  results.record(
    "The deployment bound to the checkout's customer",
    summaryAfterBind.json?.subscription?.customerId === customerId,
    summaryAfterBind.json?.subscription?.customerId
  );

  results.section("FOREIGN EVENT REJECTION");

  const foreign = event("invoice.paid", {
    id: "in_foreign_0001",
    object: "invoice",
    customer: "cus_someoneelse00001",
    amount_paid: PLAN_AMOUNT_CENTS,
    currency: "usd",
    status: "paid",
  });
  await post(foreign, sign(foreign));
  const afterForeign = await call("/business/billing/summary");
  results.record(
    "An event for another customer does not change our state",
    afterForeign.json?.subscription?.customerId === customerId
  );

  results.section("SUBSCRIPTION LIFECYCLE");

  // Drive the lifecycle through signed webhooks so the deployment's state
  // machine is exercised exactly as Stripe would drive it.
  const periodEnd = Math.floor(Date.now() / 1000) + 30 * 86_400;
  const subscriptionId = `sub_verify_${Date.now()}`;

  const activated = event("customer.subscription.updated", {
    id: subscriptionId,
    object: "subscription",
    customer: customerId,
    status: "active",
    current_period_end: periodEnd,
    cancel_at_period_end: false,
    items: { data: [{ price: { id: PRICE_ID, unit_amount: PLAN_AMOUNT_CENTS, currency: "usd", recurring: { interval: "month" } } }] },
  });
  await post(activated, sign(activated));
  let state = await call("/business/billing/summary");
  results.record(
    "Successful payment sets the subscription active",
    ["active", "trialing"].includes(state.json?.subscription?.status),
    state.json?.subscription?.statusLabel
  );

  const failed = event("invoice.payment_failed", {
    id: "in_verify_failed",
    object: "invoice",
    customer: customerId,
    amount_due: PLAN_AMOUNT_CENTS,
    attempt_count: 1,
    status: "open",
  });
  await post(failed, sign(failed));
  state = await call("/business/billing/summary");
  results.record(
    "invoice.payment_failed moves the deployment into the grace state",
    state.json?.subscription?.status === "past_due",
    `${state.json?.subscription?.statusLabel} · access=${state.json?.access?.access}`
  );
  results.record(
    "Service continues during the grace period",
    state.json?.access?.access !== "restricted",
    `access=${state.json?.access?.access}`
  );

  const paid = event("invoice.paid", {
    id: "in_verify_paid",
    object: "invoice",
    customer: customerId,
    amount_paid: PLAN_AMOUNT_CENTS,
    currency: "usd",
    status: "paid",
  });
  await post(paid, sign(paid));
  state = await call("/business/billing/summary");
  results.record(
    "invoice.paid restores service",
    state.json?.access?.access === "ok",
    state.json?.subscription?.statusLabel
  );

  const canceling = event("customer.subscription.updated", {
    id: subscriptionId,
    object: "subscription",
    customer: customerId,
    status: "active",
    current_period_end: periodEnd,
    cancel_at_period_end: true,
    items: { data: [{ price: { id: PRICE_ID, unit_amount: PLAN_AMOUNT_CENTS, currency: "usd", recurring: { interval: "month" } } }] },
  });
  await post(canceling, sign(canceling));
  state = await call("/business/billing/summary");
  results.record(
    "Cancellation at period end keeps service until the paid period ends",
    state.json?.subscription?.cancelAtPeriodEnd === true &&
      state.json?.access?.access !== "restricted",
    `access=${state.json?.access?.access}`
  );

  results.section("RESTRICTION AFTER THE GRACE PERIOD");
  results.blocked(
    "Post-grace restriction (time dependent)",
    "Restriction begins after BILLING_GRACE_PERIOD_DAYS. The state machine is covered deterministically by server/__tests__/business/billing.test.js and enforcement.test.js; driving real elapsed time is out of scope for this script."
  );

  function event(type, object) {
    return JSON.stringify({
      id: `evt_verify_${crypto.randomBytes(8).toString("hex")}`,
      object: "event",
      type,
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      data: { object },
    });
  }
}

async function login() {
  const username = process.env.TEST_USER;
  const password = process.env.TEST_PASSWORD;
  if (!username || !password) {
    results.blocked(
      "Authentication",
      "Set TEST_USER and TEST_PASSWORD for an owner account on the deployment under test."
    );
    return null;
  }
  const login = await call("/request-token", {
    method: "POST",
    body: { username, password },
    token: null,
  });
  results.record("Authenticated as the owner", !!login.json?.token);
  return login.json?.token ?? null;
}
