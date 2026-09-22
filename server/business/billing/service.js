const config = require("../config");
const { client, isConfigured } = require("./stripe");
const { Billing, STATUS } = require("../models/billing");
const { AuditLog } = require("../models/audit");
const binding = require("./binding");

/**
 * Commercial billing operations.
 *
 * Everything that touches money is delegated to Stripe-hosted surfaces
 * (Checkout, Customer Portal, Invoicing). We never render a card form and we
 * never persist a payment instrument.
 */

const PLAN = config.PLAN;

function notConfigured() {
  return {
    success: false,
    error:
      "Billing is not configured for this deployment. Contact your platform administrator.",
  };
}

/**
 * Resolves the Price the subscription should use.
 * Prefers the configured STRIPE_PRICE_ID; otherwise looks for a price on the
 * configured product that already matches the commercial amount.
 * @returns {Promise<{priceId: string|null, error: string|null}>}
 */
async function resolvePriceId() {
  if (config.stripe.priceId)
    return { priceId: config.stripe.priceId, error: null };

  const stripe = client();
  if (!stripe) return { priceId: null, error: "Billing is not configured." };
  if (!config.stripe.productId)
    return {
      priceId: null,
      error: "No STRIPE_PRICE_ID or STRIPE_PRODUCT_ID is configured.",
    };

  try {
    const prices = await stripe.prices.list({
      product: config.stripe.productId,
      active: true,
      limit: 100,
    });
    const match = prices.data.find(
      (price) =>
        price.unit_amount === PLAN.amountCents &&
        price.currency === PLAN.currency &&
        price.recurring?.interval === PLAN.interval
    );
    if (!match)
      return {
        priceId: null,
        error: `No active ${PLAN.displayPriceWithInterval} price exists on the configured product.`,
      };
    return { priceId: match.id, error: null };
  } catch (error) {
    console.error("[Billing] price lookup failed:", error.message);
    return {
      priceId: null,
      error: "Unable to resolve the subscription price.",
    };
  }
}

/**
 * Verifies that the configured Stripe price actually matches the commercial
 * model. Surfaced on the billing page so a misconfiguration is visible rather
 * than silently charging the wrong amount.
 */
async function verifyPriceMatchesPlan() {
  const stripe = client();
  if (!stripe || !config.stripe.priceId)
    return { verified: false, reason: "not_configured", price: null };

  try {
    const price = await stripe.prices.retrieve(config.stripe.priceId);
    const matches =
      price.unit_amount === PLAN.amountCents &&
      price.currency === PLAN.currency &&
      price.recurring?.interval === PLAN.interval &&
      price.active === true;
    return {
      verified: matches,
      reason: matches ? null : "price_mismatch",
      price: {
        id: price.id,
        unitAmount: price.unit_amount,
        currency: price.currency,
        interval: price.recurring?.interval ?? null,
        active: price.active,
      },
      expected: {
        unitAmount: PLAN.amountCents,
        currency: PLAN.currency,
        interval: PLAN.interval,
      },
    };
  } catch (error) {
    console.error("[Billing] price verification failed:", error.message);
    return { verified: false, reason: "lookup_failed", price: null };
  }
}

/**
 * Finds or creates the Stripe Customer for this deployment.
 * @param {{email?: string, name?: string}} details
 */
async function ensureCustomer(details = {}) {
  const stripe = client();
  if (!stripe) return { customer: null, error: "Billing is not configured." };

  const record = await Billing.get();
  const existingId = record?.stripe_customer_id || config.stripe.customerId;

  if (existingId) {
    try {
      const customer = await stripe.customers.retrieve(existingId);
      if (!customer.deleted) return { customer, error: null };
    } catch {
      // Fall through and create a fresh customer below.
      console.warn(
        `[Billing] configured customer ${existingId} could not be retrieved; creating a new one.`
      );
    }
  }

  try {
    const customer = await stripe.customers.create({
      email: details.email || record?.billing_email || undefined,
      name: details.name || config.customer.name || undefined,
      metadata: {
        // Stamped so a webhook can prove this object belongs to us.
        deployment_id: config.deploymentId,
        deployment:
          config.customer.domain || config.branding.primaryDomain || "",
        platform: config.branding.appName,
      },
    });
    await Billing.update(
      {
        stripe_customer_id: customer.id,
        billing_email: customer.email ?? null,
      },
      { reason: "customer.created" }
    );
    return { customer, error: null };
  } catch (error) {
    console.error("[Billing] customer creation failed:", error.message);
    return { customer: null, error: "Unable to create the billing customer." };
  }
}

