const prisma = require("../../utils/prisma");
const config = require("../config");
const { AuditLog } = require("./audit");

const SINGLETON_ID = 1;

/**
 * Canonical subscription states. Stripe's own statuses are mapped onto these so
 * the rest of the application never has to know Stripe's vocabulary.
 */
const STATUS = Object.freeze({
  UNCONFIGURED: "unconfigured",
  ACTIVE: "active",
  TRIALING: "trialing",
  PAST_DUE: "past_due",
  PAYMENT_ACTION_REQUIRED: "payment_action_required",
  UNPAID: "unpaid",
  INCOMPLETE: "incomplete",
  INCOMPLETE_EXPIRED: "incomplete_expired",
  CANCELED: "canceled",
  PAUSED: "paused",
});

/** Stripe subscription.status -> our canonical status. */
const STRIPE_STATUS_MAP = Object.freeze({
  active: STATUS.ACTIVE,
  trialing: STATUS.TRIALING,
  past_due: STATUS.PAST_DUE,
  unpaid: STATUS.UNPAID,
  canceled: STATUS.CANCELED,
  incomplete: STATUS.INCOMPLETE,
  incomplete_expired: STATUS.INCOMPLETE_EXPIRED,
  paused: STATUS.PAUSED,
});

/** Access levels the rest of the app enforces against. */
const ACCESS = Object.freeze({
  OK: "ok",
  WARNING: "warning",
  RESTRICTED: "restricted",
});

const HUMAN_STATUS = Object.freeze({
  [STATUS.UNCONFIGURED]: "Not configured",
  [STATUS.ACTIVE]: "Active",
  [STATUS.TRIALING]: "Trialing",
  [STATUS.PAST_DUE]: "Past due",
  [STATUS.PAYMENT_ACTION_REQUIRED]: "Payment action required",
  [STATUS.UNPAID]: "Unpaid",
  [STATUS.INCOMPLETE]: "Incomplete",
  [STATUS.INCOMPLETE_EXPIRED]: "Incomplete (expired)",
  [STATUS.CANCELED]: "Canceled",
  [STATUS.PAUSED]: "Paused",
});

