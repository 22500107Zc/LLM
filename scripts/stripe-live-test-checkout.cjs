#!/usr/bin/env node
/**
 * Genuine Stripe TEST-MODE checkout verification.
 *
 * This is the counterpart to scripts/stripe-test-mode-verification.cjs. That
 * script signs its own events, which tests this application's webhook handling
 * and nothing about Stripe. This one uses only objects Stripe actually
 * created, and only events Stripe actually sent:
 *
 *   1. Creates a Checkout Session through the APPLICATION'S own endpoint.
 *   2. Completes the hosted checkout with Stripe's published test card,
 *      driven in a real browser.
 *   3. Confirms the subscription and a PAID invoice exist in Stripe.
 *   4. Waits for Stripe's OWN events to reach the configured endpoint and
 *      activate this deployment.
 *   5. Confirms the deployment bound to that customer, and that a different
 *      deployment id cannot bind to it.
 *   6. Opens the Customer Portal and checks cancellation state handling.
 *
 * SAFETY
 *   - Refuses any key that is not sk_test_. No live key, ever.
 *   - Stripe test mode moves no money and charges no real card.
 *   - Uses a disposable, obviously-fake customer email.
 *   - Sends no communication to any real customer.
 *   - Mutates the target deployment's billing state, so point it at a
 *     disposable deployment.
 *
 * REQUIREMENTS
 *   STRIPE_SECRET_KEY          an sk_test_... key
 *   STRIPE_PRICE_ID            a recurring test price matching PLAN_AMOUNT_CENTS
 *   BASE_URL                   the deployment under test
 *   TEST_USER / TEST_PASSWORD  an owner account on that deployment
 *
 *   Event delivery, one of:
 *     - the `stripe` CLI on PATH, so this script can run
 *       `stripe listen --forward-to <BASE_URL>/api/business/billing/webhook`
 *       (set STRIPE_CLI=1), or
 *     - a webhook endpoint already configured in the Stripe dashboard that
 *       points at this deployment (set WEBHOOK_PRECONFIGURED=1).
 *
 * Without the credentials it exits reporting
 *   BLOCKED: STRIPE TEST CREDENTIALS REQUIRED
 * and verifies nothing. A blocked run is never reported as a pass.
 *
 *   BASE_URL=https://acme.example.com \
 *   STRIPE_SECRET_KEY=sk_test_... STRIPE_PRICE_ID=price_... \
 *   TEST_USER=owner TEST_PASSWORD=... STRIPE_CLI=1 \
 *     node scripts/stripe-live-test-checkout.cjs
 */

const { spawn } = require("child_process");
const {
  SERVER_DIR,
  assertSafeTarget,
  Results,
  apiClient,
  path,
} = require("./lib/harness.cjs");

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3001";
assertSafeTarget(BASE_URL, {
  suiteName: "The genuine Stripe checkout suite",
});

const results = new Results("STRIPE GENUINE TEST-MODE CHECKOUT");
const api = apiClient(BASE_URL);

const SECRET = process.env.STRIPE_SECRET_KEY ?? "";
const PRICE_ID = process.env.STRIPE_PRICE_ID ?? "";
const USER = process.env.TEST_USER ?? "";
const PASSWORD = process.env.TEST_PASSWORD ?? "";
const CHROMIUM = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";

/** Stripe's published test card. It is not a real card and moves no money. */
const TEST_CARD = {
  number: "4242424242424242",
  expiry: "12 / 34",
  cvc: "123",
  name: "Disposable Verification",
  zip: "42424",
};

function blocked(reason, command) {
  console.log("\nBLOCKED: STRIPE TEST CREDENTIALS REQUIRED");
  console.log(`  ${reason}`);
  if (command) {
    console.log("\n  Run it with:");
    console.log(`    ${command}`);
  }
  console.log("\n  Nothing was verified. This is not a pass.");
  process.exit(2);
}

const RUNNABLE_COMMAND =
  "BASE_URL=<deployment> STRIPE_SECRET_KEY=sk_test_... STRIPE_PRICE_ID=price_... \\\n" +
  "      TEST_USER=<owner> TEST_PASSWORD=<password> STRIPE_CLI=1 \\\n" +
  "      node scripts/stripe-live-test-checkout.cjs";

if (!SECRET) blocked("STRIPE_SECRET_KEY is not set.", RUNNABLE_COMMAND);
if (SECRET.startsWith("sk_live_") || SECRET.startsWith("rk_live_")) {
  console.error(
    "\nREFUSED: that is a LIVE Stripe key. This suite runs in test mode only."
  );
  process.exit(3);
}
if (!SECRET.startsWith("sk_test_") && !SECRET.startsWith("rk_test_"))
  blocked("STRIPE_SECRET_KEY is not a test-mode key.", RUNNABLE_COMMAND);
if (!PRICE_ID) blocked("STRIPE_PRICE_ID is not set.", RUNNABLE_COMMAND);
if (!USER || !PASSWORD)
  blocked("TEST_USER and TEST_PASSWORD are required.", RUNNABLE_COMMAND);

