const { reqBody } = require("../../utils/http");
const config = require("../config");
const { PlatformSettings } = require("../models/platformSettings");
const { AuditLog } = require("../models/audit");
const { Health } = require("../services/health");
const { Team } = require("../models/team");
const {
  requireCapability,
  safeHandler,
  healthTokenGuard,
  strictHealthTokenGuard,
} = require("../middleware");
const { currentAccess } = require("../middleware/billingGate");

/** Branding, settings, onboarding, audit log and health. */
function platformRoutes(router, publicRouter) {
  // ------------------------------------------------------------- Branding --
  /**
   * Browser-safe brand configuration. Unauthenticated because the login screen
   * needs it before a session exists. Contains no secret and no customer data
   * beyond the public brand identity.
   */
  publicRouter.get(
    "/branding",
    safeHandler(async (_request, response) => {
      response.status(200).json(config.publicConfig());
    })
  );

  // ------------------------------------------------------------- Settings --
  router.get(
    "/settings",
    [requireCapability("settings:manage")],
    safeHandler(async (_request, response) => {
      response.status(200).json({
        company: await PlatformSettings.companyProfile(),
        branding: config.publicConfig().branding,
        limits: config.limits,
        modelDefaults: config.modelDefaults,
        deployment: {
          environment: config.deployment.environment,
          version: config.deployment.version,
          publicUrl: config.deployment.publicUrl || null,
        },
      });
    })
  );

  router.post(
    "/settings/company",
    [requireCapability("settings:manage")],
    safeHandler(async (request, response) => {
      const body = reqBody(request);
      const fields = [
        [PlatformSettings.KEYS.COMPANY_NAME, body.name],
        [PlatformSettings.KEYS.COMPANY_WEBSITE, body.website],
        [PlatformSettings.KEYS.COMPANY_INDUSTRY, body.industry],
        [PlatformSettings.KEYS.COMPANY_DESCRIPTION, body.description],
        [PlatformSettings.KEYS.SUPPORT_EMAIL, body.supportEmail],
      ];

      for (const [key, value] of fields)
        if (value !== undefined)
          await PlatformSettings.set(key, String(value ?? "").slice(0, 2_000), {
            audit: false,
          });

      await AuditLog.fromRequest(request, response, {
        action: "settings.company_updated",
        category: AuditLog.CATEGORIES.SETTINGS,
        resource: "company_profile",
        metadata: { fields: fields.map(([key]) => key) },
      });

      response
        .status(200)
        .json({ company: await PlatformSettings.companyProfile() });
    })
  );

  // ----------------------------------------------------------- Onboarding --
  router.get(
    "/onboarding",
    [requireCapability("agents:view")],
    safeHandler(async (_request, response) => {
      response.status(200).json(await PlatformSettings.onboardingState());
    })
  );

  router.post(
    "/onboarding/:step",
    [requireCapability("settings:manage")],
    safeHandler(async (request, response) => {
      const { complete = true } = reqBody(request);
      const result = await PlatformSettings.markOnboardingStep({
        step: String(request.params.step),
        complete,
        actor: response.locals.user,
      });
      response.status(result.success ? 200 : 400).json(result);
    })
  );

  // ------------------------------------------------------------ Audit log --
  router.get(
    "/audit",
    [requireCapability("audit:view")],
    safeHandler(async (request, response) => {
      const {
        category = null,
        action = null,
        limit = 100,
        offset = 0,
        days = null,
      } = request.query;

      const clause = {};
      if (category && category !== "all") clause.category = String(category);
      if (action) clause.action = { contains: String(action) };
      if (days)
        clause.occurredAt = {
          gte: new Date(Date.now() - Number(days) * 86_400_000),
        };

      const [entries, total] = await Promise.all([
        AuditLog.where(clause, limit, offset),
        AuditLog.count(clause),
      ]);

      // Resolve actor names without exposing any other user attribute.
      const prisma = require("../../utils/prisma");
      const actorIds = [
        ...new Set(entries.map((e) => e.actor_id).filter(Boolean)),
      ];
      const users = actorIds.length
        ? await prisma.users.findMany({
            where: { id: { in: actorIds } },
            select: { id: true, username: true },
          })
        : [];
      const byId = new Map(users.map((u) => [u.id, u.username]));

      response.status(200).json({
        entries: entries.map((entry) => ({
          id: entry.id,
          action: entry.action,
          category: entry.category,
          actor: entry.actor_label ?? byId.get(entry.actor_id) ?? "system",
          resource: entry.resource,
          resourceId: entry.resource_id,
          metadata: (() => {
            try {
              return entry.metadata ? JSON.parse(entry.metadata) : null;
            } catch {
              return null;
            }
          })(),
          ipAddress: entry.ip_address,
          occurredAt: entry.occurredAt,
        })),
        total,
        categories: Object.values(AuditLog.CATEGORIES),
      });
    })
  );

  // ---------------------------------------------------------------- Health --
  router.get(
    "/health",
    [requireCapability("health:view")],
    safeHandler(async (_request, response) => {
      response.status(200).json(await Health.report());
    })
  );

  /**
   * External uptime probe. Deliberately mounted outside the authenticated
   * router and protected by an optional shared token.
   */
  publicRouter.get(
    "/health/probe",
    [healthTokenGuard],
    safeHandler(async (_request, response) => {
      const probe = await Health.probe();
      response.status(probe.status === "ok" ? 200 : 503).json(probe);
    })
  );

  /**
   * Operational status for the operator's control plane.
   *
   * The founder console runs on the host that provisioned this deployment. It
   * reaches this over loopback using the HEALTHCHECK_TOKEN provisioning wrote
   * into this deployment's own env file, so no new credential is introduced -
   * the operator already holds that one.
   *
   * What comes back is deliberately narrow: subscription state, readiness, and
   * the payment events that need a human. No Stripe key, no webhook signing
   * secret, no customer data, no conversation content. The deployment
   * identifier is returned only as a short fingerprint, enough for the console
   * to confirm the running container matches the configuration it holds.
   *
   * Unlike the uptime probe, this refuses entirely when no token is set.
   */
  publicRouter.get(
    "/operator-status",
    [strictHealthTokenGuard],
    safeHandler(async (_request, response) => {
      const prisma = require("../../utils/prisma");
      const { Billing } = require("../models/billing");

      const summary = await Billing.publicSummary();
      const access = await currentAccess();

      let counts = {};
      let events = [];
      try {
        const grouped = await prisma.billing_events.groupBy({
          by: ["status"],
          _count: { status: true },
        });
        counts = Object.fromEntries(
          grouped.map((row) => [row.status, row._count.status])
        );
        events = await prisma.billing_events.findMany({
          where: { status: { in: ["unmatched", "rejected", "failed"] } },
          orderBy: { id: "desc" },
          take: 20,
        });
      } catch {
        // A deployment that has never received a webhook is not an error.
        counts = {};
        events = [];
      }

      const deploymentId = config.deploymentId;

      response.status(200).json({
        probe: await Health.probe(),
        deployment: {
          // Not the identifier itself - only enough to confirm a match.
          idFingerprint: deploymentId ? deploymentId.slice(0, 8) : null,
          publicUrl: config.deployment.publicUrl || null,
          version: config.deployment.version,
        },
        billing: {
          status: summary.subscription.status,
          statusLabel: summary.subscription.statusLabel,
          access: access.access,
          reason: access.reason,
          enforcementEnabled: access.enforcementEnabled,
          cancelAtPeriodEnd: summary.subscription.cancelAtPeriodEnd,
          nextBillingDate: summary.subscription.nextBillingDate,
          customerId: summary.subscription.customerId,
          subscriptionId: summary.subscription.subscriptionId,
          amountCents: summary.plan.amountCents,
          currency: summary.plan.currency,
        },
        events: {
          counts,
          needsAttention: events.length,
          recent: events.map((event) => ({
            stripeEventId: event.stripe_event_id,
            type: event.type,
            status: event.status,
            summary: event.summary,
            occurredAt: event.occurredAt,
          })),
        },
      });
    })
  );

  /**
   * Billing banner state. Every authenticated user can read this so the UI can
   * warn about an impending interruption, but only the status is exposed.
   */
  router.get(
    "/billing-state",
    safeHandler(async (_request, response) => {
      const access = await currentAccess();
      const canSeeDetail = Team.can(
        response.locals.businessRole,
        "billing:view"
      );
      response.status(200).json({
        access: access.access,
        status: canSeeDetail ? access.status : null,
        statusLabel: canSeeDetail ? access.statusLabel : null,
        message: access.message,
        graceEndsAt: access.graceEndsAt,
        graceDaysRemaining: access.graceDaysRemaining,
        enforcementEnabled: access.enforcementEnabled,
      });
    })
  );
}

module.exports = { platformRoutes };
