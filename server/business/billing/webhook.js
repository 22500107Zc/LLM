const prisma = require("../../utils/prisma");
const config = require("../config");
const { client, isConfigured } = require("./stripe");
const { Billing } = require("../models/billing");
const { AuditLog } = require("../models/audit");

/**
 * Stripe webhook receiver.
 *
 * Three properties matter here and each is enforced explicitly:
 *   1. Authenticity  - every event is verified against STRIPE_WEBHOOK_SECRET
 *                      using the raw request body.
 *   2. Idempotency   - each Stripe event id is claimed in the database before
 *                      it is applied, so a replay can never double-apply.
 *   3. Confinement   - only events for THIS deployment's customer are applied.
 */

/** Events we act on. Anything else is acknowledged and ignored. */
const HANDLED_EVENTS = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.paid",
  "invoice.payment_succeeded",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "customer.deleted",
]);

/**
 * Atomically claims an event id. Returns false when the event was already
 * recorded, which is the idempotency guarantee - the unique index on
 * `stripe_event_id` is what actually enforces it under concurrency.
 * @returns {Promise<boolean>} true when this process should process the event
 */
async function claimEvent(event) {
  try {
    await prisma.billing_events.create({
      data: {
        stripe_event_id: event.id,
        type: event.type,
        status: "processing",
        occurredAt: event.created ? new Date(event.created * 1000) : new Date(),
      },
    });
    return true;
  } catch (error) {
    // P2002 == unique constraint violation == we have seen this event already.
    if (error?.code === "P2002") return false;
    throw error;
  }
}

async function finishEvent(eventId, status, summary = null) {
  try {
    await prisma.billing_events.update({
      where: { stripe_event_id: eventId },
      data: {
        status,
        summary: summary ? String(summary).slice(0, 500) : null,
        processedAt: new Date(),
      },
    });
  } catch (error) {
    console.error("[Billing webhook] could not finalize event:", error.message);
  }
}

/**
 * Releases a claim so Stripe's retry of a failed event is processed instead of
 * being mistaken for a replay. This is only safe because every apply path sets
 * absolute state from Stripe's own object - nothing here increments or appends
 * - so re-running a partially-applied event converges to the same result.
 */
async function releaseEvent(eventId) {
  try {
    await prisma.billing_events.delete({ where: { stripe_event_id: eventId } });
  } catch (error) {
    console.error(
      "[Billing webhook] could not release event claim:",
      error.message
    );
  }
}

/**
 * Guards against a webhook endpoint that is (mis)configured to receive events
 * for a Stripe account serving several deployments. We only apply events whose
 * customer matches the one this deployment is bound to.
 */
async function isForThisDeployment(customerId) {
  if (!customerId) return true; // Nothing to compare against; let it through.
  const record = await Billing.get();
  const known = record?.stripe_customer_id || config.stripe.customerId;
  // Before the deployment is bound to a customer, the first event binds it.
  if (!known) return true;
  return known === customerId;
}

function customerIdFrom(object) {
  if (!object) return null;
  const { customer } = object;
  if (typeof customer === "string") return customer;
  if (customer && typeof customer === "object") return customer.id ?? null;
  // customer.deleted / customer.* events carry the id on the object itself.
  if (object.object === "customer") return object.id ?? null;
  return null;
}

/**
 * Retrieves the full subscription so state is always applied from Stripe's
 * canonical object rather than a partially-expanded webhook payload.
 */
async function retrieveSubscription(subscriptionId) {
  const stripe = client();
  if (!stripe || !subscriptionId) return null;
  try {
    return await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ["items.data.price"],
    });
  } catch (error) {
    console.error(
      "[Billing webhook] subscription fetch failed:",
      error.message
    );
    return null;
  }
}

