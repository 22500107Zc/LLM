/**
 * Centralized commercial platform configuration.
 *
 * Everything that differs between deployments (branding, the customer's
 * identity, operational limits, billing policy) is resolved here from
 * environment variables so that no customer-specific value is ever hardcoded
 * into application source.
 *
 * This module is intentionally dependency-free and safe to require from
 * anywhere, including at boot before the database is available.
 */

/** The commercial amount, in cents, overridable per deployment. */
const DEFAULT_PLAN_AMOUNT_CENTS = 388888; // $3,888.88

function planAmountCents() {
  const configured = Number(process.env.PLAN_AMOUNT_CENTS);
  return Number.isFinite(configured) && configured > 0
    ? Math.trunc(configured)
    : DEFAULT_PLAN_AMOUNT_CENTS;
}

function formatAmount(cents, currency = "usd") {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/**
 * The commercial plan. The amount is read fresh so PLAN_AMOUNT_CENTS applies
 * without a rebuild, and it is validated against Stripe before checkout so a
 * mismatch is visible rather than silently charging the wrong price.
 */
const PLAN = Object.freeze({
  name: "Managed Business AI Platform",
  currency: "usd",
  interval: "month",
  get amountCents() {
    return planAmountCents();
  },
  get displayPrice() {
    return formatAmount(planAmountCents(), "usd");
  },
  get displayPriceWithInterval() {
    return `${formatAmount(planAmountCents(), "usd")}/month`;
  },
});

function str(key, fallback = "") {
  const value = process.env[key];
  if (value === undefined || value === null) return fallback;
  const trimmed = String(value).trim();
  return trimmed.length ? trimmed : fallback;
}

function bool(key, fallback = false) {
  const value = process.env[key];
  if (value === undefined || value === null || String(value).trim() === "")
    return fallback;
  return ["1", "true", "yes", "on"].includes(
    String(value).trim().toLowerCase()
  );
}

function int(key, fallback) {
  const value = Number(process.env[key]);
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

/** Normalizes a hex colour, falling back when the value is not a valid hex. */
function color(key, fallback) {
  const value = str(key);
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value) ? value : fallback;
}

const config = {
  PLAN,

  /** Brand shown to the business using the platform. */
  get branding() {
    const appName = str("APP_NAME", "Business AI Platform");
    return {
      appName,
      companyName: str("COMPANY_NAME", appName),
      legalCompanyName: str("LEGAL_COMPANY_NAME", str("COMPANY_NAME", appName)),
      appLogo: str("APP_LOGO", ""),
      appIcon: str("APP_ICON", ""),
      primaryDomain: str("PRIMARY_DOMAIN", ""),
      supportEmail: str("SUPPORT_EMAIL", ""),
      primaryColor: color("PRIMARY_COLOR", "#2563eb"),
      tagline: str(
        "APP_TAGLINE",
        "Your company's private AI operations platform"
      ),
      poweredByNotice: str("POWERED_BY_NOTICE", ""),
    };
  },

  /** Identity of the specific business this deployment belongs to. */
  get customer() {
    return {
      name: str("CUSTOMER_NAME", ""),
      domain: str("CUSTOMER_DOMAIN", str("PRIMARY_DOMAIN", "")),
      logo: str("CUSTOMER_LOGO", str("APP_LOGO", "")),
      supportEmail: str("SUPPORT_EMAIL", ""),
      primaryColor: color("PRIMARY_COLOR", "#2563eb"),
    };
  },

  /**
   * Which upstream surfaces to show a business customer. The Community Hub is
   * a working admin integration but it is an upstream-branded storefront, so
   * it is hidden by default in the commercial build and can be switched back
   * on for a customer who wants it.
   */
  get features() {
    return {
      showCommunityHub: bool("SHOW_COMMUNITY_HUB", false),
    };
  },

  /** Operational safeguards included with the plan. Not pricing tiers. */
  get limits() {
    return {
      maxUsers: int("MAX_USERS", 50),
      maxPublicAgents: int("MAX_PUBLIC_AGENTS", 3),
      storageLimitGb: int("STORAGE_LIMIT_GB", 25),
    };
  },

  /** Default model provider hints used by the onboarding flow. */
  get modelDefaults() {
    return {
      provider: str("DEFAULT_LLM_PROVIDER", ""),
      model: str("DEFAULT_LLM_MODEL", ""),
    };
  },

  /**
   * The immutable identity of THIS deployment.
   *
   * It is stamped into every Stripe object this deployment creates and is
   * required to bind the deployment to a Stripe customer, so an unrelated
   * event from the same Stripe account can never claim it.
   */
  get deploymentId() {
    return str("DEPLOYMENT_ID", "");
  },

  /** Stripe configuration. Secret values are never returned to the browser. */
  get stripe() {
    return {
      secretKey: str("STRIPE_SECRET_KEY", ""),
      publishableKey: str("STRIPE_PUBLISHABLE_KEY", ""),
      webhookSecret: str("STRIPE_WEBHOOK_SECRET", ""),
      priceId: str("STRIPE_PRICE_ID", ""),
      productId: str("STRIPE_PRODUCT_ID", ""),
      portalConfigurationId: str("STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID", ""),
      // A Stripe-HOSTED Payment Link. When set, this is how a customer pays:
      // the application hands over a URL and makes no outbound Stripe call to
      // start checkout. Stripe hosts the page; we only receive the webhook.
      paymentLink: str("STRIPE_PAYMENT_LINK", ""),
      // Seed values used when the operator has not yet run a sync.
      customerId: str("STRIPE_CUSTOMER_ID", ""),
      subscriptionId: str("STRIPE_SUBSCRIPTION_ID", ""),
      apiVersion: str("STRIPE_API_VERSION", "2024-11-20.acacia"),
    };
  },

  /** Subscription enforcement policy. Deliberately conservative by default. */
  get billingPolicy() {
    return {
      // Enforcement is opt-in so a misconfigured deployment can never lock a
      // paying customer out of their own data.
      enforcementEnabled: bool("BILLING_ENFORCEMENT_ENABLED", false),
      // A newly provisioned deployment has not paid yet, and the operator
      // wants it to stay unpaid until the Stripe webhook activates it. With
      // this on, "no subscription at all" is treated as not-yet-activated
      // rather than as an operator oversight.
      //
      // Off by default, so an existing deployment's behaviour is unchanged:
      // only provisioning writes it, and only for new customers.
      requireActivation: bool("BILLING_REQUIRE_ACTIVATION", false),
      gracePeriodDays: Math.max(0, int("BILLING_GRACE_PERIOD_DAYS", 7)),
      // What a restricted (post-grace) deployment actually blocks.
      restrictInternalChat: bool("BILLING_RESTRICT_INTERNAL_CHAT", true),
      restrictPublicAgents: bool("BILLING_RESTRICT_PUBLIC_AGENTS", true),
      restrictAutomations: bool("BILLING_RESTRICT_AUTOMATIONS", true),
      // Data is never deleted for billing reasons. Kept explicit for clarity.
      deleteDataOnCancellation: false,
    };
  },

  /** Outbound notification transport configuration. */
  get notifications() {
    return {
      smtp: {
        host: str("SMTP_HOST", ""),
        port: int("SMTP_PORT", 587),
        secure: bool("SMTP_SECURE", false),
        user: str("SMTP_USER", ""),
        pass: str("SMTP_PASSWORD", ""),
        from: str("SMTP_FROM", str("SUPPORT_EMAIL", "")),
      },
      leadNotificationEmail: str(
        "LEAD_NOTIFICATION_EMAIL",
        str("SUPPORT_EMAIL", "")
      ),
      escalationNotificationEmail: str(
        "ESCALATION_NOTIFICATION_EMAIL",
        str("SUPPORT_EMAIL", "")
      ),
    };
  },

  /** Security posture toggles for the commercial build. */
  get security() {
    return {
      // A production deployment must run in authenticated multi-user mode.
      requireMultiUser: bool("REQUIRE_MULTI_USER_MODE", true),
      requireEmbedAllowlist: bool("EMBED_REQUIRE_ALLOWLIST", true),
      // Protected uptime endpoint token.
      healthCheckToken: str("HEALTHCHECK_TOKEN", ""),
      publicRateLimitPerMinute: int("PUBLIC_RATE_LIMIT_PER_MINUTE", 30),
      publicRateLimitBurst: int("PUBLIC_RATE_LIMIT_BURST", 10),
      allowPrivateNetworkWebhooks: bool(
        "ALLOW_PRIVATE_NETWORK_WEBHOOKS",
        false
      ),
    };
  },

  get deployment() {
    return {
      environment: str("NODE_ENV", "production"),
      publicUrl: str("PUBLIC_URL", ""),
      version: require("../package.json").version,
      buildRef: str("BUILD_REF", ""),
      backupDir: str("BACKUP_DIR", ""),
    };
  },

  /**
   * The browser-safe subset of configuration. Never add a secret here.
   * @returns {object}
   */
  publicConfig() {
    const branding = this.branding;
    const customer = this.customer;
    return {
      branding: {
        appName: branding.appName,
        companyName: branding.companyName,
        legalCompanyName: branding.legalCompanyName,
        appLogo: branding.appLogo,
        appIcon: branding.appIcon,
        primaryDomain: branding.primaryDomain,
        supportEmail: branding.supportEmail,
        primaryColor: branding.primaryColor,
        tagline: branding.tagline,
        poweredByNotice: branding.poweredByNotice,
      },
      customer: {
        name: customer.name,
        domain: customer.domain,
        logo: customer.logo,
      },
      plan: {
        name: PLAN.name,
        amountCents: PLAN.amountCents,
        displayPrice: PLAN.displayPrice,
        displayPriceWithInterval: PLAN.displayPriceWithInterval,
        interval: PLAN.interval,
        currency: PLAN.currency,
      },
      limits: this.limits,
      features: this.features,
      version: this.deployment.version,
    };
  },

  // Exposed for tests and internal reuse.
  _helpers: { str, bool, int, color },
};

module.exports = config;