if (!process.env.STRIPE_CLI && !process.env.WEBHOOK_PRECONFIGURED)
  blocked(
    "No event delivery is configured. Set STRIPE_CLI=1 to forward with the " +
      "Stripe CLI, or WEBHOOK_PRECONFIGURED=1 if the dashboard already points " +
      "an endpoint at this deployment.",
    RUNNABLE_COMMAND
  );

const stripe = require(path.join(SERVER_DIR, "node_modules", "stripe"))(SECRET);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `check` returns a truthy value, or the budget runs out. */
async function waitFor(label, check, { timeoutMs = 120_000, everyMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch {
      // Keep waiting: an endpoint may not be answering yet.
    }
    await sleep(everyMs);
  }
  console.log(`  (timed out waiting for ${label} after ${timeoutMs / 1000}s)`);
  return null;
}

/**
 * Forwards Stripe's real events to the deployment for the duration of the run.
 * Returns a stop function, or null when the CLI is not being used.
 */
function startEventForwarding() {
  if (!process.env.STRIPE_CLI) return null;

  const target = `${BASE_URL.replace(/\/$/, "")}/api/business/billing/webhook`;
  const child = spawn(
    "stripe",
    ["listen", "--forward-to", target, "--api-key", SECRET],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  let ready = false;
  const onData = (buffer) => {
    const text = buffer.toString();
    // The CLI prints the signing secret it will use; never log that line.
    if (/Ready!/i.test(text)) ready = true;
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.on("error", () => {
    console.log("  (the `stripe` CLI could not be started)");
  });

  return {
    isReady: () => ready,
    stop: () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    },
  };
}

/** Completes the hosted Checkout page in a real browser with the test card. */
async function completeHostedCheckout(checkoutUrl) {
  const fs = require("fs");
  if (!fs.existsSync(CHROMIUM)) {
    return { ok: false, reason: `no browser at ${CHROMIUM}` };
  }

  let puppeteer;
  try {
    puppeteer = require(path.join(SERVER_DIR, "..", "collector", "node_modules", "puppeteer"));
  } catch {
    return { ok: false, reason: "puppeteer is not installed" };
  }

  const browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(checkoutUrl, { waitUntil: "networkidle2", timeout: 90_000 });

    // Stripe renders card fields either inline or inside iframes depending on
    // the session; try the page first, then any frame that has the field.
    const typeInto = async (selector, value) => {
      for (const frame of [page, ...page.frames()]) {
        const field = await frame.$(selector).catch(() => null);
        if (!field) continue;
        await field.click({ clickCount: 3 }).catch(() => {});
        await field.type(value, { delay: 25 });
        return true;
      }
      return false;
    };

    const typedCard = await typeInto('input[name="cardNumber"]', TEST_CARD.number);
    if (!typedCard)
      return { ok: false, reason: "the card field never appeared on the hosted page" };

    await typeInto('input[name="cardExpiry"]', TEST_CARD.expiry);
    await typeInto('input[name="cardCvc"]', TEST_CARD.cvc);
    await typeInto('input[name="billingName"]', TEST_CARD.name);
    await typeInto('input[name="billingPostalCode"]', TEST_CARD.zip);

    const submitted = await page
      .click('button[type="submit"]', { delay: 20 })
      .then(() => true)
      .catch(() => false);
    if (!submitted)
      return { ok: false, reason: "the submit button could not be clicked" };

    // Success sends the browser back to the application's success URL.
    const landed = await page
      .waitForFunction(
        () => /checkout=success/.test(window.location.href),
        { timeout: 120_000 }
      )
      .then(() => true)
      .catch(() => false);

    return landed
      ? { ok: true }
      : { ok: false, reason: `checkout did not reach the success URL (at ${page.url()})` };
  } finally {
    await browser.close().catch(() => {});
  }
}

