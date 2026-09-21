const { reqBody } = require("../../utils/http");
const { Integration } = require("../models/integration");
const { requireCapability, safeHandler } = require("../middleware");
const notifier = require("../services/notifier");

function integrationRoutes(router) {
  router.get(
    "/integrations",
    [requireCapability("integrations:view")],
    safeHandler(async (_request, response) => {
      const integrations = await Integration.where({});
      response.status(200).json({
        integrations: integrations.map((i) => Integration.toPublic(i)),
        catalogue: Integration.catalogue(),
        events: Integration.EVENTS,
        emailAvailable: notifier.smtpConfigured(),
      });
    })
  );

  router.post(
    "/integrations",
    [requireCapability("integrations:manage")],
    safeHandler(async (request, response) => {
      const body = reqBody(request);
      const result = await Integration.create({
        name: body.name,
        provider: body.provider,
        config: body.config ?? {},
        secrets: body.secrets ?? {},
        events: body.events ?? [],
        enabled: body.enabled !== false,
        actor: response.locals.user,
      });
      if (!result.integration)
        return response.status(400).json({ error: result.error });
      response.status(200).json({ integration: result.integration });
    })
  );

  router.post(
    "/integrations/:uuid",
    [requireCapability("integrations:manage")],
    safeHandler(async (request, response) => {
      const body = reqBody(request);
      const result = await Integration.update({
        uuid: String(request.params.uuid),
        patch: {
          name: body.name,
          enabled: body.enabled,
          config: body.config,
          events: body.events,
        },
        secrets: body.secrets ?? null,
        actor: response.locals.user,
      });
      response.status(result.success ? 200 : 400).json(result);
    })
  );

  router.delete(
    "/integrations/:uuid",
    [requireCapability("integrations:manage")],
    safeHandler(async (request, response) => {
      const result = await Integration.delete({
        uuid: String(request.params.uuid),
        actor: response.locals.user,
      });
      response.status(result.success ? 200 : 400).json(result);
    })
  );

  /** Sends a sample payload so a business can prove the wiring works. */
  router.post(
    "/integrations/:uuid/test",
    [requireCapability("integrations:manage")],
    safeHandler(async (request, response) => {
      const result = await notifier.test(String(request.params.uuid));
      response.status(200).json({
        success: Boolean(result.ok),
        status: result.status ?? null,
        error: result.error ?? null,
      });
    })
  );

  router.get(
    "/integrations/:uuid/deliveries",
    [requireCapability("integrations:view")],
    safeHandler(async (request, response) => {
      const integration = await Integration.get({
        uuid: String(request.params.uuid),
      });
      if (!integration)
        return response.status(404).json({ error: "Integration not found." });
      response
        .status(200)
        .json({ deliveries: await Integration.deliveries(integration.id, 25) });
    })
  );
}

module.exports = { integrationRoutes };
