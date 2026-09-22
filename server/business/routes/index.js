const express = require("express");
const { validatedRequest } = require("../../utils/middleware/validatedRequest");
const { attachBusinessRole, publicCaptureLimiter } = require("../middleware");
const { billingRoutes } = require("./billing");
const { agentRoutes } = require("./agents");
const { leadRoutes } = require("./leads");
const { insightRoutes } = require("./insights");
const { teamRoutes } = require("./team");
const { integrationRoutes } = require("./integrations");
const { platformRoutes } = require("./platform");
const { publicCaptureRoutes } = require("./publicCapture");
const { knowledgeRoutes } = require("./knowledge");
const { valueRoutes } = require("./value");
const { aiConnectionRoutes } = require("./aiConnection");

/**
 * Mounts the commercial business API.
 *
 * Three surfaces with deliberately different protection:
 *   /api/business/*       - authenticated, business-role authorized
 *   /api/platform/*       - unauthenticated but information-free (branding,
 *                           uptime probe)
 *   /api/embed/:id/...    - public visitor capture, origin-checked + rate
 *                           limited
 */
function businessEndpoints(app) {
  if (!app) return;

  // ---- Authenticated business API ----------------------------------------
  const businessRouter = express.Router();
  businessRouter.use(validatedRequest);
  businessRouter.use(attachBusinessRole);

  billingRoutes(businessRouter);
  agentRoutes(businessRouter);
  knowledgeRoutes(businessRouter);
  leadRoutes(businessRouter);
  insightRoutes(businessRouter);
  teamRoutes(businessRouter);
  integrationRoutes(businessRouter);
  valueRoutes(businessRouter);
  aiConnectionRoutes(businessRouter);

  // ---- Unauthenticated platform surface ----------------------------------
  const publicRouter = express.Router();
  publicRouter.use(publicCaptureLimiter);

  // platformRoutes needs both: settings/audit/health are authenticated while
  // branding and the uptime probe are not.
  platformRoutes(businessRouter, publicRouter);

  app.use("/business", businessRouter);
  app.use("/platform", publicRouter);

  // ---- Public visitor capture (mounted alongside upstream's embed API) ----
  publicCaptureRoutes(app);

  // ---- Application access -------------------------------------------------
  //
  // There is deliberately NO subscription gate on any AI path.
  //
  // Access to this product is decided by the founder, not by a payment
  // processor. The founder confirms payment outside the application, creates
  // the customer's account, and disables it if they stop paying. Stripe never
  // sees an authorization decision, and the application needs no Stripe
  // credential to let a paying customer in.
  //
  // Enforcement is the inherited request validation in
  // utils/middleware/validatedRequest.js, which re-reads the user from the
  // database on EVERY authenticated request and refuses a suspended one with
  // 401. That is why disabling a customer ends their current session rather
  // than lasting until their token expires - and why there is nothing here to
  // bypass by calling an endpoint directly.
}

/**
 * Every endpoint that reaches a model.
 *
 * Exported so a test can assert each one is accounted for. Access to all of
 * them is decided by founder authorization - `validatedRequest` refuses a
 * suspended customer on every request - so what this list guards is that a new
 * upstream chat route cannot appear unnoticed and end up reachable without a
 * customer session at all.
 *
 * `public` is the one deliberate exception: the website embed widget serves a
 * customer's own visitors, who have no account by design.
 */
const AI_ENDPOINTS = Object.freeze({
  authenticated: Object.freeze([
    "/workspace/:slug/stream-chat",
    "/workspace/:slug/thread/:threadSlug/stream-chat",
    "/v1/workspace/:slug/chat",
    "/v1/workspace/:slug/stream-chat",
    "/v1/workspace/:slug/thread/:threadSlug/chat",
    "/v1/workspace/:slug/thread/:threadSlug/stream-chat",
    "/v1/openai/chat/completions",
    // The customer testing their OWN connection with their OWN credential.
    "/business/ai-connection/test",
  ]),
  public: Object.freeze(["/embed/:embedId/stream-chat"]),
});

module.exports = { businessEndpoints, AI_ENDPOINTS };