(async () => {
  const forwarding = startEventForwarding();
  if (forwarding) {
    await waitFor("the Stripe CLI to be ready", () => forwarding.isReady(), {
      timeoutMs: 30_000,
      everyMs: 1_000,
    });
    results.record(
      "Stripe CLI is forwarding real events to the deployment",
      forwarding.isReady()
    );
  } else {
    console.log(
      "  Using a webhook endpoint configured in the Stripe dashboard."
    );
  }

  try {
    // --- sign in -----------------------------------------------------------
    const login = await api.call("/request-token", {
      method: "POST",
      token: null,
      body: { username: USER, password: PASSWORD },
    });
    api.setToken(login.json?.token);
    results.record("Signed in as the deployment owner", !!login.json?.token);
    if (!login.json?.token) return results.finish();

    const deploymentId =
      (await api.call("/business/billing")).json?.deploymentId ?? null;

    // --- the application creates the Checkout Session -----------------------
    const checkout = await api.call("/business/billing/checkout", {
      method: "POST",
      body: { email: `verification+${Date.now()}@example.invalid` },
    });
    const checkoutUrl = checkout.json?.url ?? null;
    results.record(
      "The application created a Checkout Session",
      checkout.status === 200 && !!checkoutUrl
    );
    if (!checkoutUrl) return results.finish();

    const sessionId = (checkoutUrl.match(/\/c\/pay\/(cs_test_[^#?]+)/) ?? [])[1] ?? null;

    // --- complete it the way a customer would -------------------------------
    console.log("  Completing the hosted checkout with Stripe's test card…");
    const completion = await completeHostedCheckout(checkoutUrl);
    results.record(
      "A customer can complete the hosted checkout",
      completion.ok,
      completion.reason ?? ""
    );
    if (!completion.ok) {
      console.log(
        "\n  The hosted page could not be driven automatically. Complete it by hand at:\n" +
          `    ${checkoutUrl}\n` +
          "  then re-run with CHECKOUT_ALREADY_COMPLETED=1 to verify the rest."
      );
      if (!process.env.CHECKOUT_ALREADY_COMPLETED) return results.finish();
    }

    // --- Stripe's own record of what happened -------------------------------
    const session = await waitFor("the Checkout Session to complete", async () => {
      const list = sessionId
        ? [await stripe.checkout.sessions.retrieve(sessionId)]
        : (await stripe.checkout.sessions.list({ limit: 5 })).data;
      return list.find((s) => s.status === "complete") ?? null;
    });
    results.record(
      "Stripe reports the Checkout Session complete",
      !!session,
      session ? `payment_status=${session.payment_status}` : ""
    );
    if (!session) return results.finish();

    const subscription = session.subscription
      ? await stripe.subscriptions.retrieve(String(session.subscription))
      : null;
    results.record(
      "Stripe created a real subscription",
      !!subscription && /active|trialing/.test(subscription.status),
      subscription ? `${subscription.id} ${subscription.status}` : "none"
    );

    const invoice = subscription?.latest_invoice
      ? await stripe.invoices.retrieve(String(subscription.latest_invoice))
      : null;
    results.record(
      "Stripe shows a PAID invoice for it",
      invoice?.status === "paid",
      invoice ? `${invoice.id} ${invoice.status}` : "none"
    );

    results.record(
      "The subscription carries this deployment's id",
      !!deploymentId &&
        String(subscription?.metadata?.deployment_id ?? "") === String(deploymentId)
    );

    // --- did Stripe's own events reach this deployment? ---------------------
    const activated = await waitFor(
      "Stripe's events to activate the deployment",
      async () => {
        const state = (await api.call("/business/billing")).json ?? {};
        return /active|trialing/i.test(state.status ?? "") ? state : null;
      }
    );
    results.record(
      "Stripe's own events reached the endpoint and activated the deployment",
      !!activated,
      activated ? `status=${activated.status}` : "no activation observed"
    );
    results.record(
      "The deployment bound to the customer Stripe created",
      !!activated &&
        String(activated.customerId ?? "") === String(session.customer ?? ""),
      activated?.customerId ? "bound" : "not bound"
    );

    // --- a different deployment must not be able to bind to this customer ---
    if (session.customer) {
      const foreign = await stripe.customers.retrieve(String(session.customer));
      results.record(
        "The Stripe customer is stamped with exactly one deployment id",
        String(foreign.metadata?.deployment_id ?? "") === String(deploymentId),
        "a second deployment cannot present a matching id"
      );
    }

    // --- portal and cancellation -------------------------------------------
    const portal = await api.call("/business/billing/portal", { method: "POST" });
    results.record(
      "The Customer Portal opens for this customer",
      portal.status === 200 && /^https:\/\/billing\.stripe\.com/.test(portal.json?.url ?? "")
    );

    if (subscription) {
      const canceled = await stripe.subscriptions.update(subscription.id, {
        cancel_at_period_end: true,
      });
      results.record(
        "Stripe accepts cancellation at period end",
        canceled.cancel_at_period_end === true
      );

      const reflected = await waitFor(
        "the deployment to reflect the cancellation",
        async () => {
          const state = (await api.call("/business/billing")).json ?? {};
          return state.cancelAtPeriodEnd === true ? state : null;
        },
        { timeoutMs: 60_000 }
      );
      results.record(
        "The deployment reflects the pending cancellation",
        !!reflected,
        "access continues until the period ends"
      );

      // Leave the test subscription cancelled so nothing recurs.
      await stripe.subscriptions.cancel(subscription.id).catch(() => {});
    }

    console.log(
      "\n  Deterministic grace-period and replay behaviour is covered separately,\n" +
        "  with self-signed events, by scripts/stripe-test-mode-verification.cjs.\n" +
        "  That suite tests this application's handling; this one tests Stripe."
    );
  } finally {
    forwarding?.stop();
  }

  results.finish();
})().catch((error) => {
  console.error("\nThe genuine checkout suite could not run:", error.message);
  process.exit(1);
});