/** Applies a single verified event. */
async function applyEvent(event) {
  const object = event.data?.object ?? {};

  switch (event.type) {
    case "checkout.session.completed": {
      if (object.mode !== "subscription")
        return "ignored: non-subscription checkout";
      const customerId = customerIdFrom(object);
      if (customerId)
        await Billing.update(
          {
            stripe_customer_id: customerId,
            billing_email:
              object.customer_details?.email ?? object.customer_email ?? null,
          },
          { reason: "checkout.session.completed" }
        );

      const subscription = await retrieveSubscription(
        typeof object.subscription === "string"
          ? object.subscription
          : object.subscription?.id
      );
      if (subscription)
        await Billing.applySubscription(subscription, {
          reason: "checkout.session.completed",
        });

      await AuditLog.log({
        action: "billing.subscription_activated",
        category: AuditLog.CATEGORIES.BILLING,
        resource: "subscription",
        resourceId: subscription?.id ?? null,
        metadata: { via: "checkout", status: subscription?.status ?? null },
      });
      return "subscription activated from checkout";
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.paused":
    case "customer.subscription.resumed": {
      // Re-fetch to get fully expanded price data.
      const subscription = (await retrieveSubscription(object.id)) ?? object;
      await Billing.applySubscription(subscription, { reason: event.type });
      return `subscription ${subscription.status}`;
    }

    case "customer.subscription.deleted": {
      await Billing.applySubscription(
        { ...object, status: "canceled" },
        { reason: event.type }
      );
      await AuditLog.log({
        action: "billing.subscription_canceled",
        category: AuditLog.CATEGORIES.BILLING,
        resource: "subscription",
        resourceId: object.id ?? null,
        metadata: { note: "Customer data is retained. No data is deleted." },
      });
      return "subscription canceled";
    }

    case "invoice.paid":
    case "invoice.payment_succeeded": {
      await Billing.applyInvoice(object, "paid");
      // An invoice paying off may also change the subscription status.
      const subscriptionId =
        typeof object.subscription === "string"
          ? object.subscription
          : object.subscription?.id;
      const subscription = await retrieveSubscription(subscriptionId);
      if (subscription)
        await Billing.applySubscription(subscription, { reason: event.type });

      await AuditLog.log({
        action: "billing.payment_succeeded",
        category: AuditLog.CATEGORIES.BILLING,
        resource: "invoice",
        resourceId: object.id ?? null,
        metadata: {
          amountPaid: object.amount_paid ?? null,
          currency: object.currency ?? null,
        },
      });
      return "invoice paid";
    }

    case "invoice.payment_failed": {
      await Billing.applyInvoice(object, "failed");
      await AuditLog.log({
        action: "billing.payment_failed",
        category: AuditLog.CATEGORIES.BILLING,
        resource: "invoice",
        resourceId: object.id ?? null,
        metadata: {
          attemptCount: object.attempt_count ?? null,
          amountDue: object.amount_due ?? null,
          // Never log the payment instrument, only that a failure occurred.
        },
      });
      return "invoice payment failed";
    }

    case "invoice.payment_action_required": {
      await Billing.applyInvoice(object, "action_required");
      await AuditLog.log({
        action: "billing.payment_action_required",
        category: AuditLog.CATEGORIES.BILLING,
        resource: "invoice",
        resourceId: object.id ?? null,
      });
      return "invoice requires payment action";
    }

    case "customer.deleted": {
      await AuditLog.log({
        action: "billing.customer_deleted",
        category: AuditLog.CATEGORIES.BILLING,
        resource: "customer",
        resourceId: object.id ?? null,
        metadata: { note: "Deployment data retained." },
      });
      return "customer deleted in Stripe";
    }

    default:
      return "ignored";
  }
}

/**
 * Express handler. MUST be mounted with a raw body parser so the signature can
 * be verified against the exact bytes Stripe signed.
 */
async function handleStripeWebhook(request, response) {
  if (!isConfigured() || !config.stripe.webhookSecret) {
    // Do not reveal configuration detail to an unauthenticated caller.
    return response.status(503).json({ received: false });
  }

  const signature = request.headers["stripe-signature"];
  if (!signature) return response.status(400).json({ received: false });

  const stripe = client();
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      request.body, // Buffer - express.raw()
      signature,
      config.stripe.webhookSecret
    );
  } catch (error) {
    console.warn(
      "[Billing webhook] signature verification failed:",
      error.message
    );
    return response.status(400).json({ received: false });
  }

  // Claim before applying. A replayed event never reaches applyEvent().
  let claimed = false;
  try {
    claimed = await claimEvent(event);
  } catch (error) {
    console.error("[Billing webhook] could not claim event:", error.message);
    // Ask Stripe to retry rather than silently dropping a billing event.
    return response.status(500).json({ received: false });
  }

  if (!claimed) {
    console.log(`[Billing webhook] duplicate event ignored: ${event.id}`);
    return response.status(200).json({ received: true, duplicate: true });
  }

  if (!HANDLED_EVENTS.has(event.type)) {
    await finishEvent(event.id, "ignored", `Unhandled type ${event.type}`);
    return response.status(200).json({ received: true });
  }

  const customerId = customerIdFrom(event.data?.object);
  if (!(await isForThisDeployment(customerId))) {
    await finishEvent(event.id, "skipped", "Event belongs to another customer");
    console.warn(
      `[Billing webhook] ignoring event ${event.id} for foreign customer ${customerId}`
    );
    return response.status(200).json({ received: true });
  }

  try {
    const summary = await applyEvent(event);
    await finishEvent(event.id, "processed", summary);
    console.log(`[Billing webhook] ${event.type} -> ${summary}`);
    return response.status(200).json({ received: true });
  } catch (error) {
    console.error(
      `[Billing webhook] failed to apply ${event.type}:`,
      error.message
    );
    // Release the claim so Stripe's retry is actually processed rather than
    // being swallowed as a duplicate.
    await releaseEvent(event.id);
    return response.status(500).json({ received: false });
  }
}

module.exports = {
  handleStripeWebhook,
  HANDLED_EVENTS,
  // Exported for tests.
  _internals: {
    claimEvent,
    releaseEvent,
    applyEvent,
    customerIdFrom,
    isForThisDeployment,
  },
};
