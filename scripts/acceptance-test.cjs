#!/usr/bin/env node
/**
 * Acceptance suite for the Managed Business AI Operations Platform.
 *
 * THIS SUITE MUTATES DATA. It creates a temporary owner, a viewer, an agent, a
 * website agent, a lead, an escalation, a quality test and an API key, then
 * removes them again. It is for a DISPOSABLE deployment.
 *
 * The safe way to run it:
 *   ./scripts/run-disposable-acceptance.sh
 *
 * Against an already-running local test server:
 *   node scripts/acceptance-test.cjs
 *
 * Configuration (all optional):
 *   BASE_URL                  default http://localhost:3001
 *   ACCEPTANCE_HEALTH_TOKEN   sent as X-Health-Token when the probe is guarded
 *   ACCEPTANCE_EXPECT_APP_NAME  asserts the deployment's branded name
 *   ALLOW_REMOTE_ACCEPTANCE=1 required for any non-local BASE_URL
 *
 * Every run generates its own credentials and fixture names, so repeated runs
 * neither collide nor accumulate records.
 */

const {
  assertSafeTarget,
  runId,
  ephemeralPassword,
  Results,
  Cleanup,
  apiClient,
} = require("./lib/harness.cjs");

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3001";
assertSafeTarget(BASE_URL, { suiteName: "The acceptance suite" });

const RUN = runId();
const OWNER = { username: `acc-owner-${RUN}`, password: ephemeralPassword() };
const VIEWER = { username: `acc-viewer-${RUN}`, password: ephemeralPassword() };
const AGENT_NAME = `Acceptance Agent ${RUN}`;
const LEAD_EMAIL = `lead-${RUN}@example.invalid`;
const TEST_DOMAIN = "https://acceptance.example.invalid";

const api = apiClient(BASE_URL);
const results = new Results("ACCEPTANCE");
const cleanup = new Cleanup();

const call = (p, o) => api.call(p, o);

(async () => {
  try {
    await run();
  } catch (error) {
    console.error(`\n\x1b[31mSuite aborted: ${error.message}\x1b[0m`);
    results.record("Suite completed without crashing", false, error.message);
  } finally {
    await cleanup.run();
  }
  results.finish();
})();

