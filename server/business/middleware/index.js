const config = require("../config");
const { Team } = require("../models/team");
const { AuditLog } = require("../models/audit");

/**
 * Business API middleware.
 *
 * These layer on top of upstream's `validatedRequest`, which has already
 * authenticated the caller. Their job is the business-role authorization the
 * commercial product adds, plus public-surface protection.
 */

// The owner check only needs to run once per process.
let ownerEnsured = null;
function ensureOwnerOnce() {
  if (!ownerEnsured) ownerEnsured = Team.ensureOwner().catch(() => null);
  return ownerEnsured;
}

/**
 * Resolves the caller's business role onto `response.locals` so downstream
 * handlers and audit records can use it. Must run after `validatedRequest`.
 */
async function attachBusinessRole(_request, response, next) {
  try {
    const user = response.locals?.user ?? null;
    if (!user) {
      // Single-user mode has no user record; treat the authenticated operator
      // as the owner so a non-production deployment remains usable.
      response.locals.businessRole = Team.BUSINESS_ROLES.OWNER;
      response.locals.capabilities = Team.capabilitiesFor(
        Team.BUSINESS_ROLES.OWNER
      );
      return next();
    }
    // A deployment must always have exactly one Owner; without this the first
    // admin created by upstream's setup flow could never reach Billing.
    await ensureOwnerOnce();

    const role = await Team.roleFor(user);
    response.locals.businessRole = role;
    response.locals.capabilities = Team.capabilitiesFor(role);
    return next();
  } catch (error) {
    console.error("[Business] role resolution failed:", error.message);
    return response
      .status(500)
      .json({ error: "Unable to resolve permissions." });
  }
}

/**
 * Requires a capability from the business capability matrix.
 * @param {string} capability e.g. "billing:manage"
 */
function requireCapability(capability) {
  return async (request, response, next) => {
    const role = response.locals?.businessRole;
    if (!role) return response.status(403).json({ error: "Forbidden." });
    if (Team.can(role, capability)) return next();

    await AuditLog.fromRequest(request, response, {
      action: "security.permission_denied",
      category: AuditLog.CATEGORIES.SECURITY,
      resource: "capability",
      resourceId: capability,
      metadata: { role, path: request.path, method: request.method },
    });

    return response.status(403).json({
      error: "You do not have permission to perform this action.",
    });
  };
}

/**
 * A fixed-window in-memory rate limiter for public, unauthenticated surfaces.
 *
 * In-memory is the right trade-off here: one business equals one dedicated
 * deployment, so there is no cross-instance state to share, and this adds no
 * dependency or operational surface. A reverse proxy should still rate-limit
 * at the edge for volumetric attacks - this protects the application itself.
 */
function createRateLimiter({
  windowMs = 60_000,
  max = 30,
  keyFn = (request) => request.ip,
  message = "Too many requests. Please slow down and try again shortly.",
} = {}) {
  const buckets = new Map();

  // Periodically drop expired buckets so the map cannot grow unbounded.
  // Unreferenced on purpose: `.unref()` keeps it from holding the process open.
  setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets.entries())
      if (bucket.resetAt <= now) buckets.delete(key);
  }, windowMs).unref?.();

  return function rateLimit(request, response, next) {
    const now = Date.now();
    const key = String(keyFn(request) ?? "unknown");
    let bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    const remaining = Math.max(0, max - bucket.count);
    response.setHeader("X-RateLimit-Limit", String(max));
    response.setHeader("X-RateLimit-Remaining", String(remaining));
    response.setHeader(
      "X-RateLimit-Reset",
      String(Math.ceil(bucket.resetAt / 1000))
    );

    if (bucket.count > max) {
      response.setHeader(
        "Retry-After",
        String(Math.ceil((bucket.resetAt - now) / 1000))
      );
      return response.status(429).json({ error: "rate_limited", message });
    }

    return next();
  };
}

/** Shared limiter for the public lead-capture and escalation endpoints. */
const publicCaptureLimiter = createRateLimiter({
  windowMs: 60_000,
  max: config.security.publicRateLimitPerMinute,
});

/** A tighter limiter for endpoints that create records from anonymous input. */
const publicWriteLimiter = createRateLimiter({
  windowMs: 60_000,
  max: Math.max(3, config.security.publicRateLimitBurst),
});

/**
 * Protects the uptime endpoint. A token may be configured; when it is not, the
 * probe is still safe to expose because it contains no internal detail.
 */
function healthTokenGuard(request, response, next) {
  const expected = config.security.healthCheckToken;
  if (!expected) return next();

  const provided =
    request.headers["x-health-token"] ??
    request.query?.token ??
    (request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");

  // Constant-time comparison so the token cannot be discovered by timing.
  const crypto = require("crypto");
  const a = Buffer.from(String(provided ?? ""));
  const b = Buffer.from(expected);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!ok) return response.sendStatus(401);
  return next();
}

/**
 * Like `healthTokenGuard`, but refuses when no token is configured.
 *
 * `healthTokenGuard` deliberately passes through on an unconfigured
 * deployment so an uptime probe still works during bring-up. That is the wrong
 * default for anything carrying operational state: with no token set, the
 * endpoint would be open. This one answers 404 instead, so an unconfigured
 * deployment looks like it simply has no such route.
 */
function strictHealthTokenGuard(request, response, next) {
  const expected = config.security.healthCheckToken;
  if (!expected) return response.status(404).json({ error: "Not found." });
  return healthTokenGuard(request, response, next);
}

/**
 * Wraps an async route handler so a thrown error becomes a clean 500 with a
 * professional message, while the real detail is logged server-side only.
 */
function safeHandler(handler) {
  return async (request, response, next) => {
    try {
      await handler(request, response, next);
    } catch (error) {
      console.error(
        `[Business API] ${request.method} ${request.originalUrl} failed:`,
        error?.stack ?? error?.message ?? error
      );
      if (response.headersSent) return;
      response.status(500).json({
        error: "Something went wrong on our side. Please try again.",
      });
    }
  };
}

module.exports = {
  attachBusinessRole,
  requireCapability,
  createRateLimiter,
  publicCaptureLimiter,
  publicWriteLimiter,
  healthTokenGuard,
  strictHealthTokenGuard,
  safeHandler,
};
