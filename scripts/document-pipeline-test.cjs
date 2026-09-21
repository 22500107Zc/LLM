#!/usr/bin/env node
/**
 * Document pipeline: PDF and DOCX ingestion, embedding, retrieval, source
 * attribution, namespace isolation, persistence and refusal.
 *
 * THIS SUITE MUTATES DATA. Use a disposable deployment:
 *   ./scripts/run-disposable-acceptance.sh
 *
 * Standalone, against a running local test server:
 *   node scripts/document-pipeline-test.cjs
 *
 * Configuration (all optional):
 *   BASE_URL       default http://localhost:3001
 *   COLLECTOR_URL  default http://localhost:8888
 *   FIXTURE_DIR    where the PDF/DOCX fixtures live (generated if absent)
 *   DOC_TEST_USER / DOC_TEST_PASSWORD  an existing admin to run as; when
 *                  omitted the suite bootstraps its own temporary owner
 *
 * Retrieval is asserted directly against the vector store. Generating the
 * final natural-language answer needs a model provider and is covered
 * separately by scripts/provider-verification.cjs - the two are reported
 * distinctly so a vector hit is never mistaken for a correct answer.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  SERVER_DIR,
  serverRequire,
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

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3001";
const COLLECTOR_URL = process.env.COLLECTOR_URL ?? "http://localhost:8888";
assertSafeTarget(BASE_URL, { suiteName: "The document pipeline suite" });

const RUN = runId();
const FIXTURE_DIR =
  process.env.FIXTURE_DIR ?? path.join(os.tmpdir(), "platform-doc-fixtures");
const AGENT_A = `Doc Pipeline A ${RUN}`;
const AGENT_B = `Doc Pipeline B ${RUN}`;

const api = apiClient(BASE_URL);
const results = new Results("DOCUMENT PIPELINE");
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
  results.section("PRECONDITIONS");

  const collectorUp = await fetch(COLLECTOR_URL)
    .then((r) => r.ok)
    .catch(() => false);
  results.record(
    "Document processor is reachable",
    collectorUp,
    collectorUp ? COLLECTOR_URL : `start it: cd collector && node index.js`
  );
  if (!collectorUp) return;

  const token = await authenticate();
  if (!token) return;
  api.setToken(token);

  const { pdfPath, docxPath } = await ensureFixtures(FIXTURE_DIR);
  results.record("Fixtures available", fs.existsSync(pdfPath) && fs.existsSync(docxPath), FIXTURE_DIR);

  results.section("AGENT SETUP");

  const agentA = await createAgent(AGENT_A, "internal_knowledge");
  const agentB = await createAgent(AGENT_B, "internal_knowledge");
  results.record("Two isolated agents created", !!agentA && !!agentB);
  if (!agentA || !agentB) return;

  results.section("INGESTION");

  const pdfUpload = await upload(agentA.workspace.slug, pdfPath, PDF_FACTS.filename, "application/pdf");
  results.record("PDF upload accepted", pdfUpload.ok, pdfUpload.error ?? "");

  const docxUpload = await upload(
    agentA.workspace.slug,
    docxPath,
    DOCX_FACTS.filename,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
  results.record("DOCX upload accepted", docxUpload.ok, docxUpload.error ?? "");

  results.section("EMBEDDING");

  const available = await call("/business/knowledge/available");
  const paths = collectFiles(available.json?.localFiles ?? {}, null, []);
  const mine = [
    paths.filter((p) => p.includes(PDF_FACTS.filename)).pop(),
    paths.filter((p) => p.includes(DOCX_FACTS.filename)).pop(),
  ].filter(Boolean);
  results.record("Parsed documents available to attach", mine.length === 2);

  const assign = await call("/business/knowledge/assign", {
    method: "POST",
    body: { agentUuid: agentA.uuid, adds: mine },
  });
  results.record(
    "Documents embedded into agent A",
    assign.status === 200 && (assign.json?.failedToEmbed?.length ?? 1) === 0,
    assign.json?.error ?? `${mine.length} document(s)`
  );
  cleanup.add("agent A documents", () =>
    call("/business/knowledge/assign", {
      method: "POST",
      body: { agentUuid: agentA.uuid, adds: [], deletes: mine },
    })
  );

  const knowledge = await call(`/business/knowledge?agentUuid=${agentA.uuid}`);
  const titles = (knowledge.json?.documents ?? []).map((d) => d.title);
  results.record("PDF is listed in Knowledge", titles.some((t) => t.includes(PDF_FACTS.filename)));
  results.record("DOCX is listed in Knowledge", titles.some((t) => t.includes(DOCX_FACTS.filename)));
  results.record(
    "Processing status is reported",
    (knowledge.json?.documents ?? []).every((d) => d.status === "processed"),
    (knowledge.json?.documents ?? []).map((d) => d.status).join(", ")
  );

  results.section("VECTOR RETRIEVAL (not answer generation)");

  const { VectorDb, retriever } = loadVectorStack();
  const namespaceA = agentA.workspace.slug;
  const namespaceB = agentB.workspace.slug;

  const count = await VectorDb.namespaceCount(namespaceA);
  results.record("Vectors written to agent A's namespace", count > 0, `${count} chunk(s)`);

  const refund = await search(VectorDb, retriever, namespaceA, PDF_FACTS.question);
  results.record(
    "Retrieval finds the PDF passage",
    /30 days/i.test(refund.text),
    `${refund.sources.length} source(s)`
  );
  results.record(
    "Retrieved chunks carry the PDF as their source",
    refund.titles.some((t) => t.includes(PDF_FACTS.filename)),
    refund.titles.join(", ")
  );

  const hours = await search(VectorDb, retriever, namespaceA, DOCX_FACTS.question);
  results.record("Retrieval finds the DOCX passage", /5pm/i.test(hours.text), hours.titles.join(", "));

  results.section("NAMESPACE ISOLATION");

  results.record(
    "Agent B's namespace is empty",
    (await VectorDb.namespaceCount(namespaceB)) === 0
  );
  const leak = await search(VectorDb, retriever, namespaceB, PDF_FACTS.question);
  results.record("Agent B retrieves nothing from agent A's knowledge", leak.chunks === 0);

  results.section("PERSISTENCE");

  // The vector store and database are on disk; re-opening the store in a fresh
  // client proves the data is persisted rather than held in process memory.
  const { VectorDb: reopened, retriever: retriever2 } = loadVectorStack({ fresh: true });
  const persisted = await reopened.namespaceCount(namespaceA);
  results.record("Vectors persist in a freshly opened store", persisted === count, `${persisted} chunk(s)`);
  const afterReopen = await search(reopened, retriever2, namespaceA, PDF_FACTS.question);
  results.record("Retrieval still works after re-opening the store", /30 days/i.test(afterReopen.text));

  const docsAfter = await call(`/business/knowledge?agentUuid=${agentA.uuid}`);
  results.record(
    "Documents still recorded in the database",
    (docsAfter.json?.documents?.length ?? 0) >= 2
  );

  results.section("REFUSAL WHEN INFORMATION IS ABSENT");

  const absent = await search(VectorDb, retriever, namespaceA, ABSENT_FACT_QUESTION, {
    similarityThreshold: 0.75,
  });
  results.record(
    "A question the documents do not answer retrieves no confident context",
    absent.chunks === 0,
    `${absent.chunks} chunk(s) above the confidence threshold`
  );
  results.record(
    "Agent is configured to refuse rather than invent",
    agentA.workspace.chatMode === "query" &&
      /approved company knowledge/i.test(agentA.fallbackMessage ?? ""),
    `chatMode=${agentA.workspace.chatMode}`
  );
  results.blocked(
    "Natural-language refusal wording (end to end)",
    "Needs a model provider. Covered by scripts/provider-verification.cjs."
  );
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
    results.record("Authenticated with the supplied credentials", !!login.json?.token);
    return login.json?.token ?? null;
  }

  // Bootstrap a temporary owner on a fresh disposable deployment.
  const mode = await call("/system/multi-user-mode", { token: null });
  const credentials = {
    username: `doc-owner-${RUN}`,
    password: ephemeralPassword(),
  };

  if (!mode.json?.multiUserMode) {
    const enabled = await call("/system/enable-multi-user", {
      method: "POST",
      body: credentials,
      token: null,
    });
    if (!enabled.json?.success) {
      results.record("Bootstrapped a temporary owner", false, enabled.json?.error ?? "");
      return null;
    }
  } else {
    results.blocked(
      "Authentication",
      "This deployment is already initialised. Supply DOC_TEST_USER and DOC_TEST_PASSWORD, or use ./scripts/run-disposable-acceptance.sh."
    );
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

async function createAgent(name, template) {
  const created = await call("/business/agents", {
    method: "POST",
    body: { name, template },
  });
  const agent = created.json?.agent ?? null;
  if (agent)
    cleanup.add(`agent ${name}`, () =>
      call(`/business/agents/${agent.uuid}`, { method: "DELETE" })
    );
  else console.log(`  (agent "${name}" could not be created: ${created.json?.error})`);
  return agent;
}

async function upload(slug, file, name, mime) {
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(file)], { type: mime }), name);
  const response = await api.raw(`/workspace/${slug}/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${api.getToken()}` },
    body: form,
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return {
    ok: response.status === 200 && json?.success !== false,
    error: json?.error ?? null,
  };
}

function collectFiles(node, folder, acc) {
  if (node?.type === "file" && folder) acc.push(`${folder}/${node.name}`);
  for (const child of node?.items ?? [])
    collectFiles(child, node?.type === "folder" ? node.name : folder, acc);
  return acc;
}

/**
 * Loads the vector store and an embedder-only connector. Retrieval needs the
 * embedder; the chat model is deliberately not constructed so this works
 * without a provider key.
 */
function loadVectorStack({ fresh = false } = {}) {
  if (fresh) {
    // Drop the cached modules so the store is genuinely re-opened from disk.
    for (const key of Object.keys(require.cache))
      if (key.includes(path.join(SERVER_DIR, "utils"))) delete require.cache[key];
  }
  const helpers = serverRequire("utils/helpers");
  const VectorDb = helpers.getVectorDbClass();
  const embedder = helpers.getEmbeddingEngineSelection();
  return {
    VectorDb,
    retriever: { embedder, embedTextInput: (t) => embedder.embedTextInput(t) },
  };
}

async function search(VectorDb, retriever, namespace, input, { similarityThreshold = 0.1 } = {}) {
  const hit = await VectorDb.performSimilaritySearch({
    namespace,
    input,
    LLMConnector: retriever,
    similarityThreshold,
    topN: 4,
  });
  const contexts = hit.contextTexts ?? [];
  return {
    text: contexts.join(" "),
    chunks: contexts.length,
    sources: hit.sources ?? [],
    titles: [...new Set((hit.sources ?? []).map((s) => s?.title).filter(Boolean))],
  };
}
