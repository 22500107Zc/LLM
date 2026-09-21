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
  app.use("/v1/openai/chat/completions", requireActiveSubscription);

  // Public website agents get the visitor-safe abort shape instead, so a
  // customer's website never leaks the deployment's billing state.
  app.use("/embed/:embedId/stream-chat", requireActiveSubscriptionForPublic);
}

module.exports = { businessEndpoints };
