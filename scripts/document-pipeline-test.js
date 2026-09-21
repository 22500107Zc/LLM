/**
 * Document pipeline acceptance: PDF + DOCX ingestion, embedding, RAG retrieval
 * with citations, and per-agent knowledge isolation.
 *
 * Retrieval is exercised directly against the vector store because generating
 * the final natural-language answer needs a model provider key, which this
 * environment does not have. Everything up to and including retrieval and
 * citation is real.
 */
const fs = require("fs");
const BASE = "http://localhost:3001/api";
const DOCS = process.env.DOCS_DIR;
let TOKEN = null;
const out = [];
const rec = (n, ok, d = "") => {
  out.push(ok);
  console.log(`${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${n}${d ? `  — ${d}` : ""}`);
};

async function api(p, o = {}) {
  const r = await fetch(`${BASE}${p}`, {
    method: o.method ?? "GET",
    headers: {
      ...(o.body ? { "Content-Type": "application/json" } : {}),
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    ...(o.body ? { body: JSON.stringify(o.body) } : {}),
  });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}

async function upload(slug, file, name, mime) {
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(file)], { type: mime }), name);
  const r = await fetch(`${BASE}/workspace/${slug}/upload`, {
    method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: form,
  });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}

function collectFiles(node, folder, acc) {
  if (node?.type === "file" && folder) acc.push(`${folder}/${node.name}`);
  for (const child of node?.items ?? [])
    collectFiles(child, node?.type === "folder" ? node.name : folder, acc);
  return acc;
}

(async () => {
  const login = await api("/request-token", {
    method: "POST",
    body: { username: "acmeowner", password: "Str0ng-Owner-Pass!2026" },
  });
  TOKEN = login.json?.token;
  rec("Authenticated", !!TOKEN);
  if (!TOKEN) return done();

  const agents = await api("/business/agents");
  const agent =
    agents.json?.agents?.find((a) => a.name === "Acceptance Support Agent") ??
    agents.json?.agents?.[0];
  rec("Agent available", !!agent, agent?.name);
  if (!agent) return done();
  const slug = agent.workspace.slug;

  console.log("\n=== INGESTION ===");
  const pdf = await upload(slug, `${DOCS}/refund-policy.pdf`, "refund-policy.pdf",
    "application/pdf");
  rec("PDF upload accepted", pdf.status === 200 && pdf.json?.success !== false,
    pdf.json?.error ?? "ok");

  const docx = await upload(slug, `${DOCS}/support-hours.docx`, "support-hours.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  rec("DOCX upload accepted", docx.status === 200 && docx.json?.success !== false,
    docx.json?.error ?? "ok");

  console.log("\n=== ATTACH TO AGENT (chunk + embed) ===");
  const available = await api("/business/knowledge/available");
  const all = collectFiles(available.json?.localFiles ?? {}, null, []);
  const wanted = [
    all.filter((p) => /refund-policy/.test(p)).pop(),
    all.filter((p) => /support-hours/.test(p)).pop(),
  ].filter(Boolean);
  rec("Parsed documents available to attach", wanted.length === 2,
    wanted.map((w) => w.split("/").pop()).join(", "));

  const assign = await api("/business/knowledge/assign", {
    method: "POST", body: { agentUuid: agent.uuid, adds: wanted },
  });
  rec("Documents embedded into the agent",
    assign.status === 200 && (assign.json?.failedToEmbed?.length ?? 1) === 0,
    assign.json?.error ?? `${wanted.length} document(s)`);

  const knowledge = await api(`/business/knowledge?agentUuid=${agent.uuid}`);
  const titles = (knowledge.json?.documents ?? []).map((d) => d.title);
  rec("Documents appear in Knowledge", titles.length >= 2, titles.join(", "));
  rec("PDF is listed", titles.some((t) => /refund-policy/i.test(t)));
  rec("DOCX is listed", titles.some((t) => /support-hours/i.test(t)));
  rec("Processing status is shown",
    (knowledge.json?.documents ?? []).every((d) => d.status === "processed"),
    (knowledge.json?.documents ?? []).map((d) => d.status).join(", "));

  console.log("\n=== RAG RETRIEVAL + CITATIONS ===");
  const helpers = require("/home/user/LLM/server/utils/helpers");
  const VectorDb = helpers.getVectorDbClass();
  const embedder = helpers.getEmbeddingEngineSelection();
  // Retrieval needs only the embedder; the chat model produces the final
  // prose answer and is out of scope without a provider key.
  const retriever = { embedder, embedTextInput: (t) => embedder.embedTextInput(t) };

  const count = await VectorDb.namespaceCount(slug);
  rec("Vectors written to the agent's namespace", count > 0, `${count} chunk(s)`);

  const refund = await VectorDb.performSimilaritySearch({
    namespace: slug,
    input: "How long do I have to request a refund?",
    LLMConnector: retriever,
    similarityThreshold: 0.1,
    topN: 4,
  });
  rec("RAG retrieves the refund passage from the PDF",
    /30 days/.test((refund.contextTexts ?? []).join(" ")),
    `${refund.sources?.length ?? 0} source(s)`);
  rec("Retrieved chunks carry source citations",
    (refund.sources ?? []).some((s) => /refund-policy/.test(s.title ?? "")),
    [...new Set((refund.sources ?? []).map((s) => s.title))].join(", "));

  const hours = await VectorDb.performSimilaritySearch({
    namespace: slug,
    input: "What time does support close?",
    LLMConnector: retriever,
    similarityThreshold: 0.1,
    topN: 4,
  });
  rec("RAG retrieves from the DOCX",
    /5pm/i.test((hours.contextTexts ?? []).join(" ")),
    [...new Set((hours.sources ?? []).map((s) => s.title))].join(", "));

  console.log("\n=== KNOWLEDGE ISOLATION ===");
  const other = await api("/business/agents", {
    method: "POST", body: { name: "Isolation Probe", template: "internal_knowledge" },
  });
  const otherSlug = other.json?.agent?.workspace?.slug;
  if (otherSlug) {
    const otherCount = await VectorDb.namespaceCount(otherSlug);
    rec("A second agent cannot see the first agent's documents", otherCount === 0,
      `${otherCount} chunk(s) in "${otherSlug}"`);
    const leak = await VectorDb.performSimilaritySearch({
      namespace: otherSlug,
      input: "How long do I have to request a refund?",
      LLMConnector: retriever,
      similarityThreshold: 0.1,
      topN: 4,
    });
    rec("A second agent retrieves nothing from the first agent's knowledge",
      (leak.contextTexts ?? []).length === 0);
    await api(`/business/agents/${other.json.agent.uuid}`, { method: "DELETE" });
  } else {
    rec("A second agent cannot see the first agent's documents", false,
      other.json?.error);
  }

  done();
})();

function done() {
  const passed = out.filter(Boolean).length;
  console.log("\n" + "=".repeat(62));
  console.log(`DOCUMENT PIPELINE: ${passed}/${out.length} passed`);
  console.log("=".repeat(62));
  process.exit(passed === out.length ? 0 : 1);
}
