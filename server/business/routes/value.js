const { reqBody } = require("../../utils/http");
const { ValueRecords, CATEGORIES, VERIFICATION } = require("../models/value");
const { requireCapability, safeHandler } = require("../middleware");

/**
 * Value evidence API.
 *
 * Reading is available to anyone who can see analytics; creating, verifying
 * and deleting are restricted, and verification is separated from creation so
 * one person cannot both claim and confirm a number.
 */
function valueRoutes(router) {
  router.get(
    "/value/summary",
    [requireCapability("analytics:view")],
    safeHandler(async (request, response) => {
      const period = request.query.period ?? ValueRecords.currentPeriod();
      response.status(200).json({
        summary: await ValueRecords.summary(period),
        categories: CATEGORIES,
      });
    })
  );

  router.get(
    "/value/records",
    [requireCapability("analytics:view")],
    safeHandler(async (request, response) => {
      const { period = null, verification = null } = request.query;
      const clause = {};
      if (period) clause.period = String(period);
      if (verification && Object.values(VERIFICATION).includes(String(verification)))
        clause.verification = String(verification);

      response.status(200).json({
        records: await ValueRecords.where(clause),
        categories: CATEGORIES,
        verificationStates: Object.values(VERIFICATION),
      });
    })
  );

  router.get(
    "/value/records/:uuid/history",
    [requireCapability("analytics:view")],
    safeHandler(async (request, response) => {
      response
        .status(200)
        .json({ history: await ValueRecords.history(String(request.params.uuid)) });
    })
  );

  router.get(
    "/value/export",
    [requireCapability("analytics:view")],
    safeHandler(async (request, response) => {
      const clause = request.query.period ? { period: String(request.query.period) } : {};
      const records = await ValueRecords.where(clause);
      response.setHeader("Content-Type", "text/csv; charset=utf-8");
      response.setHeader(
        "Content-Disposition",
        `attachment; filename="value-${new Date().toISOString().slice(0, 10)}.csv"`
      );
      response.status(200).send(ValueRecords.toCSV(records));
    })
  );

  /**
   * The prospect calculator. Returns what WOULD be required, explicitly
   * labelled as an assumption so it can never be read as a result.
   */
  router.get(
    "/value/scenarios",
    [requireCapability("analytics:view")],
    safeHandler(async (request, response) => {
      const grossProfitPerSaleCents = Number(request.query.grossProfitPerSaleCents) || null;
      const monthlyCostBaseCents = Number(request.query.monthlyCostBaseCents) || null;
      response
        .status(200)
        .json(
          ValueRecords.qualificationScenarios({
            grossProfitPerSaleCents,
            monthlyCostBaseCents,
          })
        );
    })
  );

  router.post(
    "/value/records",
    [requireCapability("settings:manage")],
    safeHandler(async (request, response) => {
      const result = await ValueRecords.create(reqBody(request), {
        actor: response.locals.user,
      });
      if (!result.record)
        return response
          .status(400)
          .json({ error: result.error, duplicateOf: result.duplicateOf ?? null });
      response.status(200).json({ record: result.record });
    })
  );

  router.post(
    "/value/records/:uuid/verification",
    // Owner-only: verification is what turns a claim into a number the
    // business will repeat to a customer.
    [requireCapability("billing:view")],
    safeHandler(async (request, response) => {
      const { verification, note = null } = reqBody(request);
      const result = await ValueRecords.setVerification({
        uuid: String(request.params.uuid),
        verification,
        note,
        actor: response.locals.user,
      });
      response.status(result.success ? 200 : 400).json(result);
    })
  );

  router.delete(
    "/value/records/:uuid",
    [requireCapability("settings:manage")],
    safeHandler(async (request, response) => {
      const result = await ValueRecords.delete({
        uuid: String(request.params.uuid),
        actor: response.locals.user,
      });
      response.status(result.success ? 200 : 400).json(result);
    })
  );
}

module.exports = { valueRoutes };