/**
 * The Stripe-hosted Payment Link a customer opens to pay.
 *
 * WHY THIS EXISTS, AND WHY IT MAKES NO STRIPE API CALL
 *
 * Creating a Checkout Session requires an outbound Stripe API call at the
 * exact moment a customer is trying to pay, so a network blip, an expired key
 * or a Stripe incident becomes a failed sale. A hosted Payment Link is a
 * static URL: Stripe hosts the page, and this application's only involvement
 * is receiving the webhook afterwards. Nothing here can fail at purchase time.
 *
 * MATCHING
 *
 * The link carries `client_reference_id` set to this deployment's immutable
 * DEPLOYMENT_ID. Stripe passes it straight through to
 * `checkout.session.completed`, which gives a stable, unguessable match that
 * does not depend on the customer typing the right email at checkout. Email is
 * only ever a convenience prefill, never the thing a binding rests on.
 *
 * @param {{email?: string}} options
 */
/**
 * Builds a deployment-bound Stripe Payment Link from explicit inputs.
 *
 * Kept separate from `paymentLink()` so the founder control plane can build
 * the link for a DIFFERENT deployment - reading that deployment's own
 * configured link and identifier off disk - without a second copy of these
 * rules. One implementation means a link handed out by the console and a link
 * handed out by the customer's own billing page cannot disagree.
 *
 * @param {{configuredLink?: string, deploymentId?: string, email?: string}} input
 */
function buildPaymentLink({
  configuredLink = "",
  deploymentId = "",
  email = "",
} = {}) {
  const configured = String(configuredLink ?? "").trim();
  if (!configured)
    return {
      success: false,
      configured: false,
      error:
        "No Stripe Payment Link is configured for this deployment. Set STRIPE_PAYMENT_LINK.",
    };

  if (!String(deploymentId ?? "").trim())
    return {
      success: false,
      configured: true,
      error:
        "This deployment has no DEPLOYMENT_ID, so a payment could not be matched back to it. Refusing to hand out a payment link.",
    };

  let url;
  try {
    url = new URL(configured);
  } catch {
    return {
      success: false,
      configured: true,
      error: "STRIPE_PAYMENT_LINK is not a valid URL.",
    };
  }

  // Only ever hand out a Stripe-hosted URL. A mistyped or substituted host
  // would send a paying customer somewhere we do not control.
  if (url.protocol !== "https:" || !/(^|\.)stripe\.com$/.test(url.hostname))
    return {
      success: false,
      configured: true,
      error: `STRIPE_PAYMENT_LINK must be an https Stripe-hosted URL. Got host "${url.hostname}".`,
    };

  // The stable matching key. Stripe returns it verbatim on the completed
  // session, so the webhook can bind without guessing.
  url.searchParams.set("client_reference_id", String(deploymentId).trim());

  const prefill = String(email ?? "").trim();
  // Convenience only: it prefills the checkout form. Matching never uses it.
  if (prefill) url.searchParams.set("prefilled_email", prefill);

  return {
    success: true,
    configured: true,
    url: url.toString(),
    // Callers may show this so an operator can confirm the right link is live.
    plan: {
      displayPrice: PLAN.displayPriceWithInterval,
      amountCents: PLAN.amountCents,
    },
  };
}

/** The Payment Link for THIS deployment, from its own configuration. */
function paymentLink(options = {}) {
  return buildPaymentLink({
    configuredLink: config.stripe.paymentLink,
    deploymentId: config.deploymentId,
    email: options.email,
  });
}

