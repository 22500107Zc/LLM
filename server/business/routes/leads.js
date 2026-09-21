const { reqBody } = require("../../utils/http");
const { Lead } = require("../models/lead");
const { Escalation } = require("../models/escalation");
const { requireCapability, safeHandler } = require("../middleware");
const { dispatch } = require("../services/notifier");

function leadRoutes(router) {
  // -------------------------------------------------------------- Leads ----
  router.get(
    "/leads",
    [requireCapability("leads:view")],
    safeHandler(async (request, response) => {
      const {
        status = null,
        limit = 100,
        offset = 0,
        search = null,
      } = request.query;
      const clause = {};
      if (status && Lead.STATUSES.includes(String(status)))
        clause.status = String(status);
      if (search) {
        const term = String(search);
        clause.OR = [
          { email: { contains: term } },
          { company: { contains: term } },
          { first_name: { contains: term } },
          { last_name: { contains: term } },
          { reason: { contains: term } },
        ];
      }

      const [leads, total, byStatus] = await Promise.all([
        Lead.where(clause, limit, offset),
        Lead.count(clause),
        Promise.all(
          Lead.STATUSES.map(async (s) => [s, await Lead.count({ status: s })])
        ),
      ]);

      response.status(200).json({
        leads,
        total,
        statuses: Lead.STATUSES,
        counts: Object.fromEntries(byStatus),
      });
    })
  );

  router.get(
    "/leads/export",
    [requireCapability("leads:view")],
    safeHandler(async (request, response) => {
      const { status = null } = request.query;
      const clause =
        status && Lead.STATUSES.includes(String(status))
          ? { status: String(status) }
          : {};
      const leads = await Lead.where(clause, 500, 0);

      response.setHeader("Content-Type", "text/csv; charset=utf-8");
      response.setHeader(
        "Content-Disposition",
        `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`
      );
      response.status(200).send(Lead.toCSV(leads));
    })
  );

  router.post(
    "/leads/:uuid/status",
    [requireCapability("leads:manage")],
    safeHandler(async (request, response) => {
      const { status } = reqBody(request);
      const result = await Lead.updateStatus({
        uuid: String(request.params.uuid),
        status,
        actor: response.locals.user,
      });
      response.status(result.success ? 200 : 400).json(result);
    })
  );

  router.post(
    "/leads/:uuid/notes",
    [requireCapability("leads:manage")],
    safeHandler(async (request, response) => {
      const { note } = reqBody(request);
      if (!note || !String(note).trim())
        return response
          .status(400)
          .json({ success: false, error: "A note is required." });

      const result = await Lead.addNote({
        uuid: String(request.params.uuid),
        note,
        actor: response.locals.user,
      });
      response.status(result.success ? 200 : 400).json(result);
    })
  );

  /** Re-attempts integration delivery for a lead that failed to send. */
  router.post(
    "/leads/:uuid/redeliver",
    [requireCapability("leads:manage")],
    safeHandler(async (request, response) => {
      const lead = await Lead.get({ uuid: String(request.params.uuid) });
      if (!lead) return response.status(404).json({ error: "Lead not found." });

      const result = await dispatch("lead.created", lead);
      await Lead.markDelivered(lead.id, {
        error: result.delivered
          ? null
          : "No integration accepted the delivery.",
      });
      response.status(200).json({ success: true, delivery: result });
    })
  );

  // --------------------------------------------------------- Escalations ----
  router.get(
    "/escalations",
    [requireCapability("leads:view")],
    safeHandler(async (request, response) => {
      const { status = null, limit = 100, offset = 0 } = request.query;
      const clause = {};
      if (status && Escalation.STATUSES.includes(String(status)))
        clause.status = String(status);

      const [escalations, total, open] = await Promise.all([
        Escalation.where(clause, limit, offset),
        Escalation.count(clause),
        Escalation.count({ status: "open" }),
      ]);

      response.status(200).json({
        escalations,
        total,
        openCount: open,
        statuses: Escalation.STATUSES,
      });
    })
  );

  router.post(
    "/escalations/:uuid/status",
    [requireCapability("leads:manage")],
    safeHandler(async (request, response) => {
      const { status } = reqBody(request);
      const result = await Escalation.updateStatus({
        uuid: String(request.params.uuid),
        status,
        actor: response.locals.user,
      });
      response.status(result.success ? 200 : 400).json(result);
    })
  );

  router.post(
    "/escalations/:uuid/redeliver",
    [requireCapability("leads:manage")],
    safeHandler(async (request, response) => {
      const prisma = require("../../utils/prisma");
      const escalation = await prisma.escalations.findUnique({
        where: { uuid: String(request.params.uuid) },
      });
      if (!escalation)
        return response.status(404).json({ error: "Escalation not found." });

      const result = await dispatch("escalation.created", escalation);
      await Escalation.markDelivered(escalation.id, {
        error: result.delivered
          ? null
          : "No integration accepted the delivery.",
      });
      response.status(200).json({ success: true, delivery: result });
    })
  );

  /** Lets an internal user raise an escalation manually from a conversation. */
  router.post(
    "/escalations",
    [requireCapability("leads:manage")],
    safeHandler(async (request, response) => {
      const body = reqBody(request);
      const { escalation, error } = await Escalation.create(
        { ...body, reason: "manual" },
        { actor: response.locals.user }
      );
      if (!escalation) return response.status(400).json({ error });

      const delivery = await dispatch("escalation.created", escalation);
      await Escalation.markDelivered(escalation.id, {
        error: delivery.delivered ? null : null,
      });
      response.status(200).json({ escalation, delivery });
    })
  );
}

module.exports = { leadRoutes };
