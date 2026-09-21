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