/** Whether this deployment is set up to take payment without an API call. */
function paymentLinkConfigured() {
  return paymentLink().configured === true;
}

/**
 * Creates a Stripe-hosted Checkout Session for the fixed commercial plan.
 * @param {{successUrl: string, cancelUrl: string, email?: string, name?: string, actor?: object}} options
 */
async function createCheckoutSession(options = {}) {
  if (!isConfigured()) return notConfigured();
  if (!config.deploymentId)
    return {
      success: false,
      error:
        "This deployment has no DEPLOYMENT_ID configured, so it cannot safely be bound to a Stripe customer.",
    };
  const stripe = client();

  const { priceId, error: priceError } = await resolvePriceId();
  if (!priceId) return { success: false, error: priceError };

  // Charging the wrong amount is worse than not charging at all: refuse rather
  // than silently bill something other than the configured commercial price.
  const priceCheck = await verifyPriceMatchesPlan();
  if (priceCheck.reason === "price_mismatch")
    return {
      success: false,
      error: `The configured Stripe price does not match ${PLAN.displayPriceWithInterval}. Checkout is blocked until it is corrected.`,
      priceCheck,
    };

  const { customer, error: customerError } = await ensureCustomer({
    email: options.email,
    name: options.name,
  });
  if (!customer) return { success: false, error: customerError };

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customer.id,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: options.successUrl,
      cancel_url: options.cancelUrl,
      billing_address_collection: "required",
      // B2B buyers routinely need this on the invoice.
      tax_id_collection: { enabled: true },
      allow_promotion_codes: false,
      subscription_data: {
        metadata: {
          platform: config.branding.appName,
          deployment_id: config.deploymentId,
          deployment: config.customer.domain || "",
        },
      },
      metadata: {
        platform: config.branding.appName,
        plan: PLAN.name,
        deployment_id: config.deploymentId,
        deployment: config.customer.domain || "",
      },
    });

    // Recorded BEFORE the owner is redirected: an unbound deployment accepts a
    // binding only from a Checkout Session it can find in this table.
    await binding.recordPendingCheckout({
      sessionId: session.id,
      expectedCustomer: customer.id,
      priceId,
    });

    await AuditLog.log({
      action: "billing.checkout_session_created",
      category: AuditLog.CATEGORIES.BILLING,
      actor: options.actor ?? null,
      resource: "checkout_session",
      resourceId: session.id,
      metadata: { priceId, customerId: customer.id },
    });

    return { success: true, url: session.url, sessionId: session.id };
  } catch (error) {
    console.error("[Billing] checkout session failed:", error.message);
    return { success: false, error: "Unable to start checkout." };
  }
}

/**
 * Creates a `send_invoice` subscription for B2B customers who are invoiced
 * rather than charged a card. This is the Stripe-native recurring invoice
 * workflow - no custom billing engine.
 * @param {{email: string, name?: string, daysUntilDue?: number, actor?: object}} options
 */
async function createInvoicedSubscription(options = {}) {
  if (!isConfigured()) return notConfigured();
  const stripe = client();

  const { priceId, error: priceError } = await resolvePriceId();
  if (!priceId) return { success: false, error: priceError };

  const { customer, error: customerError } = await ensureCustomer({
    email: options.email,
    name: options.name,
  });
  if (!customer) return { success: false, error: customerError };

  try {
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceId, quantity: 1 }],
      collection_method: "send_invoice",
      days_until_due: Math.max(1, Number(options.daysUntilDue) || 30),
      metadata: {
        platform: config.branding.appName,
        deployment_id: config.deploymentId,
        deployment: config.customer.domain || "",
      },
      expand: ["latest_invoice"],
    });

    // This deployment created the subscription directly, so binding here is
    // safe and does not depend on an inbound event arriving first.
    await binding.bindCustomer({
      customerId: customer.id,
      via: "invoiced_subscription",
    });
    await Billing.applySubscription(subscription, {
      reason: "invoice.subscription",
    });
    await AuditLog.log({
      action: "billing.invoiced_subscription_created",
      category: AuditLog.CATEGORIES.BILLING,
      actor: options.actor ?? null,
      resource: "subscription",
      resourceId: subscription.id,
      metadata: {
        priceId,
        customerId: customer.id,
        collectionMethod: "send_invoice",
      },
    });

    const invoice = subscription.latest_invoice;
    return {
      success: true,
      subscriptionId: subscription.id,
      invoiceId: typeof invoice === "string" ? invoice : invoice?.id ?? null,
      invoiceUrl:
        typeof invoice === "object"
          ? invoice?.hosted_invoice_url ?? null
          : null,
    };
  } catch (error) {
    console.error("[Billing] invoiced subscription failed:", error.message);
    return {
      success: false,
      error: "Unable to create the invoiced subscription.",
    };
  }
}

