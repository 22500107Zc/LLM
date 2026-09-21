const config = require("../config");
const { Billing, ACCESS } = require("../models/billing");

/**
 * Subscription enforcement.
 *
 * Restriction is deliberately narrow: it suspends AI *usage* while leaving the
 * deployment fully readable and administrable so an owner can always log in,
 * see their data and fix billing. Nothing is ever deleted here.
 */

// Access state is read on nearly every request, so it is cached briefly.
const CACHE_TTL_MS = 30_000;
let cache = { value: null, expiresAt: 0 };

async function currentAccess({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.value && cache.expiresAt > now) return cache.value;
  const value = await Billing.currentAccess();
  cache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

/** Invalidated whenever billing state changes so the UI reacts immediately. */
function invalidateAccessCache() {
  cache = { value: null, expiresAt: 0 };
}

function restrictedPayload(access) {
  return {
    error: "subscription_restricted",
    message:
      access.message ??
      "AI usage is suspended for this deployment. Your data is retained. Please resolve billing to restore service.",
    billing: {
      status: access.status,
      statusLabel: access.statusLabel,
      access: access.access,
      reason: access.reason,
    },
  };
}

/**
 * Blocks authenticated AI usage (internal chat, agents) when restricted.
 * Administrative, billing and read-only routes are never gated by this.
 */
async function requireActiveSubscription(_request, response, next) {
  const policy = config.billingPolicy;
  if (!policy.enforcementEnabled || !policy.restrictInternalChat) return next();

  const access = await currentAccess();
  if (access.access !== ACCESS.RESTRICTED) return next();

  return response.status(402).json(restrictedPayload(access));
}

/**
 * Blocks public website agents when restricted. Returns the embed widget's
 * own abort shape so a visitor sees a clean message rather than a raw error.
 */
async function requireActiveSubscriptionForPublic(_request, response, next) {
  const policy = config.billingPolicy;
  if (!policy.enforcementEnabled || !policy.restrictPublicAgents) return next();

  const access = await currentAccess();
  if (access.access !== ACCESS.RESTRICTED) return next();

  const { v4: uuidv4 } = require("uuid");
  return response.status(503).json({
    id: uuidv4(),
    type: "abort",
    textResponse: null,
    sources: [],
    close: true,
    // Deliberately generic - a website visitor must never see billing detail.
    error: "This assistant is temporarily unavailable. Please try again later.",
  });
}

/** Used by the scheduled-automation runner. */
async function automationsPermitted() {
  const policy = config.billingPolicy;
  if (!policy.enforcementEnabled || !policy.restrictAutomations) return true;
  const access = await currentAccess();
  return access.access !== ACCESS.RESTRICTED;
}

module.exports = {
  currentAccess,
  invalidateAccessCache,
  requireActiveSubscription,
  requireActiveSubscriptionForPublic,
  automationsPermitted,
  ACCESS,
};
