const { reqBody } = require("../../utils/http");
const { Analytics } = require("../services/analytics");
const { Conversations } = require("../services/conversations");
const { KnowledgeGaps } = require("../services/knowledgeGaps");
const { AIQuality } = require("../services/aiQuality");
const { requireCapability, safeHandler } = require("../middleware");

/** Conversations, Analytics, Knowledge Gaps and AI Quality. */
function insightRoutes(router) {
  // ------------------------------------------------------- Conversations ----
  router.get(
    "/conversations",
    [requireCapability("conversations:view")],
    safeHandler(async (request, response) => {
      const {
        channel = null,
        search = null,
        days = null,
        reviewed = null,
        escalated = null,
        leads = null,
        limit = 50,
        offset = 0,
      } = request.query;

      const result = await Conversations.list({
        channel,
        search,
        days: days ? Number(days) : null,
        reviewed:
          reviewed === "true" ? true : reviewed === "false" ? false : null,
        escalatedOnly: escalated === "true",
        leadsOnly: leads === "true",
        limit: Number(limit),
        offset: Number(offset),
      });
      response.status(200).json(result);
    })
  );

  router.get(
    "/conversations/export",
    [requireCapability("conversations:view")],
    safeHandler(async (request, response) => {
      const { channel = null, days = null } = request.query;
      const { conversations } = await Conversations.list({
        channel,
        days: days ? Number(days) : null,
        limit: 200,
      });
      response.setHeader("Content-Type", "text/csv; charset=utf-8");
      response.setHeader(
        "Content-Disposition",
        `attachment; filename="conversations-${new Date().toISOString().slice(0, 10)}.csv"`
      );
      response.status(200).send(Conversations.toCSV(conversations));
    })
  );

  router.get(
    "/conversations/:channel/:referenceId",
    [requireCapability("conversations:view")],
    safeHandler(async (request, response) => {
      const conversation = await Conversations.transcript({
        channel: String(request.params.channel),
        referenceId: decodeURIComponent(String(request.params.referenceId)),
      });
      if (!conversation)
        return response.status(404).json({ error: "Conversation not found." });
      response.status(200).json({ conversation });
    })
  );

  router.post(
    "/conversations/:channel/:referenceId/review",
    [requireCapability("conversations:manage")],
    safeHandler(async (request, response) => {
      const { reviewed = true, note = null } = reqBody(request);
      const result = await Conversations.review({
        channel: String(request.params.channel),
        referenceId: decodeURIComponent(String(request.params.referenceId)),
        reviewed,
        note,
        actor: response.locals.user,
      });
      response.status(result.success ? 200 : 400).json(result);
    })
  );

  // ----------------------------------------------------------- Analytics ----
  router.get(
    "/analytics",
    [requireCapability("analytics:view")],
    safeHandler(async (request, response) => {
      const days = Number(request.query.days ?? 30);
      const overview = await Analytics.overview(days);
      response.status(200).json(overview);
    })
  );

  router.get(
    "/dashboard",
    [requireCapability("agents:view")],
    safeHandler(async (_request, response) => {
      const { Billing } = require("../models/billing");
      const { PlatformSettings } = require("../models/platformSettings");
      const { Team } = require("../models/team");

      const [summary, access, onboarding, role] = await Promise.all([
        Analytics.dashboard(),
        Billing.currentAccess(),
        PlatformSettings.onboardingState(),
        Promise.resolve(response.locals.businessRole),
      ]);

      response.status(200).json({
        metrics: summary,
        // Only an owner sees billing state on the dashboard.
        billing: Team.can(role, "billing:view")
          ? {
              status: access.status,
              statusLabel: access.statusLabel,
              access: access.access,
              message: access.message,
              graceDaysRemaining: access.graceDaysRemaining,
            }
          : null,
        onboarding,
      });
    })
  );

  // ----------------------------------------------------- Knowledge gaps ----
  router.get(
    "/knowledge-gaps",
    [requireCapability("knowledge:view")],
    safeHandler(async (request, response) => {
      const { status = "open", limit = 100, offset = 0 } = request.query;
      const clause =
        status && status !== "all" ? { status: String(status) } : {};

      const [gaps, total] = await Promise.all([
        KnowledgeGaps.where(clause, limit, offset),
        KnowledgeGaps.count(clause),
      ]);

      const agents =
        await require("../../utils/prisma").agent_profiles.findMany({
          select: { id: true, name: true, uuid: true },
        });
      const byId = new Map(agents.map((a) => [a.id, a]));

      response.status(200).json({
        gaps: gaps.map((gap) => ({
          ...gap,
          reasons: (() => {
            try {
              return JSON.parse(gap.reasons || "[]");
            } catch {
              return [];
            }
          })(),
          agentName: byId.get(gap.agent_profile_id)?.name ?? null,
        })),
        total,
        statuses: KnowledgeGaps.STATUSES,
      });
    })
  );

  router.post(
    "/knowledge-gaps/:id",
    [requireCapability("knowledge:manage")],
    safeHandler(async (request, response) => {
      const { status = null, note = null } = reqBody(request);
      const result = await KnowledgeGaps.update({
        id: Number(request.params.id),
        status,
        note,
        actor: response.locals.user,
      });
      response.status(result.success ? 200 : 400).json(result);
    })
  );

  // ---------------------------------------------------------- AI Quality ----
  router.get(
    "/quality/tests",
    [requireCapability("quality:view")],
    safeHandler(async (_request, response) => {
      const tests = await AIQuality.tests({});
      const prisma = require("../../utils/prisma");
      const agents = await prisma.agent_profiles.findMany({
        select: { id: true, uuid: true, name: true },
      });
      const byId = new Map(agents.map((a) => [a.id, a]));

      response.status(200).json({
        tests: tests.map((test) => ({
          uuid: test.uuid,
          question: test.question,
          expectedAnswer: test.expected_answer,
          expectedConcepts: AIQuality.parseConcepts(test.expected_concepts),
          requiredSource: test.required_source,
          enabled: test.enabled,
          agent: byId.get(test.agent_profile_id)
            ? {
                uuid: byId.get(test.agent_profile_id).uuid,
                name: byId.get(test.agent_profile_id).name,
              }
            : null,
          createdAt: test.createdAt,
        })),
      });
    })
  );

  router.post(
    "/quality/tests",
    [requireCapability("quality:manage")],
    safeHandler(async (request, response) => {
      const body = reqBody(request);
      let agentProfileId = null;
      if (body.agentUuid) {
        const prisma = require("../../utils/prisma");
        const agent = await prisma.agent_profiles.findUnique({
          where: { uuid: String(body.agentUuid) },
        });
        agentProfileId = agent?.id ?? null;
      }

      const result = await AIQuality.createTest({
        ...body,
        agentProfileId,
        actor: response.locals.user,
      });
      if (!result.test)
        return response.status(400).json({ error: result.error });
      response.status(200).json({ test: result.test });
    })
  );

  router.post(
    "/quality/tests/:uuid",
    [requireCapability("quality:manage")],
    safeHandler(async (request, response) => {
      const result = await AIQuality.updateTest({
        uuid: String(request.params.uuid),
        patch: reqBody(request),
        actor: response.locals.user,
      });
      response.status(result.success ? 200 : 400).json(result);
    })
  );

  router.delete(
    "/quality/tests/:uuid",
    [requireCapability("quality:manage")],
    safeHandler(async (request, response) => {
      const result = await AIQuality.deleteTest({
        uuid: String(request.params.uuid),
        actor: response.locals.user,
      });
      response.status(result.success ? 200 : 400).json(result);
    })
  );

  router.post(
    "/quality/run",
    [requireCapability("quality:manage")],
    safeHandler(async (request, response) => {
      const { testUuids = null } = reqBody(request);
      // Runs inline: a suite is a handful of questions, and the operator is
      // waiting on the result. Long suites still return via the runs list.
      const run = await AIQuality.runSuite({
        actor: response.locals.user,
        testUuids,
      });
      response.status(200).json({ run });
    })
  );

  router.get(
    "/quality/runs",
    [requireCapability("quality:view")],
    safeHandler(async (_request, response) => {
      response.status(200).json({ runs: await AIQuality.runs(20) });
    })
  );

  router.get(
    "/quality/runs/:uuid",
    [requireCapability("quality:view")],
    safeHandler(async (request, response) => {
      const result = await AIQuality.runResults(String(request.params.uuid));
      if (!result.run)
        return response.status(404).json({ error: "Run not found." });
      response.status(200).json(result);
    })
  );
}

module.exports = { insightRoutes };