async function run() {
  results.section("BOOTSTRAP");

  const mode = await call("/system/multi-user-mode", { token: null });
  let ownerCreated = false;

  if (!mode.json?.multiUserMode) {
    const enabled = await call("/system/enable-multi-user", {
      method: "POST",
      body: OWNER,
      token: null,
    });
    ownerCreated = enabled.status === 200 && enabled.json?.success;
    results.record("Multi-user mode can be enabled", ownerCreated, enabled.json?.error ?? "");
  } else {
    // An already-initialised disposable deployment: an existing admin must
    // create our throwaway owner. Credentials come from the environment so no
    // password is ever committed.
    const seedUser = process.env.ACCEPTANCE_SEED_USER;
    const seedPass = process.env.ACCEPTANCE_SEED_PASSWORD;
    if (!seedUser || !seedPass) {
      results.record(
        "Multi-user mode is enabled",
        true,
        "already initialised — set ACCEPTANCE_SEED_USER/PASSWORD to run the full suite"
      );
      results.blocked(
        "Temporary owner account",
        "This deployment is already initialised. Use ./scripts/run-disposable-acceptance.sh for a clean one, or supply ACCEPTANCE_SEED_USER and ACCEPTANCE_SEED_PASSWORD."
      );
      return;
    }
    // Run as the supplied account. It is the deployment Owner, so the
    // owner-only checks (Billing) are genuinely exercised. Creating a second
    // administrator instead would silently skip them.
    OWNER.username = seedUser;
    OWNER.password = seedPass;
    const seedLogin = await call("/request-token", {
      method: "POST",
      body: OWNER,
      token: null,
    });
    ownerCreated = !!seedLogin.json?.token;
    results.record(
      "Supplied administrator can log in",
      ownerCreated,
      ownerCreated ? "" : "check ACCEPTANCE_SEED_USER / ACCEPTANCE_SEED_PASSWORD"
    );
    if (!ownerCreated) return;
  }

  results.section("AUTHENTICATION");

  const login = await call("/request-token", {
    method: "POST",
    body: OWNER,
    token: null,
  });
  const token = login.json?.token ?? null;
  api.setToken(token);
  results.record("Owner can log in", !!token);
  if (!token) return;

  const badLogin = await call("/request-token", {
    method: "POST",
    // Generated, so no test file carries a password literal at all.
    body: { username: OWNER.username, password: ephemeralPassword() },
    token: null,
  });
  results.record("Wrong password is rejected", !badLogin.json?.token, `HTTP ${badLogin.status}`);

  const anonymous = await call("/business/dashboard", { token: null });
  results.record(
    "Authentication cannot be bypassed",
    anonymous.status === 401,
    `HTTP ${anonymous.status}`
  );

  const forged = await call("/business/dashboard", { token: "forged.token.value" });
  results.record("Forged token is rejected", forged.status === 401, `HTTP ${forged.status}`);

  results.section("BUSINESS PORTAL");

  const me = await call("/business/me");
  results.record(
    "Role and capabilities resolve",
    me.status === 200 && !!me.json?.businessRole,
    `${me.json?.businessRole} · ${me.json?.capabilities?.length} capabilities`
  );

  const dashboard = await call("/business/dashboard");
  results.record(
    "Dashboard loads",
    dashboard.status === 200 && !!dashboard.json?.metrics,
    `onboarding ${dashboard.json?.onboarding?.percent}%`
  );

  results.section("TEAM AND PERMISSIONS");

  const team = await call("/business/team");
  results.record(
    "Team page loads",
    team.status === 200 && Array.isArray(team.json?.members),
    `${team.json?.members?.length} member(s), limit ${team.json?.limits?.maxUsers}`
  );

  const addViewer = await call("/business/team/users", {
    method: "POST",
    body: { ...VIEWER, role: "viewer" },
  });
  const viewerId = addViewer.json?.user?.id ?? null;
  results.record("Owner can add a user", addViewer.status === 200 && !!viewerId, addViewer.json?.error ?? "");
  if (viewerId)
    cleanup.add("viewer account", () =>
      call(`/business/team/users/${viewerId}`, { method: "DELETE" })
    );

  const viewerLogin = await call("/request-token", {
    method: "POST",
    body: VIEWER,
    token: null,
  });
  const viewerToken = viewerLogin.json?.token ?? null;
  results.record("New user can log in", !!viewerToken);

  if (viewerToken) {
    for (const [label, pathname] of [
      ["billing", "/business/billing/summary"],
      ["team management", "/business/team"],
      ["the audit log", "/business/audit"],
    ]) {
      const denied = await call(pathname, { token: viewerToken });
      results.record(`Viewer is denied ${label}`, denied.status === 403, `HTTP ${denied.status}`);
    }

    const readable = await call("/business/agents", { token: viewerToken });
    results.record("Viewer can read agents (read-only works)", readable.status === 200);

    const writeAttempt = await call("/business/agents", {
      token: viewerToken,
      method: "POST",
      body: { name: `should-not-exist-${RUN}` },
    });
    results.record("Viewer cannot create an agent", writeAttempt.status === 403);
  }

  results.section("AI AGENTS");

  const templates = await call("/business/agents/templates");
  results.record(
    "Agent templates available",
    (templates.json?.templates?.length ?? 0) >= 5,
    `${templates.json?.templates?.length} templates`
  );

  const createdAgent = await call("/business/agents", {
    method: "POST",
    body: {
      name: AGENT_NAME,
      template: "customer_support",
      description: "Temporary acceptance fixture",
      leadCapture: true,
      escalation: true,
    },
  });
  const agent = createdAgent.json?.agent ?? null;
  results.record("Agent can be created", createdAgent.status === 200 && !!agent, createdAgent.json?.error ?? "");
  if (!agent) return;
  cleanup.add("agent", () => call(`/business/agents/${agent.uuid}`, { method: "DELETE" }));

  results.record(
    "Agent defaults to source-grounded answers",
    agent.workspace?.chatMode === "query",
    `chatMode=${agent.workspace?.chatMode}`
  );
  results.record(
    "Agent has an approved-knowledge fallback",
    /approved company knowledge/i.test(agent.fallbackMessage ?? "")
  );

  results.section("WEBSITE AGENT");

  const noAllowlist = await call("/business/website-agents", {
    method: "POST",
    body: { agentUuid: agent.uuid, allowlistDomains: [] },
  });
  results.record(
    "Website agent without a domain allowlist is refused",
    noAllowlist.status === 400,
    (noAllowlist.json?.error ?? "").slice(0, 60)
  );

  const createdEmbed = await call("/business/website-agents", {
    method: "POST",
    body: {
      agentUuid: agent.uuid,
      allowlistDomains: [TEST_DOMAIN],
      maxChatsPerDay: 100,
      maxChatsPerSession: 10,
    },
  });
  const embedId = createdEmbed.json?.websiteAgent?.uuid ?? null;
  results.record("Website agent created with an allowlist", !!embedId, createdEmbed.json?.error ?? "");
  if (!embedId) return;
  cleanup.add("website agent", () =>
    call(`/business/website-agents/${embedId}`, { method: "DELETE" })
  );

  const snippet = await call(`/business/website-agents/${embedId}/snippet`);
  results.record(
    "Embed snippet generated",
    (snippet.json?.snippet ?? "").includes(embedId),
    "copy-paste script produced"
  );

  results.section("PUBLIC EMBED SECURITY");

  const foreign = await api.raw(`/embed/${embedId}/capture-config`, {
    headers: { Origin: "https://attacker.example.invalid" },
  });
  results.record("Embed rejects an unauthorized origin", foreign.status === 404, `HTTP ${foreign.status}`);

  const allowed = await api.raw(`/embed/${embedId}/capture-config`, {
    headers: { Origin: TEST_DOMAIN },
  });
  const captureConfig = await allowed.json().catch(() => null);
  results.record(
    "Embed accepts the allowed origin",
    allowed.status === 200,
    `leadCapture=${captureConfig?.leadCapture}`
  );

  results.section("LEAD CAPTURE");

  const session = crypto.randomUUID();
  const leadPost = await api.raw(`/embed/${embedId}/lead`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: TEST_DOMAIN },
    body: JSON.stringify({
      sessionId: session,
      firstName: "Dana",
      lastName: "Prospect",
      email: LEAD_EMAIL,
      company: "Prospect Ltd",
      reason: "Interested in a demo",
      sourceUrl: `${TEST_DOMAIN}/pricing`,
    }),
  });
  results.record("Lead capture accepted from the allowed origin", leadPost.status === 200, `HTTP ${leadPost.status}`);

  const leadForeign = await api.raw(`/embed/${embedId}/lead`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://attacker.example.invalid" },
    body: JSON.stringify({ sessionId: crypto.randomUUID(), email: "x@y.invalid", firstName: "X" }),
  });
  results.record("Lead capture blocked from a foreign origin", leadForeign.status === 404);

  const leads = await call(`/business/leads?search=${encodeURIComponent(LEAD_EMAIL)}`);
  const lead = (leads.json?.leads ?? []).find((l) => l.email === LEAD_EMAIL);
  results.record("Lead appears in the dashboard", !!lead, lead ? `${lead.first_name} (${lead.status})` : "not found");

  const duplicate = await api.raw(`/embed/${embedId}/lead`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: TEST_DOMAIN },
    body: JSON.stringify({ sessionId: session, firstName: "Dana", email: LEAD_EMAIL }),
  });
  const duplicateBody = await duplicate.json().catch(() => ({}));
  results.record("Visitor is not asked twice on the same session", duplicateBody?.alreadyCaptured === true);

  if (lead) {
    const statusChange = await call(`/business/leads/${lead.uuid}/status`, {
      method: "POST",
      body: { status: "qualified" },
    });
    results.record("Lead status can be changed", statusChange.json?.success === true);
  }

  results.section("HUMAN ESCALATION");

  const escalationSession = crypto.randomUUID();
  const escalate = await api.raw(`/embed/${embedId}/escalate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: TEST_DOMAIN },
    body: JSON.stringify({
      sessionId: escalationSession,
      name: "Sam Customer",
      email: `escalation-${RUN}@example.invalid`,
      question: "I need to speak to a person about billing",
    }),
  });
  results.record("Escalation accepted", escalate.status === 200, `HTTP ${escalate.status}`);

  const escalations = await call("/business/escalations");
  const escalation = (escalations.json?.escalations ?? []).find(
    (e) => e.session_id === escalationSession
  );
  results.record("Escalation appears in the dashboard", !!escalation);

  results.section("INTEGRATIONS");

  const integrations = await call("/business/integrations");
  results.record(
    "Integration catalogue available",
    (integrations.json?.catalogue?.length ?? 0) >= 5,
    integrations.json?.catalogue?.map((c) => c.provider).join(", ")
  );

  // Proves the SSRF guard blocks the cloud metadata endpoint. No external
  // system is contacted: the request is refused before any socket is opened.
  const ssrf = await call("/business/integrations", {
    method: "POST",
    body: {
      name: `ssrf-probe-${RUN}`,
      provider: "webhook",
      config: { url: "http://169.254.169.254/latest/meta-data/" },
      events: ["lead.created"],
    },
  });
  let ssrfBlocked = false;
  if (ssrf.status === 200) {
    const uuid = ssrf.json.integration.uuid;
    const probe = await call(`/business/integrations/${uuid}/test`, { method: "POST" });
    ssrfBlocked = probe.json?.success === false;
    await call(`/business/integrations/${uuid}`, { method: "DELETE" });
  }
  results.record("Webhook to the cloud metadata address is blocked (SSRF)", ssrfBlocked);

  results.section("CONVERSATIONS, ANALYTICS AND GAPS");

  const conversations = await call("/business/conversations");
  results.record("Conversations dashboard works", conversations.status === 200);

  const analytics = await call("/business/analytics?days=30");
  results.record("Analytics works", analytics.status === 200 && !!analytics.json?.conversations);
  results.record(
    "Estimated metrics are labelled as estimates",
    analytics.json?.conversations?.uniqueVisitorsIsEstimate === true
  );

  const gaps = await call("/business/knowledge-gaps");
  results.record("Knowledge gaps endpoint works", gaps.status === 200);

  results.section("AI QUALITY");

  const qualityTest = await call("/business/quality/tests", {
    method: "POST",
    body: {
      question: `Acceptance probe ${RUN}: what is the refund window?`,
      expectedConcepts: "30 day refund",
      agentUuid: agent.uuid,
    },
  });
  const testUuid = qualityTest.json?.test?.uuid ?? null;
  results.record("AI quality test can be created", qualityTest.status === 200 && !!testUuid);
  if (testUuid)
    cleanup.add("quality test", () =>
      call(`/business/quality/tests/${testUuid}`, { method: "DELETE" })
    );

  // A run object existing proves nothing. Assert the suite actually executed
  // the test and that the counts are internally consistent.
  const qualityRun = await call("/business/quality/run", {
    method: "POST",
    body: { testUuids: testUuid ? [testUuid] : null },
  });
  const runRecord = qualityRun.json?.run ?? null;
  results.record("Quality run endpoint responds", qualityRun.status === 200 && !!runRecord);

  if (runRecord) {
    const { total, passed, needs_review: needsReview, failed } = runRecord;
    results.record(
      "Quality run executed at least one test",
      Number(total) >= 1,
      `total=${total}`
    );
    results.record(
      "Quality run counts add up to the number of tests",
      Number(passed) + Number(needsReview) + Number(failed) === Number(total),
      `${passed}P / ${needsReview}R / ${failed}F of ${total}`
    );

    const runDetail = await call(`/business/quality/runs/${runRecord.uuid}`);
    const verdicts = (runDetail.json?.results ?? []).map((r) => r.verdict);
    results.record(
      "Every test in the run produced a verdict",
      verdicts.length === Number(total) && verdicts.every(Boolean),
      verdicts.join(", ") || "none"
    );

    // Whether the ANSWER is correct depends on a model provider. Without one,
    // the agent cannot answer at all, so a failed verdict here is expected and
    // is reported as a blocked correctness gate rather than a passing test.
    const providerConfigured = process.env.ACCEPTANCE_PROVIDER_CONFIGURED === "1";
    if (providerConfigured) {
      results.record(
        "Quality run produced a passing answer",
        Number(passed) >= 1,
        `${passed} passed`
      );
    } else {
      results.blocked(
        "Answer-correctness grading (end to end)",
        "No model provider configured for this deployment. Endpoint execution is verified above; answer correctness is verified by scripts/provider-verification.cjs. Set ACCEPTANCE_PROVIDER_CONFIGURED=1 when a provider is configured."
      );
    }
  }

  results.section("BILLING");

  const billing = await call("/business/billing/summary");
  results.record(
    "Billing page data loads",
    billing.status === 200 && !!billing.json?.plan,
    `${billing.json?.plan?.priceWithInterval} · ${billing.json?.subscription?.statusLabel}`
  );
  results.record(
    "Plan price matches the configured commercial amount",
    billing.json?.plan?.amountCents === Number(process.env.PLAN_AMOUNT_CENTS ?? 388888),
    `${billing.json?.plan?.amountCents} cents`
  );
  results.record("No card data is stored", billing.json?.cardDataStored === false);

  const billingPayload = JSON.stringify(billing.json ?? {});
  results.record(
    "No Stripe secret reaches the browser",
    !/sk_test|sk_live|whsec_/.test(billingPayload)
  );

  results.section("API KEYS");

  const keyCreate = await call("/business/api-keys", {
    method: "POST",
    body: { name: `acceptance-${RUN}` },
  });
  const secret = keyCreate.json?.apiKey?.secret ?? null;
  const keyId = keyCreate.json?.apiKey?.id ?? null;
  results.record("API key can be created", !!secret);
  if (keyId)
    cleanup.add("API key", () => call(`/business/api-keys/${keyId}`, { method: "DELETE" }));

  const keyList = await call("/business/api-keys");
  results.record(
    "API key secret is not re-listed after creation",
    !!secret && !JSON.stringify(keyList.json ?? {}).includes(secret)
  );

  if (keyId) {
    const revoked = await call(`/business/api-keys/${keyId}`, { method: "DELETE" });
    results.record("API key can be revoked", revoked.json?.success === true);
  }

  results.section("AUDIT LOG");

  const audit = await call("/business/audit?limit=200");
  const actions = (audit.json?.entries ?? []).map((e) => e.action);
  results.record("Audit log records activity", audit.status === 200 && actions.length > 0, `${audit.json?.total} entries`);
  for (const expected of [
    "user.created",
    "agent.created",
    "embed.created",
    "lead.captured",
    "escalation.created",
    "api_key.created",
    "api_key.revoked",
  ])
    results.record(`Audit captures ${expected}`, actions.includes(expected));

  const auditPayload = JSON.stringify(audit.json ?? {});
  results.record(
    "Audit log contains no credentials",
    !new RegExp(
      [OWNER.password, VIEWER.password].map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
    ).test(auditPayload) && !/sk_test|sk_live|whsec_/.test(auditPayload)
  );

  results.section("HEALTH");

  const health = await call("/business/health");
  results.record(
    "Health report available to admins",
    health.status === 200 && !!health.json?.components,
    Object.entries(health.json?.components ?? {})
      .map(([k, v]) => `${k}=${v.status}`)
      .join(" ")
  );
  results.record(
    "Health report leaks no credentials",
    !/sk_test|sk_live|whsec_|OPEN_AI_KEY/i.test(JSON.stringify(health.json ?? {}))
  );

  const probeOpen = await api.raw("/platform/health/probe");
  const healthToken = process.env.ACCEPTANCE_HEALTH_TOKEN;
  if (probeOpen.status === 401) {
    if (!healthToken) {
      results.blocked(
        "Uptime probe token check",
        "The probe is token-guarded; set ACCEPTANCE_HEALTH_TOKEN to verify it."
      );
    } else {
      const withToken = await api.raw("/platform/health/probe", {
        headers: { "X-Health-Token": healthToken },
      });
      const withWrong = await api.raw("/platform/health/probe", {
        headers: { "X-Health-Token": "wrong-token" },
      });
      results.record("Uptime probe accepts the configured token", withToken.status === 200);
      results.record("Uptime probe rejects a wrong token", withWrong.status === 401);
    }
  } else {
    results.record("Uptime probe is reachable", probeOpen.status === 200, "open probe (no token configured)");
  }

  results.section("BRANDING");

  const branding = await api.raw("/platform/branding").then((r) => r.json());
  const expectedName = process.env.ACCEPTANCE_EXPECT_APP_NAME;
  if (expectedName) {
    results.record(
      "Branding is env-driven",
      branding?.branding?.appName === expectedName,
      branding?.branding?.appName
    );
  } else {
    results.record(
      "Branding endpoint serves a configured name",
      typeof branding?.branding?.appName === "string" && branding.branding.appName.length > 0,
      branding?.branding?.appName
    );
  }
  results.record(
    "No upstream marketing in the branding payload",
    !/mintplex|anythingllm/i.test(JSON.stringify(branding ?? {}))
  );

  results.section("ERROR HANDLING");

  const missing = await call(`/business/agents/does-not-exist-${RUN}`);
  results.record(
    "Unknown resource returns a clean error",
    missing.status === 404 && !JSON.stringify(missing.json ?? {}).includes("at Object."),
    missing.json?.error
  );
}
