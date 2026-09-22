const express = require("express");
const { reqBody } = require("../../utils/http");
const { AuditLog } = require("../models/audit");
const { createRateLimiter, safeHandler } = require("../middleware");
const { Customer, ACCESS } = require("../models/customer");
const auth = require("./auth");

/**
 * The founder control plane.
 *
 * WHAT THIS IS
 *
 * One application, one operator, one password. The founder decides who is
 * allowed into the product. A customer is an account in this application - not
 * a container, not a deployment, not another website.
 *
 * THE WORKFLOW IT SERVES
 *
 * Payment happens outside the application: the founder sends a Stripe-hosted
 * Payment Link by email and confirms the money arrived. Then, here, they
 * create the account with the email and password the customer chose. The
 * customer signs in to the same application everyone else uses.
 *
 * If the customer stops paying, the founder disables them. If they resume, the
 * founder restores them. Founder authority is the source of truth.
 *
 * NO STRIPE
 *
 * Nothing in this file imports Stripe, reads a Stripe key, or consults a
 * payment state. An account works because the founder created it and has not
 * disabled it - for no other reason, and the product needs no Stripe
 * credential to let a paying customer in.
 *
 * HOW IT IS SEPARATED
 *
 * Mounted on its own prefix before the customer API router, with its own
 * authentication. A customer's JWT means nothing here: `requireFounder` looks
 * only at the founder cookie and the server-side session store. When the
 * console is not configured, every route answers 404.
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

function founderRoutes(app) {
  if (!app) return;

  const router = express.Router();

  // ------------------------------------------------------------- session --
  /**
   * Whether the console exists here and whether this browser is signed in.
   *
   * Unauthenticated on purpose: the login page needs it. It returns no secret
   * and no hint about the password.
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
        // Useless without the HttpOnly session cookie, which no script can
        // read - and the console needs it to make any change.
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
          // Never says whether the password was close or long enough.
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
      // Attributes must match the cookie that was set or some browsers keep
      // it. The server-side session is gone either way.
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

  // ----------------------------------------------------------- customers --
  router.get(
    "/customers",
    [auth.requireFounder],
    safeHandler(async (_request, response) => {
      const customers = await Customer.list();
      response.status(200).json({
        customers,
        counts: {
          total: customers.length,
          active: customers.filter((c) => c.access === ACCESS.ACTIVE).length,
          disabled: customers.filter((c) => c.access === ACCESS.DISABLED)
            .length,
        },
      });
    })
  );

  router.get(
    "/customers/:id",
    [auth.requireFounder],
    safeHandler(async (request, response) => {
      const customer = await Customer.get(request.params.id);
      if (!customer) return response.status(404).json({ error: "Not found." });
      response.status(200).json({ customer });
    })
  );

  /**
   * Creates a customer account.
   *
   * The founder supplies the login email and the password the customer chose.
   * The password is hashed by the product's own user model and the plaintext
   * is never stored, logged or audited.
   */
  router.post(
    "/customers",
    [auth.requireFounder],
    safeHandler(async (request, response) => {
      const input = body(request);
      const { customer, error } = await Customer.create({
        businessName: input.businessName,
        email: input.email,
        password: input.password,
        contactName: input.contactName,
        notes: input.notes,
        paymentNote: input.paymentNote,
      });

      if (!customer)
        return response.status(400).json({ success: false, error });

      await AuditLog.log({
        action: "founder.customer_created",
        category: AuditLog.CATEGORIES.USERS,
        resource: "customer",
        resourceId: String(customer.id),
        // The email is the account identifier, so it belongs in the trail.
        // The password does not appear here in any form.
        metadata: {
          businessName: customer.businessName,
          loginEmail: customer.loginEmail,
        },
      });

      response.status(201).json({ success: true, customer });
    })
  );

  /** Business information. Credentials and access have their own routes so
   * each is an explicit, separately auditable act. */
  router.put(
    "/customers/:id",
    [auth.requireFounder],
    safeHandler(async (request, response) => {
      const input = body(request);
      const { customer, error } = await Customer.update(request.params.id, {
        businessName: input.businessName,
        contactName: input.contactName,
        notes: input.notes,
        paymentNote: input.paymentNote,
      });
      if (!customer)
        return response
          .status(error === "No such customer." ? 404 : 400)
          .json({ success: false, error });

      await AuditLog.log({
        action: "founder.customer_updated",
        category: AuditLog.CATEGORIES.USERS,
        resource: "customer",
        resourceId: String(customer.id),
      });
      response.status(200).json({ success: true, customer });
    })
  );

  /** Changes the authorized login email. The old address stops working. */
  router.post(
    "/customers/:id/email",
    [auth.requireFounder],
    safeHandler(async (request, response) => {
      const { email = "" } = body(request);
      const { customer, error } = await Customer.setEmail(
        request.params.id,
        email
      );
      if (!customer)
        return response
          .status(error === "No such customer." ? 404 : 400)
          .json({ success: false, error });

      await AuditLog.log({
        action: "founder.customer_email_changed",
        category: AuditLog.CATEGORIES.SECURITY,
        resource: "customer",
        resourceId: String(customer.id),
        metadata: { loginEmail: customer.loginEmail },
      });
      response.status(200).json({ success: true, customer });
    })
  );

  /**
   * Sets a new password.
   *
   * There is no route that reads a password back, and there could not be one:
   * only a bcrypt hash exists and it does not reverse.
   */
  router.post(
    "/customers/:id/password",
    [auth.requireFounder],
    safeHandler(async (request, response) => {
      const { password = "" } = body(request);
      const { customer, error } = await Customer.setPassword(
        request.params.id,
        password
      );
      if (!customer)
        return response
          .status(error === "No such customer." ? 404 : 400)
          .json({ success: false, error });

      await AuditLog.log({
        action: "founder.customer_password_reset",
        category: AuditLog.CATEGORIES.SECURITY,
        resource: "customer",
        resourceId: String(customer.id),
        // No password, no length, no hash.
      });
      response.status(200).json({ success: true, customer });
    })
  );

  /**
   * Turns application access on or off.
   *
   * This is APPLICATION ACCESS, not a billing state. It writes the flag the
   * product's request validation already checks on every authenticated
   * request, so disabling a customer ends their current session too - they do
   * not keep working until their token expires.
   */
  router.post(
    "/customers/:id/access",
    [auth.requireFounder],
    safeHandler(async (request, response) => {
      const { access = "" } = body(request);
      const { customer, error } = await Customer.setAccess(
        request.params.id,
        access
      );
      if (!customer)
        return response
          .status(error === "No such customer." ? 404 : 400)
          .json({ success: false, error });

      await AuditLog.log({
        action:
          customer.access === ACCESS.DISABLED
            ? "founder.customer_disabled"
            : "founder.customer_restored",
        category: AuditLog.CATEGORIES.SECURITY,
        resource: "customer",
        resourceId: String(customer.id),
        metadata: { access: customer.access },
      });
      response.status(200).json({ success: true, customer });
    })
  );

  /**
   * Permanently removes a customer and their login.
   *
   * Destructive and not reversible, so it requires the business name typed
   * back. Disabling is the reversible option and the console says so.
   */
  router.delete(
    "/customers/:id",
    [auth.requireFounder],
    safeHandler(async (request, response) => {
      const { confirmBusinessName = "" } = body(request);
      const existing = await Customer.get(request.params.id);
      if (!existing) return response.status(404).json({ error: "Not found." });

      if (String(confirmBusinessName).trim() !== String(existing.businessName))
        return response.status(400).json({
          success: false,
          error:
            "Type the business name exactly to confirm. Disabling is reversible; this is not.",
        });

      const { success, error } = await Customer.remove(request.params.id);
      if (!success) return response.status(400).json({ success: false, error });

      await AuditLog.log({
        action: "founder.customer_removed",
        category: AuditLog.CATEGORIES.USERS,
        resource: "customer",
        resourceId: String(existing.id),
        metadata: {
          businessName: existing.businessName,
          loginEmail: existing.loginEmail,
        },
      });
      response.status(200).json({ success: true });
    })
  );

  // --------------------------------------------------------- model check --
  /**
   * Is there actually a model behind this deployment?
   *
   * The founder needs to know this before they sell anything, and "the chat
   * box seems to work" is not an answer they can get before a customer
   * exists. This makes one real completion call through whatever provider the
   * deployment is configured with and reports what came back.
   *
   * Founder-only, and it names the provider and model but never the
   * credential. It deliberately does not touch the database, so it answers
   * even on a deployment that has no customers yet.
   */
  router.get(
    "/model-check",
    [auth.requireFounder],
    safeHandler(async (_request, response) => {
      const provider = process.env.LLM_PROVIDER || "openai";

      // Names only, never values. If there is no model, the founder's first
      // question is "why", and the answer is almost always which of these is
      // missing from the deployment.
      //
      // DATABASE_URL is deliberately not in this list. The application gives
      // itself a local SQLite fallback when none is set, so its mere presence
      // means nothing - reporting it as configured would say the deployment
      // has a database when it has a file that disappears.
      const configured = [
        "VERCEL_OIDC_TOKEN",
        "LLM_PROVIDER",
        "GENERIC_OPEN_AI_BASE_PATH",
        "GENERIC_OPEN_AI_MODEL_PREF",
        "GENERIC_OPEN_AI_API_KEY",
        "OPEN_AI_KEY",
        "ANTHROPIC_API_KEY",
      ].filter((key) => String(process.env[key] ?? "").trim().length > 0);

      const url = String(process.env.DATABASE_URL ?? "").trim();
      const database =
        !url || url.startsWith("file:") || url.endsWith(".db")
          ? "not configured - customer accounts cannot be stored"
          : "postgres";
      const model =
        process.env.GENERIC_OPEN_AI_MODEL_PREF ||
        process.env.OPEN_MODEL_PREF ||
        null;

      try {
        const { getLLMProvider } = require("../../utils/helpers");
        const connector = getLLMProvider({});
        const answer = await connector.getChatCompletion(
          [
            {
              role: "user",
              content:
                "Reply with exactly: the assistant is reachable. Nothing else.",
            },
          ],
          { temperature: 0 }
        );

        const text = String(
          answer?.textResponse ?? answer?.content ?? answer ?? ""
        ).trim();

        return response.status(200).json({
          ok: text.length > 0,
          provider,
          model,
          configured,
          database,
          sample: text.slice(0, 200),
        });
      } catch (error) {
        console.error("[founder] model check failed:", error.message);
        return response.status(200).json({
          ok: false,
          provider,
          model,
          configured,
          database,
          // The founder is the one person who should see the real reason.
          reason: String(error.message ?? error).slice(0, 300),
        });
      }
    })
  );

  // ---------------------------------------------------------------- audit --
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

/** Lets a test suite clear the login limiter between cases. Nothing in the
 * running application calls it. */
founderRoutes.resetRateLimit = () => loginLimiter.reset?.();

module.exports = { founderRoutes };
