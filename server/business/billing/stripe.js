const config = require("../config");

/**
 * Lazily-constructed Stripe client.
 *
 * The platform must boot and stay usable when Stripe is not yet configured -
 * a deployment is often provisioned before its billing identifiers exist - so
 * every consumer checks `isConfigured()` before reaching for the client.
 */

let cachedClient = null;
let cachedKey = null;

function isConfigured() {
  return Boolean(config.stripe.secretKey);
}

/**
 * @returns {import("stripe").Stripe|null}
 */
function client() {
  const { secretKey, apiVersion } = config.stripe;
  if (!secretKey) return null;
  if (cachedClient && cachedKey === secretKey) return cachedClient;

  let Stripe;
  try {
    Stripe = require("stripe");
  } catch {
    console.error(
      "[Billing] The `stripe` package is not installed - billing is disabled."
    );
    return null;
  }

  cachedClient = new Stripe(secretKey, {
    apiVersion,
    maxNetworkRetries: 2,
    timeout: 20_000,
    appInfo: {
      name: config.branding.appName,
      version: config.deployment.version,
    },
  });
  cachedKey = secretKey;
  return cachedClient;
}

/**
 * Describes how billing is configured without ever revealing a secret.
 * Safe to return to an authenticated owner/admin.
 */
function configurationStatus() {
  const stripe = config.stripe;
  return {
    configured: isConfigured(),
    hasPriceId: Boolean(stripe.priceId),
    hasProductId: Boolean(stripe.productId),
    hasWebhookSecret: Boolean(stripe.webhookSecret),
    hasPortalConfiguration: Boolean(stripe.portalConfigurationId),
    publishableKey: stripe.publishableKey || null,
    livemode: stripe.secretKey.startsWith("sk_live_"),
  };
}

/** Clears the memoized client. Used by tests and after a config reload. */
function _reset() {
  cachedClient = null;
  cachedKey = null;
}

module.exports = { client, isConfigured, configurationStatus, _reset };