/**
 * Creates a Stripe Customer Portal session so the owner can manage payment
 * methods, view invoices and cancel - all on Stripe's hosted surface.
 */
async function createPortalSession({ returnUrl, actor = null } = {}) {
  if (!isConfigured()) return notConfigured();
  const stripe = client();

  const record = await Billing.get();
  const customerId = record?.stripe_customer_id || config.stripe.customerId;
  if (!customerId)
    return {
      success: false,
      error: "No billing customer is associated with this deployment yet.",
    };

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
      ...(config.stripe.portalConfigurationId
        ? { configuration: config.stripe.portalConfigurationId }
        : {}),
    });

    await AuditLog.log({
      action: "billing.portal_session_created",
      category: AuditLog.CATEGORIES.BILLING,
      actor,
      resource: "billing_portal",
      resourceId: customerId,
    });

    return { success: true, url: session.url };
  } catch (error) {
    console.error("[Billing] portal session failed:", error.message);
    return {
      success: false,
      error:
        "Unable to open the billing portal. Confirm the Customer Portal is enabled in Stripe.",
    };
  }
}

/**
 * Pulls the authoritative state from Stripe. Used on demand from the billing
 * page and by the operator CLI, so a missed webhook can always be reconciled.
 */
async function syncFromStripe({ actor = null } = {}) {
  if (!isConfigured()) return notConfigured();
  const stripe = client();

  const record = await Billing.get();
  const subscriptionId =
    record?.stripe_subscription_id || config.stripe.subscriptionId;
  const customerId = record?.stripe_customer_id || config.stripe.customerId;

  try {
    let subscription = null;

    if (subscriptionId) {
      subscription = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ["items.data.price", "latest_invoice"],
      });
    } else if (customerId) {
      const list = await stripe.subscriptions.list({
        customer: customerId,
        status: "all",
        limit: 10,
        expand: ["data.items.data.price"],
      });
      // Prefer a live subscription over a dead one.
      subscription =
        list.data.find((s) =>
          ["active", "trialing", "past_due", "unpaid"].includes(s.status)
        ) ??
        list.data[0] ??
        null;
    }

    if (!subscription)
      return {
        success: false,
        error: "No Stripe subscription is associated with this deployment yet.",
      };

    await Billing.applySubscription(subscription, { reason: "manual.sync" });

    const invoice = subscription.latest_invoice;
    if (invoice && typeof invoice === "object") {
      await Billing.update(
        {
          latest_invoice_id: invoice.id,
          latest_invoice_status: invoice.status ?? null,
          latest_invoice_url: invoice.hosted_invoice_url ?? null,
        },
        { reason: "manual.sync" }
      );
    }

    await AuditLog.log({
      action: "billing.synced",
      category: AuditLog.CATEGORIES.BILLING,
      actor,
      resource: "subscription",
      resourceId: subscription.id,
      metadata: { status: subscription.status },
    });

    return {
      success: true,
      status: Billing.mapStripeStatus(subscription.status),
    };
  } catch (error) {
    console.error("[Billing] sync failed:", error.message);
    return {
      success: false,
      error: "Unable to sync billing state from Stripe.",
    };
  }
}

