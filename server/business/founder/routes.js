const express = require("express");
const { reqBody } = require("../../utils/http");
const { AuditLog } = require("../models/audit");
const { createRateLimiter, safeHandler } = require("../middleware");
const provisioning = require("../services/provisioning");
const { buildPaymentLink } = require("../billing/service");
const { readStatus } = require("./deploymentStatus");
const auth = require("./auth");

/**
 * The founder control plane.
 *
 * WHAT THIS IS
 *
 * One operator, one password, a list of the businesses they run, and the four
 * things they actually need to do: provision a new one, hand it the right
 * Stripe Payment Link, see whether it has paid, and see the payments that
 * could not be matched.
 *
 * WHAT IT DELIBERATELY IS NOT
 *
 * It is not a tenant admin panel: it never reads a customer's conversations,
 * documents or users. It is not a remote shell: the only privileged operation
 * in the whole platform - starting a container - stays in the operator CLI,
 * and this returns the exact command rather than running it. It is not a way
 * around the billing gate: nothing here can mark a deployment paid. Only the
 * Stripe webhook does that, and only from an event it can prove belongs to
 * that deployment.
 *
 * HOW IT IS SEPARATED
 *
 * Mounted on its own prefix, before the customer API router, with its own
 * authentication. A customer's JWT means nothing here: `requireFounder` looks
 * only at the founder cookie and the server-side session store. And when the
 * console is not configured on this host, every route answers 404, so a
 * customer's own deployment does not even admit these paths exist.
 */

/** Login is the one unauthenticated write. Limited hard, on top of the
 * per-address lockout inside the auth module. */
const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: "Too many login attempts. Please wait and try again.",
});

/** A request body that is missing or not JSON is a bad request, not a crash. */
function body(request) {
  try {
    return reqBody(request) ?? {};
  } catch {
    return {};
  }
}

/** Serializes a deployment row for the console. Presence flags only - no
 * secret, and never the deployment identifier itself. */
function publicRow(row) {
  return {
    slug: row.slug,
    name: row.name,
    domain: row.domain,
    port: row.port,
    project: row.project,
    provisionedAt: row.provisionedAt,
    hasDeploymentId: row.hasDeploymentId,
    paymentLinkConfigured: row.paymentLinkConfigured,
    stripeConfigured: row.stripeConfigured,
    providerConfigured: row.providerConfigured,
    awaitingActivation: row.awaitingActivation,
    enforcementEnabled: row.enforcementEnabled,
  };
}

