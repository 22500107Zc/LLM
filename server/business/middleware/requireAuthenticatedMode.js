const { SystemSettings } = require("../../models/systemSettings");
const config = require("../config");

/**
 * Closes upstream's anonymous-access path for production deployments.
 *
 * Upstream `validatedRequest` intentionally lets requests through when the
 * instance is in single-user mode with no AUTH_TOKEN, which is convenient for
 * local development but means a production deployment reachable on the
 * internet would serve the entire application to anyone.
 *
 * A commercial deployment must be authenticated. This middleware refuses every
 * request in production unless the instance is either:
 *   - in multi-user mode (named accounts, the supported production posture), or
 *   - password protected by an AUTH_TOKEN.
 *
 * A small bootstrap allowlist stays open so a freshly provisioned deployment
 * can still reach the screens that create the first owner account - otherwise
 * the deployment could never be set up.
 */

/**
 * Paths that must remain reachable before authentication exists.
 * Matched against the path *within* the /api router.
 */
const BOOTSTRAP_PATHS = new Set([
  "/ping",
  "/migrate",
  "/setup-complete",
  "/system/check-token",
  "/request-token",
  "/system/logo",
  "/system/multi-user-mode",
  "/system/enable-multi-user",
  "/system/custom-app-name",
  "/system/is-default-llm",
  "/system/welcome-messages",
  "/system/footer-data",
  "/system/support-email",
  "/system/metadata",
  "/request-password-reset",
  "/system/recover-account",
  "/system/reset-password",
]);

function isBootstrapPath(path) {
  if (BOOTSTRAP_PATHS.has(path)) return true;
  // Accepting an invite is how an invited teammate creates their account.
  if (/^\/invite\/[^/]+$/.test(path)) return true;
  if (path.startsWith("/embed/")) return true;
  if (path.startsWith("/platform/")) return true;
  return false;
}

let cachedMultiUser = { value: null, expiresAt: 0 };

/**
 * Only a POSITIVE result is cached.
 *
 * Caching "multi-user mode is off" would keep blocking every request for the
 * life of the cache entry after an operator finishes setup, so a freshly
 * provisioned deployment would appear broken for the first few seconds of its
 * life. A negative answer is re-read each time - one indexed lookup - so the
 * guard opens the instant setup completes.
 */
async function multiUserEnabled() {
  const now = Date.now();
  if (cachedMultiUser.value === true && cachedMultiUser.expiresAt > now)
    return true;

  const value = await SystemSettings.isMultiUserMode();
  cachedMultiUser = value
    ? { value: true, expiresAt: now + 15_000 }
    : { value: null, expiresAt: 0 };
  return value;
}

/** Clears the cache after multi-user mode is turned on during setup. */
function invalidateModeCache() {
  cachedMultiUser = { value: null, expiresAt: 0 };
}

async function requireAuthenticatedMode(request, response, next) {
  // Only enforced in production, and only when the deployment asks for it.
  if (process.env.NODE_ENV !== "production") return next();
  if (!config.security.requireMultiUser) return next();

  const path = request.path ?? "";
  if (isBootstrapPath(path)) return next();

  // A password-protected single-user instance is authenticated; allow it.
  if (process.env.AUTH_TOKEN) return next();

  if (await multiUserEnabled()) return next();

  console.warn(
    `[Platform SECURITY] Blocked unauthenticated request to ${request.method} ${path} - this deployment is not in multi-user mode and has no AUTH_TOKEN.`
  );

  return response.status(401).json({
    error: "authentication_required",
    message:
      "This deployment is not configured for authenticated access. An administrator must complete setup before it can be used.",
  });
}

module.exports = {
  requireAuthenticatedMode,
  invalidateModeCache,
  isBootstrapPath,
  BOOTSTRAP_PATHS,
};