/**
 * Lists recent invoices for the billing page. Read-only, hosted links only.
 */
async function listInvoices({ limit = 12 } = {}) {
  if (!isConfigured())
    return {
      success: false,
      error: "Billing is not configured.",
      invoices: [],
    };
  const stripe = client();

  const record = await Billing.get();
  const customerId = record?.stripe_customer_id || config.stripe.customerId;
  if (!customerId) return { success: true, invoices: [] };

  try {
    const invoices = await stripe.invoices.list({
      customer: customerId,
      limit: Math.min(Number(limit) || 12, 50),
    });
    return {
      success: true,
      invoices: invoices.data.map((invoice) => ({
        id: invoice.id,
        number: invoice.number,
        status: invoice.status,
        amountDue: invoice.amount_due,
        amountPaid: invoice.amount_paid,
        currency: invoice.currency?.toUpperCase() ?? "USD",
        created: invoice.created
          ? new Date(invoice.created * 1000).toISOString()
          : null,
        periodEnd: invoice.period_end
          ? new Date(invoice.period_end * 1000).toISOString()
          : null,
        // Hosted Stripe surfaces only - we never render invoice internals.
        hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
        invoicePdf: invoice.invoice_pdf ?? null,
      })),
    };
  } catch (error) {
    console.error("[Billing] invoice listing failed:", error.message);
    return { success: false, error: "Unable to load invoices.", invoices: [] };
  }
}

/**
 * Cancels the subscription. Defaults to "at period end" so a business keeps
 * the service it already paid for.
 */
async function cancelSubscription({ immediately = false, actor = null } = {}) {
  if (!isConfigured()) return notConfigured();
  const stripe = client();

  const record = await Billing.get();
  const subscriptionId = record?.stripe_subscription_id;
  if (!subscriptionId)
    return { success: false, error: "No active subscription to cancel." };

  try {
    const subscription = immediately
      ? await stripe.subscriptions.cancel(subscriptionId)
      : await stripe.subscriptions.update(subscriptionId, {
          cancel_at_period_end: true,
        });

    await Billing.applySubscription(subscription, { reason: "cancellation" });
    await AuditLog.log({
      action: immediately
        ? "billing.subscription_canceled_immediately"
        : "billing.subscription_cancel_scheduled",
      category: AuditLog.CATEGORIES.BILLING,
      actor,
      resource: "subscription",
      resourceId: subscriptionId,
      metadata: { immediately },
    });

    return {
      success: true,
      status: Billing.mapStripeStatus(subscription.status),
    };
  } catch (error) {
    console.error("[Billing] cancellation failed:", error.message);
    return { success: false, error: "Unable to cancel the subscription." };
  }
}

/** Reverses a scheduled cancellation. */
async function resumeSubscription({ actor = null } = {}) {
  if (!isConfigured()) return notConfigured();
  const stripe = client();
  const record = await Billing.get();
  if (!record?.stripe_subscription_id)
    return { success: false, error: "No subscription to resume." };

  try {
    const subscription = await stripe.subscriptions.update(
      record.stripe_subscription_id,
      { cancel_at_period_end: false }
    );
    await Billing.applySubscription(subscription, { reason: "resume" });
    await AuditLog.log({
      action: "billing.subscription_resumed",
      category: AuditLog.CATEGORIES.BILLING,
      actor,
      resource: "subscription",
      resourceId: record.stripe_subscription_id,
    });
    return { success: true };
  } catch (error) {
    console.error("[Billing] resume failed:", error.message);
    return { success: false, error: "Unable to resume the subscription." };
  }
}

module.exports = {
  paymentLink,
  buildPaymentLink,
  paymentLinkConfigured,
  PLAN,
  STATUS,
  resolvePriceId,
  verifyPriceMatchesPlan,
  ensureCustomer,
  createCheckoutSession,
  createInvoicedSubscription,
  createPortalSession,
  syncFromStripe,
  listInvoices,
  cancelSubscription,
  resumeSubscription,
};
