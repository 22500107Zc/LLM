#!/usr/bin/env node
/**
 * Return-on-subscription API verification against a live deployment.
 *
 * THIS SUITE MUTATES DATA. Use a disposable deployment.
 *
 *   BASE_URL=http://localhost:3001 U=<owner> P=<password> \
 *     node scripts/value-api-test.cjs
 */

const { assertSafeTarget, Results, apiClient } = require("./lib/harness.cjs");
const BASE = process.env.BASE_URL;
assertSafeTarget(BASE);
const api = apiClient(BASE);
const r = new Results("VALUE API");
const call = (p, o) => api.call(p, o);

/** The fixture month, kept away from the current one so it starts empty. */
const PERIOD = "2026-09";

(async () => {
  const login = await call("/request-token", {
    method: "POST",
    token: null,
    body: { username: process.env.U, password: process.env.P },
  });
  api.setToken(login.json?.token);
  r.record("Authenticated", !!login.json?.token);

  const empty = await call(`/business/value/summary?period=${PERIOD}`);
  const feeCents = empty.json?.summary?.fee?.monthlyCents ?? 0;
  r.record(
    "Summary loads against the configured fee",
    empty.status === 200 && feeCents > 0,
    `fee=${empty.json?.summary?.fee?.display}`
  );
  r.record(
    "Empty month reports no input rather than a return",
    empty.json?.summary?.hasInput === false &&
      empty.json?.summary?.monthlyBenefitCents === 0
  );
  r.record(
    "No qualification verdict is returned",
    !/qualif|threshold|shortfall/i.test(JSON.stringify(empty.json ?? {}))
  );
  r.record(
    "A past month discloses that its fee is an assumption",
    empty.json?.summary?.fee?.isAssumption === true,
    empty.json?.summary?.fee?.note?.slice(0, 40)
  );

  // 30x of whatever this deployment charges, so the check holds at any price.
  const thirtyX = feeCents * 30;
  const created = await call("/business/value/records", {
    method: "POST",
    body: {
      category: "closed_won_revenue",
      period: PERIOD,
      amountCents: thirtyX,
      evidenceRef: "INV-TEST-1",
      sourceSystem: "crm",
      sourceReference: "opp-test-1",
      description: "Verification fixture",
    },
  });
  r.record("Record created", created.status === 200 && !!created.json?.record);
  const uuid = created.json?.record?.uuid;

  const dupe = await call("/business/value/records", {
    method: "POST",
    body: {
      category: "closed_won_revenue",
      period: PERIOD,
      amountCents: thirtyX,
      evidenceRef: "INV-TEST-1",
      sourceSystem: "crm",
      sourceReference: "opp-test-1",
    },
  });
  r.record(
    "Duplicate is refused",
    dupe.status === 400 && /not counted twice/i.test(dupe.json?.error ?? "")
  );

  const afterRecord = await call(`/business/value/summary?period=${PERIOD}`);
  const s = afterRecord.json?.summary ?? {};
  r.record(
    "An unverified record moves the return immediately",
    s.returnMultiple === 30,
    `multiple=${s.returnMultiple}`
  );
  r.record(
    "Net ROI is reported separately from the multiple",
    s.netRoiPercent === 2900,
    `netRoi=${s.netRoiPercent}%`
  );
  r.record(
    "Net value after subscription is benefit minus fee",
    s.netValueCents === thirtyX - feeCents
  );
  r.record(
    "The headline is labelled an estimate while unverified",
    s.includesEstimates === true && /estimate/i.test(s.headlineLabel ?? "")
  );
  r.record(
    "The verified portion stays separately identifiable",
    s.verifiedOnly?.monthlyBenefitCents === 0
  );

  const selfVerify = await call(`/business/value/records/${uuid}/verification`, {
    method: "POST",
    body: { verification: "verified" },
  });
  r.record(
    "Self-verification by the creator is refused",
    selfVerify.status === 400 &&
      /other than the person/i.test(selfVerify.json?.error ?? ""),
    selfVerify.json?.error?.slice(0, 50)
  );

  const edited = await call(`/business/value/records/${uuid}`, {
    method: "PATCH",
    body: { amountCents: feeCents * 82 },
  });
  r.record("Record can be edited", edited.status === 200 && edited.json?.success);

  const afterEdit = await call(`/business/value/summary?period=${PERIOD}`);
  r.record(
    "The return recomputes after an edit",
    afterEdit.json?.summary?.returnMultiple === 82,
    `multiple=${afterEdit.json?.summary?.returnMultiple}`
  );

  const rejected = await call(`/business/value/records/${uuid}/verification`, {
    method: "POST",
    body: { verification: "rejected" },
  });
  const afterReject = await call(`/business/value/summary?period=${PERIOD}`);
  r.record(
    "A rejected record drops out of the total",
    rejected.status === 200 &&
      afterReject.json?.summary?.monthlyBenefitCents === 0 &&
      afterReject.json?.summary?.rejected?.recordCount === 1
  );

  const lead = await call("/business/value/records", {
    method: "POST",
    body: { category: "captured_lead", period: PERIOD, amountCents: 100000 },
  });
  r.record("A lead cannot be filed as revenue", lead.status === 400);

  const estimate = await call(
    `/business/value/estimate?recurringSavingsCents=${feeCents * 10}&grossProfitCents=${feeCents * 20}`
  );
  r.record(
    "Estimate calculator returns the resulting multiple",
    estimate.json?.returnMultiple === 30,
    `multiple=${estimate.json?.returnMultiple}`
  );
  r.record(
    "Estimate sets no target to work toward",
    !/qualif|threshold|required/i.test(JSON.stringify(estimate.json ?? {}))
  );

  if (uuid) await call(`/business/value/records/${uuid}`, { method: "DELETE" });
  const after = await call(`/business/value/records?period=${PERIOD}`);
  r.record("Fixture cleaned up", (after.json?.records ?? []).length === 0);

  r.finish();
})();
