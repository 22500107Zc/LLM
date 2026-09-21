#!/usr/bin/env node
/**
 * Provider-backed end-to-end verification.
 *
 * Everything else in this repository verifies retrieval. This script verifies
 * the thing a customer actually experiences: a question asked through the real
 * production chat route, answered by the configured model, from the approved
 * knowledge, with a citation - and refused when the knowledge does not cover
 * the question.
 *
 * It needs a configured model provider. Without one it exits with
 *   BLOCKED: PROVIDER CREDENTIAL REQUIRED
 * and a non-zero status, and never pretends to have verified anything.
 *
 * THIS SUITE MUTATES DATA. Use a disposable deployment:
 *   ./scripts/run-disposable-acceptance.sh
 *
 * Standalone:
 *   BASE_URL=http://localhost:3001 \
 *   DOC_TEST_USER=<admin> DOC_TEST_PASSWORD=<password> \
 *     node scripts/provider-verification.cjs
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  assertSafeTarget,
  runId,
  ephemeralPassword,
  Results,
  Cleanup,
  apiClient,
} = require("./lib/harness.cjs");
const {
  ensureFixtures,
  PDF_FACTS,
  DOCX_FACTS,
  ABSENT_FACT_QUESTION,
} = require("./lib/fixtures.cjs");
const { AIQuality, VERDICTS } = require("./lib/grading-bridge.cjs");

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3001";
assertSafeTarget(BASE_URL, { suiteName: "The provider verification suite" });

const RUN = runId();
const FIXTURE_DIR =
  process.env.FIXTURE_DIR ?? path.join(os.tmpdir(), "platform-doc-fixtures");
const AGENT_A = `Provider Verify A ${RUN}`;
const AGENT_B = `Provider Verify B ${RUN}`;

const api = apiClient(BASE_URL);
const results = new Results("PROVIDER VERIFICATION");
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
  results.section("PROVIDER PRECONDITION");

  const token = await authenticate();
  if (!token) return;
  api.setToken(token);

  const health = await call("/business/health");
  const llm = health.json?.components?.llm ?? {};
  const providerReady = llm.status === "ok" && !!llm.provider;

  if (!providerReady) {
    console.log(
      [
        "",
        "\x1b[33m================================================================\x1b[0m",
        "\x1b[33m  BLOCKED: PROVIDER CREDENTIAL REQUIRED\x1b[0m",
        "",
        "  This deployment has no working model provider, so an answer cannot",
        "  be generated and answer correctness cannot be verified.",
        "",
        "  To run this verification, configure a provider on the deployment",
        "  (for example LLM_PROVIDER=openai with OPEN_AI_KEY) and re-run:",
        "",
        "    BASE_URL=" + BASE_URL + " \\",
        "    DOC_TEST_USER=<admin> DOC_TEST_PASSWORD=<password> \\",
        "      node scripts/provider-verification.cjs",
        "\x1b[33m================================================================\x1b[0m",
        "",
      ].join("\n")
    );
    results.blocked(
      "Provider-backed answer verification",
      `PROVIDER CREDENTIAL REQUIRED (provider=${llm.provider ?? "none"}, status=${llm.status})`
    );
    return;
  }

  results.record("Model provider is configured and reachable", true, `${llm.provider}${llm.model ? ` / ${llm.model}` : ""}`);

  results.section("KNOWLEDGE SETUP");

  const { pdfPath, docxPath } = await ensureFixtures(FIXTURE_DIR);
  const agentA = await createAgent(AGENT_A);
  const agentB = await createAgent(AGENT_B);
  if (!agentA || !agentB) {
    results.record("Two isolated agents created", false);
    return;
  }
  results.record("Two isolated agents created", true);

  await upload(agentA.workspace.slug, pdfPath, PDF_FACTS.filename, "application/pdf");
  await upload(
    agentA.workspace.slug,
    docxPath,
    DOCX_FACTS.filename,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );

  const available = await call("/business/knowledge/available");
  const paths = collectFiles(available.json?.localFiles ?? {}, null, []);
  const mine = [
    paths.filter((p) => p.includes(PDF_FACTS.filename)).pop(),
    paths.filter((p) => p.includes(DOCX_FACTS.filename)).pop(),
  ].filter(Boolean);

  const assign = await call("/business/knowledge/assign", {
    method: "POST",
    body: { agentUuid: agentA.uuid, adds: mine },
  });
  results.record(
    "Company knowledge embedded into agent A",
    assign.status === 200 && (assign.json?.failedToEmbed?.length ?? 1) === 0
  );
  cleanup.add("agent A documents", () =>
    call("/business/knowledge/assign", {
      method: "POST",
      body: { agentUuid: agentA.uuid, adds: [], deletes: mine },
    })
  );

  results.section("ANSWER CORRECTNESS THROUGH THE PRODUCTION CHAT ROUTE");

  const refund = await ask(agentA.workspace.slug, PDF_FACTS.question);
  results.record("Agent answered the PDF-backed question", !!refund.text, truncate(refund.text));

  // Graded by the same clause-aware grader the product uses, so a negated or
  // numerically wrong answer fails here exactly as it would in AI Quality.
  const refundGrade = AIQuality.grade({
    answer: refund.text,
    concepts: PDF_FACTS.expectedConcepts,
    sources: refund.sources,
  });
  results.record(
    "The answer states the correct fact",
    refundGrade.verdict === VERDICTS.PASSED,
    refundGrade.detail
  );
  results.record(
    "The answer cites the source document",
    refund.titles.some((t) => t.includes(PDF_FACTS.filename)),
    refund.titles.join(", ") || "no citation"
  );

  const hours = await ask(agentA.workspace.slug, DOCX_FACTS.question);
  const hoursGrade = AIQuality.grade({
    answer: hours.text,
    concepts: DOCX_FACTS.expectedConcepts,
    sources: hours.sources,
  });
  results.record(
    "The DOCX-backed question is answered correctly",
    hoursGrade.verdict === VERDICTS.PASSED,
    hoursGrade.detail
  );
  results.record(
    "The DOCX answer cites its source",
    hours.titles.some((t) => t.includes(DOCX_FACTS.filename)),
    hours.titles.join(", ") || "no citation"
  );

  results.section("REFUSAL WHEN THE KNOWLEDGE DOES NOT COVER THE QUESTION");

  const absent = await ask(agentA.workspace.slug, ABSENT_FACT_QUESTION);
  const { KnowledgeGaps } = require("./lib/grading-bridge.cjs");
  const refused = KnowledgeGaps.looksLikeRefusal(absent.text, agentA.fallbackMessage);
  results.record(
    "The agent refuses rather than inventing an answer",
    refused,
    truncate(absent.text)
  );
  results.record(
    "The refusal invents no figure",
    !/\b\d{2,}\b/.test(String(absent.text ?? "")),
    "no fabricated number in the refusal"
  );

  results.section("ISOLATION BETWEEN AGENTS");

  const leak = await ask(agentB.workspace.slug, PDF_FACTS.question);
  const leakedFact = /30\s*days?/i.test(String(leak.text ?? ""));
  results.record(
    "Agent B cannot answer from agent A's knowledge",
    !leakedFact,
    truncate(leak.text)
  );
  results.record(
    "Agent B cites nothing from agent A's documents",
    !(leak.titles ?? []).some((t) => t.includes(PDF_FACTS.filename)),
    (leak.titles ?? []).join(", ") || "no citations"
  );

  results.section("PUBLIC EXPOSURE DOES NOT LEAK PRIVATE KNOWLEDGE");

  // A public website agent bound to agent B must not surface agent A's facts.
  const embed = await call("/business/website-agents", {
    method: "POST",
    body: {
      agentUuid: agentB.uuid,
      allowlistDomains: ["https://provider-verify.example.invalid"],
      maxChatsPerDay: 20,
      maxChatsPerSession: 5,
    },
  });
  const embedId = embed.json?.websiteAgent?.uuid ?? null;
  if (embedId) {
    cleanup.add("website agent", () =>
      call(`/business/website-agents/${embedId}`, { method: "DELETE" })
    );
    const publicAnswer = await askPublic(embedId, PDF_FACTS.question);
    results.record(
      "A public agent does not surface another agent's private knowledge",
      !/30\s*days?/i.test(publicAnswer),
      truncate(publicAnswer)
    );
  } else {
    results.record("Public website agent created for the leak check", false, embed.json?.error);
  }
}

// ------------------------------------------------------------- helpers -----
async function authenticate() {
  const user = process.env.DOC_TEST_USER;
  const password = process.env.DOC_TEST_PASSWORD;

  if (user && password) {
    const login = await call("/request-token", {
      method: "POST",
      body: { username: user, password },
      token: null,
    });
    results.record("Authenticated", !!login.json?.token);
    return login.json?.token ?? null;
  }

  const mode = await call("/system/multi-user-mode", { token: null });
  if (mode.json?.multiUserMode) {
    results.blocked(
      "Authentication",
      "Supply DOC_TEST_USER and DOC_TEST_PASSWORD, or use ./scripts/run-disposable-acceptance.sh."
    );
    return null;
  }

  const credentials = { username: `prov-owner-${RUN}`, password: ephemeralPassword() };
  const enabled = await call("/system/enable-multi-user", {
    method: "POST",
    body: credentials,
    token: null,
  });
  if (!enabled.json?.success) {
    results.record("Bootstrapped a temporary owner", false, enabled.json?.error ?? "");
    return null;
  }
  const login = await call("/request-token", {
    method: "POST",
    body: credentials,
    token: null,
  });
  results.record("Authenticated as the temporary owner", !!login.json?.token);
  return login.json?.token ?? null;
}

async function createAgent(name) {
  const created = await call("/business/agents", {
    method: "POST",
    body: { name, template: "internal_knowledge" },
  });
  const agent = created.json?.agent ?? null;
  if (agent)
    cleanup.add(`agent ${name}`, () =>
      call(`/business/agents/${agent.uuid}`, { method: "DELETE" })
    );
  return agent;
}

async function upload(slug, file, name, mime) {
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(file)], { type: mime }), name);
  return api.raw(`/workspace/${slug}/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${api.getToken()}` },
    body: form,
  });
}

function collectFiles(node, folder, acc) {
  if (node?.type === "file" && folder) acc.push(`${folder}/${node.name}`);
  for (const child of node?.items ?? [])
    collectFiles(child, node?.type === "folder" ? node.name : folder, acc);
  return acc;
}

/**
 * Asks a question through the real authenticated chat route and reassembles
 * the streamed response, so this exercises the production path rather than an
 * internal helper.
 */
