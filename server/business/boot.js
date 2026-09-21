const config = require("./config");

/**
 * Commercial platform boot checks.
 *
 * Runs once at startup and does two things:
 *   1. Refuses to start a production deployment that is obviously unsafe.
 *   2. Warns loudly about configuration that is merely risky.
 *
 * The distinction matters: a hard failure must only ever be something that
 * would expose a paying customer's data, never a missing convenience.
 */

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

/** Secrets that must be strong and must not be left at a known default. */
const WEAK_SECRET_VALUES = new Set([
  "",
  "secret",
  "changeme",
  "change-me",
  "password",
  "my-random-string-for-seeding",
  "my-random-string-for-seeding-encryption",
  "anythingllm",
  "your-jwt-secret",
  "test",
]);

const MIN_SECRET_LENGTH = 24;

function isWeakSecret(value) {
  if (!value) return true;
  const trimmed = String(value).trim();
  if (trimmed.length < MIN_SECRET_LENGTH) return true;
  return WEAK_SECRET_VALUES.has(trimmed.toLowerCase());
}

/**
 * Evaluates the deployment's security posture.
 * Pure - returns findings rather than exiting - so it is testable.
 * @param {object} env
 * @returns {{errors: string[], warnings: string[], notes: string[]}}
 */
function evaluatePosture(env = process.env) {
  const errors = [];
  const warnings = [];
  const notes = [];
  const isProduction = env.NODE_ENV === "production";

  if (!isProduction) {
    notes.push(
      "Running in development mode - production security checks are relaxed."
    );
  }

  // --- Authentication -------------------------------------------------------
  if (isProduction && config.security.requireMultiUser) {
    if (isWeakSecret(env.JWT_SECRET))
      errors.push(
        "JWT_SECRET is missing or too weak. Generate at least 32 random characters."
      );
    if (isWeakSecret(env.SIG_KEY))
      errors.push("SIG_KEY is missing or too weak. Generate a strong random value.");
    if (isWeakSecret(env.SIG_SALT))
      errors.push("SIG_SALT is missing or too weak. Generate a strong random value.");
  }

  // --- Public embed exposure ------------------------------------------------
  if (isProduction && !config.security.requireEmbedAllowlist)
    warnings.push(
      "EMBED_REQUIRE_ALLOWLIST is disabled. A website agent created without a domain allowlist will answer requests from ANY website."
    );

  // --- Dangerous agent capability -------------------------------------------
  if (env.AGENT_ALLOW_SHELL === "true" || env.ALLOW_SHELL_EXECUTION === "true")
    warnings.push(
      "Shell execution is enabled for agents. Disable it unless a specific customer workflow requires it."
    );

  // --- Outbound webhook safety ----------------------------------------------
  if (config.security.allowPrivateNetworkWebhooks)
    warnings.push(
      "ALLOW_PRIVATE_NETWORK_WEBHOOKS is enabled. Customer-configured webhooks can reach internal addresses, including cloud metadata endpoints. Only enable this on an isolated network."
    );

  // --- Billing --------------------------------------------------------------
  const stripe = config.stripe;
  if (stripe.secretKey) {
    if (!stripe.webhookSecret)
      warnings.push(
        "STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is not. Webhooks will be rejected and subscription state will not stay in sync."
      );
    if (!stripe.priceId && !stripe.productId)
      warnings.push(
        "Neither STRIPE_PRICE_ID nor STRIPE_PRODUCT_ID is set. Checkout cannot be started."
      );
    if (isProduction && stripe.secretKey.startsWith("sk_test_"))
      warnings.push(
        "A Stripe TEST key is configured on a production deployment. Real payments will not be collected."
      );
  } else if (isProduction) {
    notes.push(
      "Stripe is not configured. Billing features are disabled and no subscription enforcement will occur."
    );
  }

  // Checked unconditionally: a secret key pasted into the publishable slot
  // would be served to every browser, whether or not the secret slot is set.
  if (stripe.publishableKey && stripe.publishableKey.startsWith("sk_"))
    errors.push(
      "STRIPE_PUBLISHABLE_KEY contains a secret key. Publishable keys start with pk_. Fix this before starting."
    );

  if (config.billingPolicy.enforcementEnabled && !stripe.secretKey)
    errors.push(
      "BILLING_ENFORCEMENT_ENABLED is on but Stripe is not configured. This would restrict the deployment with no way to resolve payment."
    );

  // --- Deployment identity --------------------------------------------------
  if (isProduction && !config.deployment.publicUrl)
    warnings.push(
      "PUBLIC_URL is not set. Checkout return URLs and the website agent snippet will be inferred from request headers."
    );

  return { errors, warnings, notes };
}

/**
 * Runs the boot checks and prints them. Exits the process on a hard failure in
 * production so a misconfigured deployment cannot quietly serve traffic.
 */
function bootCommercialPlatform({ exitOnError = true } = {}) {
  const { errors, warnings, notes } = evaluatePosture();
  const brand = config.branding;

  console.log(
    `${GREEN}[Platform]${RESET} ${brand.appName} v${config.deployment.version}` +
      (config.customer.name ? ` - ${config.customer.name}` : "")
  );

  for (const note of notes) console.log(`${GREEN}[Platform]${RESET} ${note}`);
  for (const warning of warnings)
    console.warn(`${YELLOW}[Platform WARNING]${RESET} ${warning}`);
  for (const error of errors)
    console.error(`${RED}[Platform ERROR]${RESET} ${error}`);

  if (errors.length && exitOnError && process.env.NODE_ENV === "production") {
    console.error(
      `${RED}[Platform]${RESET} Refusing to start with ${errors.length} unsafe configuration error(s). Fix the items above.`
    );
    process.exit(1);
  }

  return { errors, warnings, notes };
}

module.exports = {
  bootCommercialPlatform,
  evaluatePosture,
  isWeakSecret,
  _MIN_SECRET_LENGTH: MIN_SECRET_LENGTH,
};
