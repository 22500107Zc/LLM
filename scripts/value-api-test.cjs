#!/usr/bin/env node
/**
 * Value evidence API verification against a live deployment.
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

(async () => {
  const login = await call("/request-token", { method: "POST", token: null,
    body: { username: process.env.U, password: process.env.P } });
  api.setToken(login.json?.token);
  r.record("Authenticated", !!login.json?.token);

  const summary = await call("/business/value/summary?period=2026-09");
  r.record("Summary loads", summary.status === 200 && !!summary.json?.summary,
    `fee=${summary.json?.summary?.fee?.display}`);
  r.record("90x threshold is $349,999.20",
    summary.json?.summary?.thresholds?.x90?.requiredCents === 34999920);
  r.record("100x threshold is $388,888.00",
    summary.json?.summary?.thresholds?.x100?.requiredCents === 38888800);
  r.record("Starts below 90x with no evidence",
    summary.json?.summary?.status === "below_90x");

  const created = await call("/business/value/records", { method: "POST", body: {
    category: "closed_won_revenue", period: "2026-09", amountCents: 38888800,
    evidenceRef: "INV-TEST-1", sourceSystem: "crm", sourceReference: "opp-test-1",
    description: "Verification fixture" } });
  r.record("Record created", created.status === 200 && !!created.json?.record);
  const uuid = created.json?.record?.uuid;

  const dupe = await call("/business/value/records", { method: "POST", body: {
    category: "closed_won_revenue", period: "2026-09", amountCents: 38888800,
    evidenceRef: "INV-TEST-1", sourceSystem: "crm", sourceReference: "opp-test-1" } });
  r.record("Duplicate is refused", dupe.status === 400 && /not counted twice/i.test(dupe.json?.error ?? ""));

  const stillBelow = await call("/business/value/summary?period=2026-09");
  r.record("Unverified record does NOT qualify",
    stillBelow.json?.summary?.status === "below_90x",
    `pending=${stillBelow.json?.summary?.unverified?.pendingCents}`);

  const selfVerify = await call(`/business/value/records/${uuid}/verification`,
    { method: "POST", body: { verification: "verified" } });
  r.record("Self-verification by the creator is refused",
    selfVerify.status === 400 && /other than the person/i.test(selfVerify.json?.error ?? ""),
    selfVerify.json?.error?.slice(0, 50));

  const lead = await call("/business/value/records", { method: "POST", body: {
    category: "captured_lead", period: "2026-09", amountCents: 100000 } });
  r.record("A lead cannot be filed as revenue", lead.status === 400);

  const scenarios = await call("/business/value/scenarios?grossProfitPerSaleCents=1000000");
  r.record("Calculator: 39 sales for 100x at $10k profit",
    scenarios.json?.scenarios?.additionalSales?.for100x === 39);
  r.record("Calculator output is labelled an assumption",
    scenarios.json?.isAssumption === true);

  if (uuid) await call(`/business/value/records/${uuid}`, { method: "DELETE" });
  const after = await call("/business/value/records?period=2026-09");
  r.record("Fixture cleaned up", (after.json?.records ?? []).length === 0);

  r.finish();
})();