function toDate(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? null : value;
  // Stripe returns unix seconds.
  if (typeof value === "number") {
    const date = new Date(value * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const Billing = {
  STATUS,
  ACCESS,
  STRIPE_STATUS_MAP,
  SINGLETON_ID,

  mapStripeStatus(stripeStatus) {
    return STRIPE_STATUS_MAP[String(stripeStatus)] ?? STATUS.UNCONFIGURED;
  },

  /** Reads (creating on first call) the singleton subscription record. */
  get: async function () {
    try {
      const existing = await prisma.billing_subscription.findUnique({
        where: { id: SINGLETON_ID },
      });
      if (existing) return existing;

      // Seed from environment so an operator-provisioned deployment already
      // knows which Stripe objects it belongs to before the first webhook.
      return await prisma.billing_subscription.create({
        data: {
          id: SINGLETON_ID,
          stripe_customer_id: config.stripe.customerId || null,
          stripe_subscription_id: config.stripe.subscriptionId || null,
          stripe_price_id: config.stripe.priceId || null,
          status: STATUS.UNCONFIGURED,
          unit_amount: config.PLAN.amountCents,
          currency: config.PLAN.currency,
        },
      });
    } catch (error) {
      console.error(
        "[Billing] failed to read subscription state:",
        error.message
      );
      return null;
    }
  },

  /**
   * Persists a partial update and emits an audit event when the status moved.
   * @param {object} data
   * @param {{reason?: string, actor?: object|null}} context
   */
  update: async function (data = {}, context = {}) {
    try {
      const current = await this.get();
      const next = await prisma.billing_subscription.update({
        where: { id: SINGLETON_ID },
        data: { ...data, lastUpdatedAt: new Date() },
      });

      if (current && current.status !== next.status) {
        await AuditLog.log({
          action: "billing.status_changed",
          category: AuditLog.CATEGORIES.BILLING,
          actor: context.actor ?? null,
          resource: "subscription",
          resourceId: next.stripe_subscription_id ?? String(SINGLETON_ID),
          metadata: {
            from: current.status,
            to: next.status,
            reason: context.reason ?? "sync",
          },
        });
      }
      return next;
    } catch (error) {
      console.error(
        "[Billing] failed to update subscription state:",
        error.message
      );
      return null;
    }
  },

  /**
   * Applies a Stripe Subscription object to local state.
   * @param {object} subscription a Stripe Subscription
   */
  applySubscription: async function (subscription, context = {}) {
    if (!subscription?.id) return null;
    const item = subscription.items?.data?.[0] ?? null;
    const price = item?.price ?? null;
    const status = this.mapStripeStatus(subscription.status);

    const current = await this.get();
    const patch = {
      stripe_subscription_id: subscription.id,
      stripe_customer_id:
        typeof subscription.customer === "string"
          ? subscription.customer
          : subscription.customer?.id ?? current?.stripe_customer_id ?? null,
      stripe_price_id: price?.id ?? current?.stripe_price_id ?? null,
      status,
      collection_method: subscription.collection_method ?? null,
      currency: price?.currency ?? current?.currency ?? config.PLAN.currency,
      unit_amount: price?.unit_amount ?? current?.unit_amount ?? null,
      current_period_start: toDate(
        subscription.current_period_start ?? item?.current_period_start
      ),
      current_period_end: toDate(
        subscription.current_period_end ?? item?.current_period_end
      ),
      cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
      canceled_at: toDate(subscription.canceled_at),
    };

    // Track when a dunning window opened so the grace period can be measured.
    const inDunning = [STATUS.PAST_DUE, STATUS.UNPAID].includes(status);
    if (inDunning && !current?.past_due_since)
      patch.past_due_since = new Date();
    if (!inDunning) {
      patch.past_due_since = null;
      patch.restricted_at = null;
    }

    return this.update(patch, {
      reason: context.reason ?? "subscription.sync",
    });
  },

  /**
   * Applies a Stripe Invoice object to local state.
   * @param {object} invoice a Stripe Invoice
   * @param {"paid"|"failed"|"action_required"} outcome
   */
  applyInvoice: async function (invoice, outcome) {
    if (!invoice?.id) return null;
    const current = await this.get();
    const patch = {
      latest_invoice_id: invoice.id,
      latest_invoice_status: invoice.status ?? null,
      latest_invoice_url: invoice.hosted_invoice_url ?? null,
      billing_email: invoice.customer_email ?? current?.billing_email ?? null,
    };

    // Deliberately does NOT set stripe_customer_id. Binding is owned by
    // business/billing/binding.js and may only happen from a Checkout Session
    // this deployment created - an invoice must never establish it.

    if (outcome === "paid") {
      patch.last_payment_status = "succeeded";
      patch.last_payment_at = new Date();
      patch.past_due_since = null;
      patch.restricted_at = null;
      // An invoice paying off restores service even if the subscription
      // webhook has not landed yet.
      if (
        current &&
        [
          STATUS.PAST_DUE,
          STATUS.UNPAID,
          STATUS.PAYMENT_ACTION_REQUIRED,
        ].includes(current.status)
      )
        patch.status = STATUS.ACTIVE;
    }

    if (outcome === "failed") {
      patch.last_payment_status = "failed";
      if (!current?.past_due_since) patch.past_due_since = new Date();
      if (
        current?.status === STATUS.ACTIVE ||
        current?.status === STATUS.TRIALING
      )
        patch.status = STATUS.PAST_DUE;
    }

    if (outcome === "action_required") {
      patch.last_payment_status = "action_required";
      patch.status = STATUS.PAYMENT_ACTION_REQUIRED;
      if (!current?.past_due_since) patch.past_due_since = new Date();
    }

    return this.update(patch, { reason: `invoice.${outcome}` });
  },

  /**
   * Computes the deployment's effective access level. This is the single
   * function the enforcement middleware and the UI both read.
   *
   * Data is never deleted here - a restricted deployment keeps everything and
   * simply stops serving AI traffic.
   *
   * @param {object|null} record optional pre-fetched subscription row
   * @param {Date} now injectable for tests
   */
  evaluateAccess: function (record, now = new Date()) {
    const policy = config.billingPolicy;
    const graceMs = policy.gracePeriodDays * 24 * 60 * 60 * 1000;

    const base = {
      access: ACCESS.OK,
      status: record?.status ?? STATUS.UNCONFIGURED,
      statusLabel:
        HUMAN_STATUS[record?.status ?? STATUS.UNCONFIGURED] ?? "Unknown",
      enforcementEnabled: policy.enforcementEnabled,
      gracePeriodDays: policy.gracePeriodDays,
      graceEndsAt: null,
      graceDaysRemaining: null,
      reason: null,
      message: null,
    };

    // Enforcement is opt-in; without it we still report an accurate status but
    // never restrict the customer.
    if (!policy.enforcementEnabled) return base;

    if (!record || record.status === STATUS.UNCONFIGURED) {
      // Billing has not been wired up yet - do not punish the customer.
      return { ...base, access: ACCESS.OK, reason: "unconfigured" };
    }

    const status = record.status;

    if ([STATUS.ACTIVE, STATUS.TRIALING].includes(status)) {
      if (record.cancel_at_period_end)
        return {
          ...base,
          access: ACCESS.WARNING,
          reason: "cancel_at_period_end",
          message:
            "This subscription is scheduled to cancel at the end of the current billing period.",
        };
      return base;
    }

    // Cancellation keeps service until the paid period actually ends.
    if (status === STATUS.CANCELED) {
      const periodEnd = record.current_period_end
        ? new Date(record.current_period_end)
        : null;
      if (periodEnd && periodEnd.getTime() > now.getTime())
        return {
          ...base,
          access: ACCESS.WARNING,
          reason: "canceled_pending_period_end",
          graceEndsAt: periodEnd.toISOString(),
          message:
            "This subscription is canceled. Service continues until the paid period ends.",
        };
      return {
        ...base,
        access: ACCESS.RESTRICTED,
        reason: "canceled",
        message:
          "This subscription is canceled. Your data is retained; AI usage is suspended until billing is restored.",
      };
    }

    if (
      [STATUS.PAST_DUE, STATUS.UNPAID, STATUS.PAYMENT_ACTION_REQUIRED].includes(
        status
      )
    ) {
      const since = record.past_due_since
        ? new Date(record.past_due_since)
        : new Date(now);
      const graceEndsAt = new Date(since.getTime() + graceMs);
      const withinGrace = now.getTime() < graceEndsAt.getTime();
      const msRemaining = graceEndsAt.getTime() - now.getTime();

      if (withinGrace)
        return {
          ...base,
          access: ACCESS.WARNING,
          reason: "in_grace_period",
          graceEndsAt: graceEndsAt.toISOString(),
          graceDaysRemaining: Math.max(0, Math.ceil(msRemaining / 86_400_000)),
          message:
            status === STATUS.PAYMENT_ACTION_REQUIRED
              ? "A payment needs to be confirmed. Please complete it to avoid interruption."
              : "A payment has failed. Please update billing to avoid interruption.",
        };

      return {
        ...base,
        access: ACCESS.RESTRICTED,
        reason: "grace_period_expired",
        graceEndsAt: graceEndsAt.toISOString(),
        graceDaysRemaining: 0,
        message:
          "Billing is overdue. Your data is retained; AI usage is suspended until payment is resolved.",
      };
    }

    if (
      [STATUS.INCOMPLETE, STATUS.INCOMPLETE_EXPIRED, STATUS.PAUSED].includes(
        status
      )
    )
      return {
        ...base,
        access:
          status === STATUS.INCOMPLETE ? ACCESS.WARNING : ACCESS.RESTRICTED,
        reason: status,
        message:
          "This subscription is not active. Please complete billing setup.",
      };

    return base;
  },

  /** Convenience: reads state and evaluates access in one call. */
  currentAccess: async function (now = new Date()) {
    const record = await this.get();
    return { record, ...this.evaluateAccess(record, now) };
  },

  /**
   * The browser-safe billing summary for the Billing page.
   * Contains no Stripe secrets and no payment instrument data.
   */
  publicSummary: async function () {
    const { record, ...access } = await this.currentAccess();
    const stripeStatus = require("../billing/stripe").configurationStatus();
    return {
      plan: {
        name: config.PLAN.name,
        price: config.PLAN.displayPrice,
        priceWithInterval: config.PLAN.displayPriceWithInterval,
        interval: config.PLAN.interval,
        currency: (record?.currency ?? config.PLAN.currency).toUpperCase(),
        amountCents: record?.unit_amount ?? config.PLAN.amountCents,
      },
      subscription: {
        status: record?.status ?? STATUS.UNCONFIGURED,
        statusLabel: access.statusLabel,
        // Identifiers are shown so an operator can reconcile with Stripe; these
        // are not secrets, but the secret key never leaves the server.
        customerId: record?.stripe_customer_id ?? null,
        subscriptionId: record?.stripe_subscription_id ?? null,
        billingEmail: record?.billing_email ?? null,
        collectionMethod: record?.collection_method ?? null,
        currentPeriodStart: record?.current_period_start ?? null,
        nextBillingDate: record?.current_period_end ?? null,
        cancelAtPeriodEnd: Boolean(record?.cancel_at_period_end),
        canceledAt: record?.canceled_at ?? null,
      },
      payment: {
        lastStatus: record?.last_payment_status ?? null,
        lastPaymentAt: record?.last_payment_at ?? null,
        latestInvoiceId: record?.latest_invoice_id ?? null,
        latestInvoiceStatus: record?.latest_invoice_status ?? null,
        latestInvoiceUrl: record?.latest_invoice_url ?? null,
      },
      access,
      stripe: stripeStatus,
      // Explicit reassurance surfaced in the UI: we never touch card data.
      cardDataStored: false,
    };
  },
};

module.exports = { Billing, STATUS, ACCESS, HUMAN_STATUS };