function founderRoutes(app) {
  if (!app) return;

  const router = express.Router();

  // ------------------------------------------------------------- session --
  /**
   * Whether the console exists here and whether this browser is signed in.
   *
   * Unauthenticated on purpose: the login page needs it. It returns no secret,
   * no hint about the password, and no deployment data.
   */
  router.get(
    "/session",
    safeHandler(async (request, response) => {
      const state = auth.availability();
      if (!state.available)
        return response.status(200).json({
          available: false,
          reason: state.reason,
          authenticated: false,
        });

      const session = auth.sessionFrom(request);
      response.status(200).json({
        available: true,
        authenticated: !!session,
        // The CSRF token is not a credential on its own - it is useless
        // without the HttpOnly session cookie - and the console needs it to
        // make any change.
        csrfToken: session?.csrf ?? null,
        expiresAt: session ? new Date(session.expiresAt).toISOString() : null,
      });
    })
  );

  router.post(
    "/login",
    [loginLimiter],
    safeHandler(async (request, response) => {
      const { password = "" } = body(request);
      const result = await auth.authenticate(request, password);

      if (!result.ok)
        return response.status(result.retryAfterMs ? 429 : 401).json({
          success: false,
          // Never says whether the password was close, long enough, or
          // whether a hash is even configured beyond "not enabled".
          error: result.error,
        });

      response.cookie(
        auth.COOKIE_NAME,
        result.session.token,
        auth.cookieOptions()
      );
      response.status(200).json({
        success: true,
        csrfToken: result.session.csrf,
        expiresAt: new Date(result.session.expiresAt).toISOString(),
      });
    })
  );

  router.post(
    "/logout",
    [auth.requireFounder],
    safeHandler(async (_request, response) => {
      const session = response.locals.founderSession;
      auth.destroySession(session?.token);
      // The attributes have to match the cookie that was set, or some browsers
      // keep it. The server-side session is gone either way, which is the
      // control - this just stops a dead cookie being sent back.
      const { maxAge: _ignored, ...attributes } = auth.cookieOptions();
      response.clearCookie(auth.COOKIE_NAME, attributes);
      await AuditLog.log({
        action: "founder.logout",
        category: AuditLog.CATEGORIES.SECURITY,
        resource: "founder_session",
      });
      response.status(200).json({ success: true });
    })
  );

  // --------------------------------------------------------- deployments --
  router.get(
    "/deployments",
    [auth.requireFounder],
    safeHandler(async (_request, response) => {
      const deployments = provisioning.listDeployments().map(publicRow);
      response.status(200).json({
        deployments,
        stateDir: provisioning.stateDir(),
      });
    })
  );

  /**
   * One deployment, with its live state read over loopback.
   *
   * The configuration comes off disk; whether it is running, whether it has
   * paid, and which payments could not be matched come from the deployment
   * itself. A deployment that is not running is a normal answer, not an error.
   */
  router.get(
    "/deployments/:slug",
    [auth.requireFounder],
    safeHandler(async (request, response) => {
      const slug = String(request.params.slug ?? "");
      const row = provisioning.getDeployment(slug);
      if (!row) return response.status(404).json({ error: "Not found." });

      const live = await readStatus(slug);
      response.status(200).json({
        deployment: publicRow(row),
        live,
        // The operator runs this on the host; the console never does.
        nextCommand: `./scripts/operator.sh status ${row.slug}`,
      });
    })
  );

  /**
   * Provisions a new business.
   *
   * This writes configuration and nothing else: no process is spawned, no
   * shell is interpolated, nothing talks to Docker. Starting the container is
   * a privileged host operation and stays with the operator CLI, so the
   * response carries the exact command to run rather than running it.
   */
  router.post(
    "/deployments",
    [auth.requireFounder],
    safeHandler(async (request, response) => {
      const input = body(request);
      const result = provisioning.provision({
        slug: input.slug,
        name: input.name,
        domain: input.domain,
        port: input.port,
        paymentLink: input.paymentLink,
      });

      if (!result.success) {
        await AuditLog.log({
          action: "founder.provision_refused",
          category: AuditLog.CATEGORIES.SETTINGS,
          resource: "deployment",
          resourceId: String(input.slug ?? "").slice(0, 64),
          metadata: { problems: result.problems ?? [] },
        });
        return response
          .status(400)
          .json({ success: false, problems: result.problems ?? [] });
      }

      await AuditLog.log({
        action: "founder.provisioned_deployment",
        category: AuditLog.CATEGORIES.SETTINGS,
        resource: "deployment",
        resourceId: result.deployment.slug,
        metadata: {
          domain: result.deployment.domain,
          port: result.deployment.port,
          // Recorded so the trail shows the new business could not serve AI
          // until a payment activated it.
          awaitingActivation: result.deployment.awaitingActivation,
        },
      });

      response.status(201).json({
        success: true,
        deployment: publicRow(result.deployment),
        nextCommand: result.nextCommand,
      });
    })
  );

  // -------------------------------------------------------- payment link --
  /**
   * The Stripe-hosted Payment Link for this business, bound to it.
   *
   * Built from that deployment's own configured link and its DEPLOYMENT_ID, so
   * the `client_reference_id` is the one its webhook will match on. Handing a
   * customer a link without it is how a payment ends up unmatched, which is
   * exactly the failure this console exists to make visible.
   */
  router.get(
    "/deployments/:slug/payment-link",
    [auth.requireFounder],
    safeHandler(async (request, response) => {
      const slug = String(request.params.slug ?? "");
      const row = provisioning.getDeployment(slug);
      if (!row) return response.status(404).json({ error: "Not found." });

      const result = buildPaymentLink({
        configuredLink: provisioning.envValue(slug, "STRIPE_PAYMENT_LINK"),
        deploymentId: provisioning.envValue(slug, "DEPLOYMENT_ID"),
        email: request.query.email ? String(request.query.email) : "",
      });

      if (result.success)
        await AuditLog.log({
          action: "founder.payment_link_viewed",
          category: AuditLog.CATEGORIES.BILLING,
          resource: "deployment",
          resourceId: slug,
        });

      response.status(result.success ? 200 : 400).json(result);
    })
  );

  /** Records the Stripe-hosted Payment Link the operator created in Stripe. */
  router.post(
    "/deployments/:slug/payment-link",
    [auth.requireFounder],
    safeHandler(async (request, response) => {
      const slug = String(request.params.slug ?? "");
      const row = provisioning.getDeployment(slug);
      if (!row) return response.status(404).json({ error: "Not found." });

      const { paymentLink = "" } = body(request);
      const result = provisioning.setPaymentLink(slug, paymentLink);
      if (!result.success)
        return response
          .status(400)
          .json({ success: false, error: result.error });

      await AuditLog.log({
        action: "founder.payment_link_updated",
        category: AuditLog.CATEGORIES.BILLING,
        resource: "deployment",
        resourceId: slug,
      });

      response.status(200).json({
        success: true,
        // The running container reads its env at boot, so the change is not
        // live until it is restarted. Saying so beats a link that silently
        // does not apply.
        nextCommand: `./scripts/operator.sh update ${slug}`,
      });
    })
  );

  // ------------------------------------------------------ payment events --
  /**
   * Payment events that need a human, for one deployment.
   *
   * Inspection only. Nothing here can bind a payment to a deployment: an
   * unmatched event is a question for the operator to answer in Stripe, and
   * rebinding it from a web form is exactly the kind of automation that could
   * activate the wrong business.
   */
  router.get(
    "/deployments/:slug/events",
    [auth.requireFounder],
    safeHandler(async (request, response) => {
      const slug = String(request.params.slug ?? "");
      if (!provisioning.getDeployment(slug))
        return response.status(404).json({ error: "Not found." });

      const live = await readStatus(slug);
      if (!live.status)
        return response.status(200).json({
          reachable: live.reachable,
          reason: live.reason,
          events: null,
        });

      response.status(200).json({
        reachable: true,
        events: live.status.events,
        // Stated plainly so the console never implies it can fix one.
        resolution:
          "Unmatched events are inspected here and resolved in Stripe. Nothing in this console can activate a deployment.",
      });
    })
  );

  // ----------------------------------------------------------- audit ------
  /** What the founder has done, from the existing audit trail. */
  router.get(
    "/audit",
    [auth.requireFounder],
    safeHandler(async (request, response) => {
      const limit = Math.min(Number(request.query.limit) || 50, 200);
      const entries = await AuditLog.where(
        { action: { startsWith: "founder." } },
        limit
      );
      response.status(200).json({
        entries: entries.map((entry) => ({
          action: entry.action,
          category: entry.category,
          resource: entry.resource,
          resourceId: entry.resource_id,
          metadata: entry.metadata,
          occurredAt: entry.occurredAt,
        })),
      });
    })
  );

  app.use("/api/founder", router);
}

module.exports = { founderRoutes };
