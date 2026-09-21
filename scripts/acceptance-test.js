/**
 * End-to-end acceptance suite for the Managed Business AI Operations Platform.
 *
 * Run against a LIVE server (production mode is what matters, since several
 * checks - notably the anonymous-access guard - only apply there):
 *
 *   cd server && NODE_ENV=production node index.js    # terminal 1
 *   node scripts/acceptance-test.js                   # terminal 2
 *
 * It creates a throwaway owner, a viewer, an agent, a website agent, a lead,
 * an escalation, a quality test and an API key, then asserts the commercial
 * and security behaviour a paying customer depends on.
 *
 * Safe to re-run: existing fixtures are detected rather than duplicated.
 * Point BASE_URL at another host to test a remote deployment.
 */

const BASE = `${process.env.BASE_URL ?? "http://localhost:3001"}/api`;
let TOKEN = null;
const results = [];

function record(name, passed, detail = "") {
  results.push({ name, passed, detail });
  const mark = passed ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`${mark}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function api(path, { method = "GET", body = null, token = TOKEN, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

(async () => {
  console.log("\n=== SETUP: multi-user mode + owner account ===");
  const alreadyOn = await api("/system/multi-user-mode", { token: null });
  if (!alreadyOn.json?.multiUserMode) {
    const enable = await api("/system/enable-multi-user", {
      method: "POST",
      body: { username: "acmeowner", password: "Str0ng-Owner-Pass!2026" },
      token: null,
    });
    record("Multi-user mode can be enabled", enable.status === 200 && enable.json?.success,
      enable.json?.error ?? "");
  } else {
    record("Multi-user mode is enabled", true, "already enabled");
  }

  console.log("\n=== AUTHENTICATION ===");
  const login = await api("/request-token", {
    method: "POST",
    body: { username: "acmeowner", password: "Str0ng-Owner-Pass!2026" },
    token: null,
  });
  TOKEN = login.json?.token ?? null;
  record("Owner can log in", !!TOKEN, TOKEN ? "token issued" : JSON.stringify(login.json));

  const badLogin = await api("/request-token", {
    method: "POST", body: { username: "acmeowner", password: "wrong" }, token: null,
  });
  record("Wrong password is rejected", !badLogin.json?.token, `HTTP ${badLogin.status}`);

  const noAuth = await api("/business/dashboard", { token: null });
  record("Authentication cannot be bypassed", noAuth.status === 401, `HTTP ${noAuth.status}`);

  const badToken = await api("/business/dashboard", { token: "forged.token.value" });
  record("Forged token is rejected", badToken.status === 401, `HTTP ${badToken.status}`);

  if (!TOKEN) { summarize(); return; }

  console.log("\n=== BUSINESS PORTAL ===");
  const me = await api("/business/me");
  record("Role + capabilities resolve", me.status === 200 && !!me.json?.businessRole,
    `${me.json?.businessRole} · ${me.json?.capabilities?.length} capabilities`);

  const dash = await api("/business/dashboard");
  record("Dashboard loads", dash.status === 200 && !!dash.json?.metrics,
    `${dash.json?.metrics?.aiMessages ?? 0} messages, onboarding ${dash.json?.onboarding?.percent}%`);

  console.log("\n=== TEAM & PERMISSIONS ===");
  const team = await api("/business/team");
  record("Team page loads", team.status === 200 && Array.isArray(team.json?.members),
    `${team.json?.members?.length} member(s), limit ${team.json?.limits?.maxUsers}`);

  const addUser = await api("/business/team/users", {
    method: "POST",
    body: { username: "acmeviewer", password: "Str0ng-Viewer-Pass!2026", role: "viewer" },
  });
  const userOk = (addUser.status === 200 && !!addUser.json?.user) ||
    (addUser.json?.error ?? "").includes("already exists");
  record("Owner can add a user", userOk,
    addUser.json?.user ? `${addUser.json.user.username} as ${addUser.json.user.businessRole}` : addUser.json?.error);

  const viewerLogin = await api("/request-token", {
    method: "POST", body: { username: "acmeviewer", password: "Str0ng-Viewer-Pass!2026" }, token: null,
  });
  const VIEWER = viewerLogin.json?.token ?? null;
  record("New user can log in", !!VIEWER);

  if (VIEWER) {
    const viewerBilling = await api("/business/billing/summary", { token: VIEWER });
    record("Viewer is denied billing access", viewerBilling.status === 403, `HTTP ${viewerBilling.status}`);

    const viewerTeam = await api("/business/team", { token: VIEWER });
    record("Viewer is denied team management", viewerTeam.status === 403, `HTTP ${viewerTeam.status}`);

    const viewerAudit = await api("/business/audit", { token: VIEWER });
    record("Viewer is denied the audit log", viewerAudit.status === 403, `HTTP ${viewerAudit.status}`);

    const viewerAgents = await api("/business/agents", { token: VIEWER });
    record("Viewer CAN read agents (read-only works)", viewerAgents.status === 200, `HTTP ${viewerAgents.status}`);

    const viewerCreate = await api("/business/agents", {
      token: VIEWER, method: "POST", body: { name: "Should Not Exist" },
    });
    record("Viewer cannot create an agent", viewerCreate.status === 403, `HTTP ${viewerCreate.status}`);
  }

  console.log("\n=== AI AGENTS ===");
  const templates = await api("/business/agents/templates");
  record("Agent templates available", (templates.json?.templates?.length ?? 0) >= 5,
    `${templates.json?.templates?.length} templates`);

  const created = await api("/business/agents", {
    method: "POST",
    body: { name: "Acceptance Support Agent", template: "customer_support",
            description: "Acceptance test agent", leadCapture: true, escalation: true },
  });
  const AGENT = created.json?.agent ?? null;
  record("Agent can be created", created.status === 200 && !!AGENT,
    AGENT ? `${AGENT.name} → workspace ${AGENT.workspace?.slug}` : created.json?.error);
  record("Agent defaults to source-grounded answers", AGENT?.workspace?.chatMode === "query",
    `chatMode=${AGENT?.workspace?.chatMode}`);
  record("Agent has approved-knowledge fallback",
    /approved company knowledge/i.test(AGENT?.fallbackMessage ?? ""), AGENT?.fallbackMessage);

  console.log("\n=== WEBSITE AGENT (EMBED) ===");
  const noDomains = await api("/business/website-agents", {
    method: "POST", body: { agentUuid: AGENT?.uuid, allowlistDomains: [] },
  });
  record("Website agent WITHOUT a domain allowlist is refused",
    noDomains.status === 400, noDomains.json?.error?.slice(0, 60));

  const embed = await api("/business/website-agents", {
    method: "POST",
    body: { agentUuid: AGENT?.uuid, allowlistDomains: ["https://acme.example.com"],
            maxChatsPerDay: 100, maxChatsPerSession: 10 },
  });
  const EMBED = embed.json?.websiteAgent?.uuid ?? null;
  record("Website agent created with an allowlist", !!EMBED, EMBED ?? embed.json?.error);

  const snippet = await api(`/business/website-agents/${EMBED}/snippet`);
  record("Embed snippet generated",
    (snippet.json?.snippet ?? "").includes(EMBED ?? "___"), "copy-paste script produced");

  console.log("\n=== PUBLIC EMBED SECURITY ===");
  const wrongOrigin = await fetch(`${BASE}/embed/${EMBED}/capture-config`, {
    headers: { Origin: "https://attacker.example.net" },
  });
  record("Embed rejects an unauthorized origin", wrongOrigin.status === 404, `HTTP ${wrongOrigin.status}`);

  const rightOrigin = await fetch(`${BASE}/embed/${EMBED}/capture-config`, {
    headers: { Origin: "https://acme.example.com" },
  });
  const captureConfig = await rightOrigin.json().catch(() => null);
  record("Embed accepts the allowed origin", rightOrigin.status === 200,
    `leadCapture=${captureConfig?.leadCapture}`);

  console.log("\n=== LEAD CAPTURE ===");
  const sessionId = crypto.randomUUID();
  const leadRes = await fetch(`${BASE}/embed/${EMBED}/lead`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://acme.example.com" },
    body: JSON.stringify({ sessionId, firstName: "Dana", lastName: "Prospect",
      email: "dana@prospect.example.com", company: "Prospect Ltd",
      reason: "Interested in a demo", sourceUrl: "https://acme.example.com/pricing" }),
  });
  record("Lead capture accepted from the allowed origin", leadRes.status === 200, `HTTP ${leadRes.status}`);

  const leadWrongOrigin = await fetch(`${BASE}/embed/${EMBED}/lead`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://attacker.example.net" },
    body: JSON.stringify({ sessionId: crypto.randomUUID(), email: "x@y.co", firstName: "X" }),
  });
  record("Lead capture blocked from a foreign origin", leadWrongOrigin.status === 404,
    `HTTP ${leadWrongOrigin.status}`);

  const leads = await api("/business/leads");
  const foundLead = (leads.json?.leads ?? []).find((l) => l.email === "dana@prospect.example.com");
  record("Lead appears in the dashboard", !!foundLead,
    foundLead ? `${foundLead.first_name} ${foundLead.last_name} (${foundLead.status})` : "not found");

  const dupe = await fetch(`${BASE}/embed/${EMBED}/lead`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://acme.example.com" },
    body: JSON.stringify({ sessionId, firstName: "Dana", email: "dana@prospect.example.com" }),
  });
  const dupeJson = await dupe.json().catch(() => ({}));
  record("Visitor is not harassed for a second lead", dupeJson?.alreadyCaptured === true);

  if (foundLead) {
    const statusChange = await api(`/business/leads/${foundLead.uuid}/status`, {
      method: "POST", body: { status: "qualified" },
    });
    record("Lead status can be changed", statusChange.json?.success === true);
  }

  console.log("\n=== HUMAN ESCALATION ===");
  const escSession = crypto.randomUUID();
  const escalate = await fetch(`${BASE}/embed/${EMBED}/escalate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://acme.example.com" },
    body: JSON.stringify({ sessionId: escSession, name: "Sam Customer",
      email: "sam@customer.example.com", question: "I need to speak to a person about billing" }),
  });
  record("Escalation accepted", escalate.status === 200, `HTTP ${escalate.status}`);

  const escalations = await api("/business/escalations");
  const foundEsc = (escalations.json?.escalations ?? []).find((e) => e.session_id === escSession);
  record("Escalation appears in the dashboard", !!foundEsc,
    foundEsc ? `${foundEsc.contact_name} · ${foundEsc.reason}` : "not found");

  console.log("\n=== INTEGRATIONS (webhook delivery) ===");
  const integrations = await api("/business/integrations");
  record("Integration catalogue available",
    (integrations.json?.catalogue?.length ?? 0) >= 5,
    integrations.json?.catalogue?.map((c) => c.provider).join(", "));

  const ssrf = await api("/business/integrations", {
    method: "POST",
    body: { name: "SSRF attempt", provider: "webhook",
            config: { url: "http://169.254.169.254/latest/meta-data/" },
            events: ["lead.created"] },
  });
  let ssrfBlocked = false;
  if (ssrf.status === 200) {
    const test = await api(`/business/integrations/${ssrf.json.integration.uuid}/test`, { method: "POST" });
    ssrfBlocked = test.json?.success === false;
    await api(`/business/integrations/${ssrf.json.integration.uuid}`, { method: "DELETE" });
  }
  record("Webhook to cloud metadata is blocked (SSRF)", ssrfBlocked);

  console.log("\n=== CONVERSATIONS / ANALYTICS / GAPS / QUALITY ===");
  const convos = await api("/business/conversations");
  record("Conversations dashboard works", convos.status === 200, `${convos.json?.total ?? 0} conversation(s)`);

  const analytics = await api("/business/analytics?days=30");
  record("Analytics works", analytics.status === 200 && !!analytics.json?.conversations,
    `${analytics.json?.leads?.captured ?? 0} leads, ${analytics.json?.escalations?.total ?? 0} escalations`);
  record("Estimated metrics are labelled",
    analytics.json?.conversations?.uniqueVisitorsIsEstimate === true);

  const gaps = await api("/business/knowledge-gaps");
  record("Knowledge gaps endpoint works", gaps.status === 200, `${gaps.json?.total ?? 0} gap(s)`);

  const qTest = await api("/business/quality/tests", {
    method: "POST",
    body: { question: "What is the refund window?", expectedConcepts: "30 days, refund",
            agentUuid: AGENT?.uuid },
  });
  record("AI quality test can be created", qTest.status === 200 && !!qTest.json?.test);

  const qRun = await api("/business/quality/run", { method: "POST", body: {} });
  record("AI quality suite runs", qRun.status === 200 && !!qRun.json?.run,
    qRun.json?.run ? `${qRun.json.run.passed}P / ${qRun.json.run.needs_review}R / ${qRun.json.run.failed}F` : qRun.json?.error);

  console.log("\n=== BILLING ===");
  const billing = await api("/business/billing/summary");
  record("Billing page data loads", billing.status === 200 && !!billing.json?.plan,
    `${billing.json?.plan?.priceWithInterval} · ${billing.json?.subscription?.statusLabel}`);
  record("Plan price is exactly $3,888.88/month",
    billing.json?.plan?.amountCents === 388888 && billing.json?.plan?.priceWithInterval === "$3,888.88/month");
  record("No card data is stored", billing.json?.cardDataStored === false);
  const billingStr = JSON.stringify(billing.json);
  record("No Stripe secret leaks to the browser",
    !billingStr.includes("sk_test") && !billingStr.includes("sk_live") && !billingStr.includes("whsec_"));

  console.log("\n=== API KEYS ===");
  const keyCreate = await api("/business/api-keys", { method: "POST", body: { name: "Acceptance key" } });
  const KEY = keyCreate.json?.apiKey?.secret ?? null;
  record("API key can be created", !!KEY, keyCreate.json?.warning);

  const keyList = await api("/business/api-keys");
  const listed = keyList.json?.apiKeys?.[0];
  record("API key secret is not re-listed after creation",
    !!listed && !JSON.stringify(keyList.json).includes(KEY ?? "___"),
    `shown as ${listed?.fingerprint}`);

  if (keyCreate.json?.apiKey?.id) {
    const revoke = await api(`/business/api-keys/${keyCreate.json.apiKey.id}`, { method: "DELETE" });
    record("API key can be revoked", revoke.json?.success === true);
  }

  console.log("\n=== AUDIT LOG ===");
  const audit = await api("/business/audit?limit=200");
  const actions = (audit.json?.entries ?? []).map((e) => e.action);
  record("Audit log records activity", audit.status === 200 && actions.length > 0,
    `${audit.json?.total} entries`);
  for (const expected of ["user.created", "agent.created", "embed.created", "lead.captured",
                          "escalation.created", "api_key.created", "api_key.revoked"]) {
    record(`Audit captures ${expected}`, actions.includes(expected));
  }
  const auditStr = JSON.stringify(audit.json);
  record("Audit log contains no credentials",
    !/Str0ng-|sk_test|sk_live|whsec_|"password"\s*:\s*"[^"]{3,}/.test(auditStr));

  console.log("\n=== HEALTH ===");
  const health = await api("/business/health");
  record("Health report available to admins", health.status === 200 && !!health.json?.components,
    Object.entries(health.json?.components ?? {}).map(([k, v]) => `${k}=${v.status}`).join(" "));
  const healthStr = JSON.stringify(health.json);
  record("Health report leaks no credentials",
    !/sk_test|sk_live|whsec_|password|OPEN_AI_KEY/i.test(healthStr));

  // When HEALTHCHECK_TOKEN is configured the probe must demand it; when it is
  // not, the probe stays open (it carries no internal detail either way).
  const probeNoToken = await fetch(`${BASE}/platform/health/probe`);
  const probeWithToken = await fetch(`${BASE}/platform/health/probe`, {
    headers: { "X-Health-Token": "probe-token-123" },
  });
  const tokenConfigured = probeNoToken.status === 401;
  record("Uptime probe works",
    tokenConfigured ? probeWithToken.status === 200 : probeNoToken.status === 200,
    tokenConfigured ? "token required and accepted" : "open probe");
  record("Uptime probe rejects a wrong token when one is configured",
    !tokenConfigured ||
      (await fetch(`${BASE}/platform/health/probe`, {
        headers: { "X-Health-Token": "wrong-token" },
      })).status === 401);

  console.log("\n=== BRANDING ===");
  const branding = await fetch(`${BASE}/platform/branding`).then((r) => r.json());
  record("Branding is env-driven", branding?.branding?.appName === "Acme AI Operations",
    branding?.branding?.appName);
  const brandStr = JSON.stringify(branding);
  record("No upstream marketing in branding payload",
    !/mintplex|anythingllm/i.test(brandStr));

  console.log("\n=== ERROR HANDLING ===");
  const notFound = await api("/business/agents/does-not-exist-uuid");
  record("Unknown resource returns a clean error",
    notFound.status === 404 && !JSON.stringify(notFound.json).includes("at Object."),
    notFound.json?.error);

  summarize();
})();

function summarize() {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed);
  console.log("\n" + "=".repeat(60));
  console.log(`ACCEPTANCE: ${passed}/${results.length} passed`);
  if (failed.length) {
    console.log("\nFAILURES:");
    failed.forEach((f) => console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ""}`));
  }
  console.log("=".repeat(60));
  process.exit(failed.length ? 1 : 0);
}
