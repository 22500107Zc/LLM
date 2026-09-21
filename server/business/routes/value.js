const { reqBody } = require("../../utils/http");
const { ValueRecords, CATEGORIES, VERIFICATION } = require("../models/value");
const { requireCapability, safeHandler } = require("../middleware");

/**
 * Return-on-subscription API.
 *
 * Reading is available to anyone who can see analytics; creating, editing,
 * verifying and deleting are restricted, and verification stays separated from
 * creation so one person cannot both claim and confirm a number. Verification
 * marks which portion of the total is evidenced; it no longer decides whether
 * a customer can see their own figure.
 */
function valueRoutes(router) {
  router.get(
    "/value/summary",
    [requireCapability("analytics:view")],
    safeHandler(async (request, response) => {
      const period = request.query.period ?? ValueRecords.currentPeriod();
      const currency = request.query.currency ?? null;
      response.status(200).json({
        summary: await ValueRecords.summary(
          period,
          currency ? { currency: String(currency) } : {}
        ),
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
      if (
        verification &&
        Object.values(VERIFICATION).includes(String(verification))
      )
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
      response.status(200).json({
        history: await ValueRecords.history(String(request.params.uuid)),
      });
    })
  );

  router.get(
    "/value/export",
    [requireCapability("analytics:view")],
    safeHandler(async (request, response) => {
      const clause = request.query.period
        ? { period: String(request.query.period) }
        : {};
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
   * "Estimate value": the multiple that the entered savings and gross profit
   * would produce against this deployment's configured fee. It reports what
   * the inputs come to; it names no target to reach.
   */
  router.get(
    "/value/estimate",
    [requireCapability("analytics:view")],
    safeHandler(async (request, response) => {
      response.status(200).json(
        ValueRecords.estimateReturn({
          recurringSavingsCents:
            Number(request.query.recurringSavingsCents) || 0,
          grossProfitCents: Number(request.query.grossProfitCents) || 0,
          period: request.query.period ?? undefined,
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
        return response.status(400).json({
          error: result.error,
          duplicateOf: result.duplicateOf ?? null,
        });
      response.status(200).json({ record: result.record });
    })
  );

  router.patch(
    "/value/records/:uuid",
    [requireCapability("settings:manage")],
    safeHandler(async (request, response) => {
      const result = await ValueRecords.update({
        uuid: String(request.params.uuid),
        changes: reqBody(request),
        actor: response.locals.user,
      });
      response.status(result.success ? 200 : 400).json(result);
    })
  );

  router.post(
    "/value/records/:uuid/verification",
    // Owner-only: verification marks which portion of the total is evidenced,
    // and rejection removes a record from it entirely.
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
