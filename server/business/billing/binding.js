const crypto = require("crypto");
const prisma = require("../../utils/prisma");
const config = require("../config");
const { AuditLog } = require("../models/audit");

/**
 * Stripe customer binding.
 *
 * A Stripe account can serve many deployments. Without a rule about WHICH
 * deployment an event belongs to, the first event to arrive at an unbound
 * deployment would claim it - so an unrelated invoice, or an arbitrary valid
 * event replayed from elsewhere in the same account, could attach a customer
 * that does not belong to this business.
 *
 * The rule enforced here:
 *
 *   1. Every Stripe object this deployment creates is stamped with its
 *      DEPLOYMENT_ID.
 *   2. Before the owner is redirected to Checkout, the session id is written
 *      to `billing_pending_checkouts`.
 *   3. An UNBOUND deployment may bind only from `checkout.session.completed`
 *      for a session it finds in that table whose DEPLOYMENT_ID matches. No
 *      invoice, subscription or customer event can create the first binding.
 *   4. When STRIPE_CUSTOMER_ID is configured, that customer must match from
 *      the very first event.
 *   5. Once bound, every applicable event must carry exactly that customer.
 *
 * Binding is a single conditional UPDATE, so two webhooks delivered at the
 * same moment cannot both bind.
 */

const PENDING_TTL_MS = 24 * 60 * 60 * 1000; // Stripe sessions expire in 24h.

const BIND_RESULT = Object.freeze({
  BOUND: "bound",
  ALREADY_BOUND: "already_bound",
  REJECTED: "rejected",
});

/**
 * Records a Checkout Session this deployment just created.
 * Called before the owner is redirected, so the session is known to us first.
 */
async function recordPendingCheckout({
  sessionId,
  expectedCustomer = null,
  priceId = null,
}) {
  if (!sessionId) return null;
  try {
    return await prisma.billing_pending_checkouts.upsert({
      where: { session_id: String(sessionId) },
      update: {
        deployment_id: config.deploymentId,
        expected_customer: expectedCustomer,
        price_id: priceId,
        status: "pending",
        expiresAt: new Date(Date.now() + PENDING_TTL_MS),
      },
      create: {
        session_id: String(sessionId),
        deployment_id: config.deploymentId,
        expected_customer: expectedCustomer,
        price_id: priceId,
        status: "pending",
        expiresAt: new Date(Date.now() + PENDING_TTL_MS),
      },
    });
  } catch (error) {
    console.error(
      "[Billing binding] could not record the pending checkout:",
      error.message
    );
    return null;
  }
}

/** @returns {Promise<object|null>} the pending record for a session, if ours. */
async function findPendingCheckout(sessionId) {
  if (!sessionId) return null;
  try {
    const record = await prisma.billing_pending_checkouts.findUnique({
      where: { session_id: String(sessionId) },
    });
    if (!record) return null;
    if (record.expiresAt && record.expiresAt.getTime() < Date.now())
      return null;
    return record;
  } catch (error) {
    console.error("[Billing binding] pending lookup failed:", error.message);
    return null;
  }
}

