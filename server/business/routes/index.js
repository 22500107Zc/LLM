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
const {
  requireActiveSubscription,
  requireActiveSubscriptionForPublic,
} = require("../middleware/billingGate");

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

  // ---- Subscription enforcement ------------------------------------------
  // Attached as path-scoped middleware rather than edited into each upstream
  // chat route, so no upstream endpoint file is touched. When the deployment
  // is not restricted these are a cached no-op.
  //
  // Only AI *usage* is gated. Reading data, administration and billing stay
  // available so an owner can always resolve payment - and nothing is deleted.
  app.use("/workspace/:slug/stream-chat", requireActiveSubscription);
  app.use(
    "/workspace/:slug/thread/:threadSlug/stream-chat",
    requireActiveSubscription
  );
  app.use("/v1/workspace/:slug/chat", requireActiveSubscription);
  app.use("/v1/workspace/:slug/stream-chat", requireActiveSubscription);
  // The developer API's THREAD variants reach ApiChatHandler exactly like the
  // workspace ones. Leaving them out left a restricted deployment able to keep
  // using the model by calling these directly.
  app.use(
    "/v1/workspace/:slug/thread/:threadSlug/chat",
    requireActiveSubscription
  );
  app.use(
    "/v1/workspace/:slug/thread/:threadSlug/stream-chat",
    requireActiveSubscription
  );
  app.use("/v1/openai/chat/completions", requireActiveSubscription);

  // Public website agents get the visitor-safe abort shape instead, so a
  // customer's website never leaks the deployment's billing state.
  app.use("/embed/:embedId/stream-chat", requireActiveSubscriptionForPublic);
}

/**
 * Every path where AI usage is gated.
 *
 * Exported so a test can assert this list still covers every endpoint that
 * reaches a model. A new chat route added upstream without a mount here would
 * otherwise be a silent way to use the product without paying.
 */
const GATED_AI_PATHS = Object.freeze({
  authenticated: Object.freeze([
    "/workspace/:slug/stream-chat",
    "/workspace/:slug/thread/:threadSlug/stream-chat",
    "/v1/workspace/:slug/chat",
    "/v1/workspace/:slug/stream-chat",
    "/v1/workspace/:slug/thread/:threadSlug/chat",
    "/v1/workspace/:slug/thread/:threadSlug/stream-chat",
    "/v1/openai/chat/completions",
  ]),
  public: Object.freeze(["/embed/:embedId/stream-chat"]),
});

module.exports = { businessEndpoints, GATED_AI_PATHS };
