const { reqBody } = require("../../utils/http");
const { Billing } = require("../models/billing");
const { AuditLog } = require("../models/audit");
const service = require("../billing/service");
const { configurationStatus } = require("../billing/stripe");
const config = require("../config");
const { requireCapability, safeHandler } = require("../middleware");
const { invalidateAccessCache } = require("../middleware/billingGate");

/**
 * Billing API.
 *
 * Every route is Owner-only, every money operation is delegated to a
 * Stripe-hosted surface, and no Stripe secret ever crosses into a response.
 */

function absoluteUrl(request, fallbackPath) {
  const configured = config.deployment.publicUrl;
  if (configured) return `${configured.replace(/\/$/, "")}${fallbackPath}`;
  // Trust the proxy headers a production reverse proxy sets.
  const proto =
    request.headers["x-forwarded-proto"] ?? request.protocol ?? "https";
  const host = request.headers["x-forwarded-host"] ?? request.get("host");
  return `${proto}://${host}${fallbackPath}`;
}

function billingRoutes(router) {
  /** Current plan, subscription state and access level. */
  router.get(
    "/billing/summary",
    [requireCapability("billing:view")],
    safeHandler(async (_request, response) => {
      const summary = await Billing.publicSummary();
      response.status(200).json(summary);
    })
  );

  /**
   * Confirms the configured Stripe price really is the commercial amount.
   * A mismatch here would mean charging the wrong price, so it is surfaced.
   */
  router.get(
    "/billing/verify-price",
    [requireCapability("billing:manage")],
    safeHandler(async (_request, response) => {
      const result = await service.verifyPriceMatchesPlan();
      response.status(200).json(result);
    })
  );

  /** Recent invoices - hosted Stripe links only. */
  router.get(
    "/billing/invoices",
    [requireCapability("billing:view")],
    safeHandler(async (_request, response) => {
      const result = await service.listInvoices({ limit: 12 });
      response.status(200).json(result);
    })
  );

  /** Starts Stripe-hosted Checkout for the fixed commercial plan. */
  router.post(
    "/billing/checkout",
    [requireCapability("billing:manage")],
    safeHandler(async (request, response) => {
      const { email = null, name = null } = reqBody(request);
      const result = await service.createCheckoutSession({
        email,
        name,
        successUrl: absoluteUrl(request, "/settings/billing?checkout=success"),
        cancelUrl: absoluteUrl(request, "/settings/billing?checkout=canceled"),
        actor: response.locals.user,
      });
      invalidateAccessCache();
      response.status(result.success ? 200 : 400).json(result);
    })
  );

  /** Creates the Stripe recurring-invoice subscription for invoiced B2B buyers. */
  router.post(
    "/billing/invoice-subscription",
    [requireCapability("billing:manage")],
    safeHandler(async (request, response) => {
      const { email = null, name = null, daysUntilDue = 30 } = reqBody(request);
      if (!email)
        return response.status(400).json({
          success: false,
          error: "A billing email address is required.",
        });

      const result = await service.createInvoicedSubscription({
        email,
        name,
        daysUntilDue,
        actor: response.locals.user,
      });
      invalidateAccessCache();
      response.status(result.success ? 200 : 400).json(result);
    })
  );

  /** Opens the Stripe Customer Portal. */
  router.post(
    "/billing/portal",
    [requireCapability("billing:manage")],
    safeHandler(async (request, response) => {
      const result = await service.createPortalSession({
        returnUrl: absoluteUrl(request, "/settings/billing"),
        actor: response.locals.user,
      });
      response.status(result.success ? 200 : 400).json(result);
    })
  );

  /** Pulls authoritative state from Stripe - recovers from a missed webhook. */
  router.post(
    "/billing/sync",
    [requireCapability("billing:manage")],
    safeHandler(async (_request, response) => {
      const result = await service.syncFromStripe({
        actor: response.locals.user,
      });
      invalidateAccessCache();
      response.status(result.success ? 200 : 400).json(result);
    })
  );

  /** Schedules (or, explicitly, immediately performs) cancellation. */
  router.post(
    "/billing/cancel",
    [requireCapability("billing:manage")],
    safeHandler(async (request, response) => {
      const { immediately = false } = reqBody(request);
      const result = await service.cancelSubscription({
        immediately: Boolean(immediately),
        actor: response.locals.user,
      });
      invalidateAccessCache();
      response.status(result.success ? 200 : 400).json(result);
    })
  );

  router.post(
    "/billing/resume",
    [requireCapability("billing:manage")],
    safeHandler(async (_request, response) => {
      const result = await service.resumeSubscription({
        actor: response.locals.user,
      });
      invalidateAccessCache();
      response.status(result.success ? 200 : 400).json(result);
    })
  );

  /**
   * Associates this deployment with an existing Stripe customer/subscription.
   * This is the operator-assisted provisioning path: a deal is closed in
   * Stripe, then the deployment is bound to it.
   */
  router.post(
    "/billing/associate",
    [requireCapability("billing:manage")],
    safeHandler(async (request, response) => {
      const { customerId = null, subscriptionId = null } = reqBody(request);
      if (!customerId && !subscriptionId)
        return response.status(400).json({
          success: false,
          error: "A Stripe customer or subscription identifier is required.",
        });

      // Shape-check the identifiers so a typo cannot bind the deployment to
      // something nonsensical before we call Stripe.
      if (customerId && !/^cus_[A-Za-z0-9]+$/.test(String(customerId)))
        return response.status(400).json({
          success: false,
          error: "That does not look like a Stripe customer ID.",
        });
      if (subscriptionId && !/^sub_[A-Za-z0-9]+$/.test(String(subscriptionId)))
        return response.status(400).json({
          success: false,
          error: "That does not look like a Stripe subscription ID.",
        });

      await Billing.update(
        {
          ...(customerId ? { stripe_customer_id: String(customerId) } : {}),
          ...(subscriptionId
            ? { stripe_subscription_id: String(subscriptionId) }
            : {}),
        },
        { reason: "operator.association", actor: response.locals.user }
      );

      await AuditLog.fromRequest(request, response, {
        action: "billing.deployment_associated",
        category: AuditLog.CATEGORIES.BILLING,
        resource: "subscription",
        resourceId: subscriptionId ?? customerId,
      });

      const result = await service.syncFromStripe({
        actor: response.locals.user,
      });
      invalidateAccessCache();
      response.status(200).json({ success: true, sync: result });
    })
  );

  /** Stripe configuration health - booleans only, never a key value. */
  router.get(
    "/billing/configuration",
    [requireCapability("billing:manage")],
    safeHandler(async (_request, response) => {
      response.status(200).json({
        stripe: configurationStatus(),
        plan: {
          name: config.PLAN.name,
          price: config.PLAN.displayPriceWithInterval,
          amountCents: config.PLAN.amountCents,
          currency: config.PLAN.currency,
          interval: config.PLAN.interval,
        },
        policy: config.billingPolicy,
      });
    })
  );
}

module.exports = { billingRoutes };