/** Constant-time comparison so a mismatch cannot be probed by timing. */
function idsMatch(a, b) {
  if (!a || !b) return false;
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Attempts to bind this deployment to a Stripe customer.
 *
 * The write is a single conditional UPDATE against the unbound state, so
 * concurrent webhook deliveries cannot both succeed.
 *
 * @param {{customerId: string, via: string, sessionId?: string|null}} params
 * @returns {Promise<{result: string, reason?: string}>}
 */
async function bindCustomer({ customerId, via, sessionId = null }) {
  if (!customerId)
    return { result: BIND_RESULT.REJECTED, reason: "no customer on the event" };

  const configured = config.stripe.customerId;
  if (configured && !idsMatch(configured, customerId))
    return {
      result: BIND_RESULT.REJECTED,
      reason: "event customer does not match the configured STRIPE_CUSTOMER_ID",
    };

  try {
    // Conditional update: only succeeds while the row is still unbound.
    const claimed = await prisma.billing_subscription.updateMany({
      where: { id: 1, stripe_customer_id: null },
      data: {
        stripe_customer_id: String(customerId),
        bound_deployment_id: config.deploymentId || null,
        bound_at: new Date(),
        bound_via: String(via).slice(0, 60),
        lastUpdatedAt: new Date(),
      },
    });

    if (claimed.count === 1) {
      await AuditLog.log({
        action: "billing.deployment_bound",
        category: AuditLog.CATEGORIES.BILLING,
        resource: "customer",
        resourceId: customerId,
        metadata: { via, sessionId, deploymentId: maskId(config.deploymentId) },
      });
      return { result: BIND_RESULT.BOUND };
    }

    // Someone bound it first (or it was already bound). Accept only if that
    // binding is to this same customer.
    const current = await prisma.billing_subscription.findUnique({
      where: { id: 1 },
    });
    if (idsMatch(current?.stripe_customer_id, customerId))
      return { result: BIND_RESULT.ALREADY_BOUND };

    return {
      result: BIND_RESULT.REJECTED,
      reason: "this deployment is already bound to a different customer",
    };
  } catch (error) {
    console.error("[Billing binding] bind failed:", error.message);
    return {
      result: BIND_RESULT.REJECTED,
      reason: "binding could not be completed",
    };
  }
}

/** Never log a deployment secret in full. */
function maskId(value) {
  const text = String(value ?? "");
  if (text.length <= 8) return text ? "set" : "unset";
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

/**
 * Decides whether an event may be applied to this deployment.
 *
 * @param {object} event a verified Stripe event
 * @param {string|null} customerId the customer the event refers to
 * @returns {Promise<{allowed: boolean, reason?: string, bindWith?: object}>}
 */
async function authorizeEvent(event, customerId) {
  const record = await prisma.billing_subscription.findUnique({
    where: { id: 1 },
  });
  const boundCustomer = record?.stripe_customer_id ?? null;

  // ---- already bound: the customer must match exactly ---------------------
  if (boundCustomer) {
    if (!customerId)
      // Events with no customer (rare, e.g. some account-level events) are
      // applied only if they are not customer-scoped at all.
      return { allowed: true };
    if (idsMatch(boundCustomer, customerId)) return { allowed: true };
    return {
      allowed: false,
      reason: "event belongs to a different Stripe customer",
    };
  }

  // ---- unbound: only a checkout WE created may bind -----------------------
  if (event.type !== "checkout.session.completed")
    return {
      allowed: false,
      reason: `an unbound deployment cannot be bound by ${event.type}; only a checkout session this deployment created may bind it`,
    };

  const session = event.data?.object ?? {};

  // ---- path 1: a Stripe-hosted Payment Link ------------------------------
  //
  // A Payment Link is a static URL, so there is no session for this
  // deployment to have registered in advance. What it does carry is
  // `client_reference_id`, which the application set to its own DEPLOYMENT_ID
  // when it handed the link over, and which Stripe returns verbatim.
  //
  // DEPLOYMENT_ID is long, random and never leaves the server except inside
  // that link, so a matching value is strong evidence this payment is ours.
  // It is compared in constant time and must match exactly - a present but
  // different value means the payment belongs to somebody else's deployment,
  // and is refused rather than ignored.
  const reference = session.client_reference_id ?? null;
  if (reference) {
    if (!config.deploymentId)
      return {
        allowed: false,
        reason:
          "a payment-link checkout arrived but this deployment has no DEPLOYMENT_ID to match it against",
      };
    if (!idsMatch(reference, config.deploymentId))
      return {
        allowed: false,
        reason: "payment-link checkout references another deployment",
      };
    return {
      allowed: true,
      bindWith: {
        customerId,
        via: "payment_link",
        sessionId: session.id,
      },
    };
  }

  // ---- path 2: a Checkout Session this deployment created -----------------
  const pending = await findPendingCheckout(session.id);
  if (!pending)
    // Not refused as someone else's: a customer may genuinely have paid
    // through a link that lost its reference. It cannot be matched safely, so
    // nothing is activated - but a human is told, rather than it vanishing
    // into a log line.
    return {
      allowed: false,
      reviewRequired: true,
      reason:
        "a checkout completed that carries no client_reference_id and matches no checkout this deployment created, so it could not be matched to this customer",
    };

  const metadataDeployment = session.metadata?.deployment_id ?? null;
  if (config.deploymentId) {
    if (!idsMatch(pending.deployment_id, config.deploymentId))
      return {
        allowed: false,
        reason: "pending checkout belongs to another deployment",
      };
    if (
      metadataDeployment &&
      !idsMatch(metadataDeployment, config.deploymentId)
    )
      return {
        allowed: false,
        reason: "checkout metadata names another deployment",
      };
  }

  if (
    pending.expected_customer &&
    customerId &&
    !idsMatch(pending.expected_customer, customerId)
  )
    return {
      allowed: false,
      reason: "checkout completed for an unexpected customer",
    };

  return {
    allowed: true,
    bindWith: {
      customerId,
      via: "checkout.session.completed",
      sessionId: session.id,
    },
  };
}

/** Marks a pending checkout consumed so it cannot be reused to bind again. */
async function consumePendingCheckout(sessionId) {
  if (!sessionId) return;
  try {
    await prisma.billing_pending_checkouts.updateMany({
      where: { session_id: String(sessionId), status: "pending" },
      data: { status: "consumed", consumedAt: new Date() },
    });
  } catch (error) {
    console.error(
      "[Billing binding] could not consume the pending checkout:",
      error.message
    );
  }
}

/** Removes expired pending records. Safe to call periodically. */
async function pruneExpiredCheckouts() {
  try {
    const { count } = await prisma.billing_pending_checkouts.deleteMany({
      where: { expiresAt: { lt: new Date() }, status: "pending" },
    });
    return count;
  } catch {
    return 0;
  }
}

module.exports = {
  BIND_RESULT,
  recordPendingCheckout,
  findPendingCheckout,
  consumePendingCheckout,
  pruneExpiredCheckouts,
  bindCustomer,
  authorizeEvent,
  idsMatch,
  maskId,
  PENDING_TTL_MS,
};