async function ask(slug, message) {
  const response = await api.raw(`/workspace/${slug}/stream-chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${api.getToken()}`,
    },
    body: JSON.stringify({ message, mode: "query", attachments: [] }),
  });
  return parseStream(await response.text());
}

/** Asks through the public website-agent route. */
async function askPublic(embedId, message) {
  const response = await api.raw(`/embed/${embedId}/stream-chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://provider-verify.example.invalid",
    },
    body: JSON.stringify({ sessionId: crypto.randomUUID(), message }),
  });
  return parseStream(await response.text()).text;
}

/** Reassembles a server-sent-events chat stream into text plus sources. */
function parseStream(raw) {
  let text = "";
  let sources = [];
  for (const line of String(raw).split("\n")) {
    if (!line.startsWith("data:")) continue;
    let payload;
    try {
      payload = JSON.parse(line.slice(5).trim());
    } catch {
      continue;
    }
    if (payload.textResponse) text += payload.textResponse;
    if (Array.isArray(payload.sources) && payload.sources.length) sources = payload.sources;
    if (payload.error) text += ` [error: ${payload.error}]`;
  }
  return {
    text: text.trim(),
    sources,
    titles: [...new Set(sources.map((s) => s?.title).filter(Boolean))],
  };
}

function truncate(text, max = 110) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean || "(empty)";
}
