const { v4: uuidv4 } = require("uuid");
const prisma = require("../../utils/prisma");
const { AuditLog } = require("../models/audit");

/**
 * AI Quality test centre.
 *
 * This is regression testing for business-critical answers, not an academic
 * evaluation harness. A test states a question plus the concepts a correct
 * answer must contain; the runner asks the real agent through the real RAG
 * pipeline and grades the response deterministically.
 *
 * Verdicts:
 *   passed       - every expected concept present (and the required source cited)
 *   needs_review - most concepts present, or the source citation is missing
 *   failed       - the agent refused, errored, or missed most concepts
 */

const VERDICTS = Object.freeze({
  PASSED: "passed",
  NEEDS_REVIEW: "needs_review",
  FAILED: "failed",
});

const PASS_THRESHOLD = 1.0; // all concepts
const REVIEW_THRESHOLD = 0.6; // most concepts

function parseConcepts(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed))
      return parsed.map((v) => String(v).trim()).filter(Boolean);
  } catch {
    /* fall through to delimiter splitting */
  }
  return String(value)
    .split(/[,;\n]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * Checks a concept against an answer. A concept matches when all of its
 * significant words appear in the answer, so "30 day refund" matches
 * "refunds are available for 30 days" without demanding an exact phrase.
 */
function conceptPresent(answer, concept) {
  const haystack = String(answer ?? "").toLowerCase();
  const words = String(concept)
    .toLowerCase()
    .replace(/[^a-z0-9\s%$.-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);

  if (!words.length) return false;
  return words.every((word) => haystack.includes(word));
}

/**
 * Grades a single answer.
 * @returns {{verdict: string, score: number, detail: string}}
 */
function grade({ answer, concepts = [], requiredSource = null, sources = [], errored = false }) {
  if (errored)
    return {
      verdict: VERDICTS.FAILED,
      score: 0,
      detail: "The agent returned an error.",
    };

  const text = String(answer ?? "").trim();
  if (!text)
    return {
      verdict: VERDICTS.FAILED,
      score: 0,
      detail: "The agent returned an empty answer.",
    };

  const { looksLikeRefusal } = require("./knowledgeGaps").KnowledgeGaps;
  if (looksLikeRefusal(text))
    return {
      verdict: VERDICTS.FAILED,
      score: 0,
      detail: "The agent could not answer from the approved knowledge.",
    };

  const expected = parseConcepts(concepts);
  const matched = expected.filter((concept) => conceptPresent(text, concept));
  const score = expected.length ? matched.length / expected.length : 1;

  const sourceNames = (sources ?? [])
    .map((s) => String(s?.title ?? s?.metadata?.title ?? s?.name ?? ""))
    .filter(Boolean);
  const sourceSatisfied = requiredSource
    ? sourceNames.some((name) =>
        name.toLowerCase().includes(String(requiredSource).toLowerCase())
      )
    : true;

  const missing = expected.filter((c) => !matched.includes(c));

  if (score >= PASS_THRESHOLD && sourceSatisfied)
    return {
      verdict: VERDICTS.PASSED,
      score,
      detail: expected.length
        ? `All ${expected.length} expected concept(s) present.`
        : "Answer produced.",
    };

  if (score >= PASS_THRESHOLD && !sourceSatisfied)
    return {
      verdict: VERDICTS.NEEDS_REVIEW,
      score,
      detail: `Concepts present, but the required source "${requiredSource}" was not cited.`,
    };

  if (score >= REVIEW_THRESHOLD)
    return {
      verdict: VERDICTS.NEEDS_REVIEW,
      score,
      detail: `Missing concept(s): ${missing.join(", ")}.`,
    };

  return {
    verdict: VERDICTS.FAILED,
    score,
    detail: expected.length
      ? `Missing concept(s): ${missing.join(", ")}.`
      : "Answer did not meet expectations.",
  };
}

const AIQuality = {
  VERDICTS,
  grade,
  conceptPresent,
  parseConcepts,

  createTest: async function (params = {}) {
    const question = String(params.question ?? "").trim();
    if (!question) return { test: null, error: "A question is required." };

    try {
      const test = await prisma.quality_tests.create({
        data: {
          uuid: uuidv4(),
          question: question.slice(0, 2_000),
          expected_answer: params.expectedAnswer
            ? String(params.expectedAnswer).slice(0, 4_000)
            : null,
          expected_concepts: JSON.stringify(parseConcepts(params.expectedConcepts)),
          required_source: params.requiredSource
            ? String(params.requiredSource).slice(0, 500)
            : null,
          agent_profile_id: params.agentProfileId ? Number(params.agentProfileId) : null,
          workspace_id: params.workspaceId ? Number(params.workspaceId) : null,
          enabled: params.enabled === undefined ? true : Boolean(params.enabled),
          createdBy: params.actor?.id ? Number(params.actor.id) : null,
        },
      });

      await AuditLog.log({
        action: "quality_test.created",
        category: AuditLog.CATEGORIES.SETTINGS,
        actor: params.actor ?? null,
        resource: "quality_test",
        resourceId: test.uuid,
      });
      return { test, error: null };
    } catch (error) {
      console.error("[AIQuality] createTest failed:", error.message);
      return { test: null, error: "Unable to create the test." };
    }
  },

  updateTest: async function ({ uuid, patch = {}, actor = null }) {
    try {
      const data = { lastUpdatedAt: new Date() };
      if (patch.question !== undefined)
        data.question = String(patch.question).slice(0, 2_000);
      if (patch.expectedAnswer !== undefined)
        data.expected_answer = patch.expectedAnswer
          ? String(patch.expectedAnswer).slice(0, 4_000)
          : null;
      if (patch.expectedConcepts !== undefined)
        data.expected_concepts = JSON.stringify(parseConcepts(patch.expectedConcepts));
      if (patch.requiredSource !== undefined)
        data.required_source = patch.requiredSource
          ? String(patch.requiredSource).slice(0, 500)
          : null;
      if (patch.agentProfileId !== undefined)
        data.agent_profile_id = patch.agentProfileId
          ? Number(patch.agentProfileId)
          : null;
      if (patch.enabled !== undefined) data.enabled = Boolean(patch.enabled);

      const test = await prisma.quality_tests.update({
        where: { uuid: String(uuid) },
        data,
      });
      await AuditLog.log({
        action: "quality_test.updated",
        category: AuditLog.CATEGORIES.SETTINGS,
        actor,
        resource: "quality_test",
        resourceId: uuid,
      });
      return { success: true, test };
    } catch (error) {
      console.error("[AIQuality] updateTest failed:", error.message);
      return { success: false, error: "Unable to update the test." };
    }
  },

  deleteTest: async function ({ uuid, actor = null }) {
    try {
      const test = await prisma.quality_tests.findUnique({
        where: { uuid: String(uuid) },
      });
      if (!test) return { success: false, error: "Test not found." };
      await prisma.quality_results.deleteMany({ where: { test_id: test.id } });
      await prisma.quality_tests.delete({ where: { uuid: String(uuid) } });
      await AuditLog.log({
        action: "quality_test.removed",
        category: AuditLog.CATEGORIES.SETTINGS,
        actor,
        resource: "quality_test",
        resourceId: uuid,
      });
      return { success: true };
    } catch (error) {
      console.error("[AIQuality] deleteTest failed:", error.message);
      return { success: false, error: "Unable to remove the test." };
    }
  },

  tests: async function (clause = {}) {
    try {
      return await prisma.quality_tests.findMany({
        where: clause,
        orderBy: { id: "asc" },
      });
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  /**
   * Executes one test against its agent through the real chat pipeline, so a
   * pass genuinely means the production path answers correctly.
   */
  runTest: async function (test) {
    const { AgentProfile } = require("../models/agentProfile");
    const { Workspace } = require("../../models/workspace");

    let workspaceId = test.workspace_id;
    if (!workspaceId && test.agent_profile_id) {
      const agent = await prisma.agent_profiles.findUnique({
        where: { id: Number(test.agent_profile_id) },
      });
      workspaceId = agent?.workspace_id ?? null;
    }
    if (!workspaceId)
      return {
        ...grade({ answer: "", errored: true }),
        detail: "This test is not assigned to an agent.",
        answer: null,
        sources: [],
      };

    const workspace = await Workspace.get({ id: Number(workspaceId) });
    if (!workspace)
      return {
        ...grade({ answer: "", errored: true }),
        detail: "The agent's workspace no longer exists.",
        answer: null,
        sources: [],
      };

    try {
      // Runs through the same non-streaming handler the developer API uses, so
      // a passing test genuinely exercises the production RAG path.
      const { ApiChatHandler } = require("../../utils/chats/apiChatHandler");
      const result = await ApiChatHandler.chatSync({
        workspace,
        message: test.question,
        mode: workspace.chatMode === "chat" ? "chat" : "query",
        user: null,
        thread: null,
        sessionId: `quality-run-${uuidv4()}`,
      });

      if (result?.type === "abort" || result?.error)
        return {
          ...grade({ answer: "", errored: true }),
          detail: "The agent returned an error.",
          answer: null,
          sources: [],
        };

      const answer = result?.textResponse ?? "";
      const sources = result?.sources ?? [];
      const verdict = grade({
        answer,
        concepts: test.expected_concepts,
        requiredSource: test.required_source,
        sources,
      });

      return { ...verdict, answer, sources };
    } catch (error) {
      console.error("[AIQuality] runTest failed:", error.message);
      return {
        ...grade({ answer: "", errored: true }),
        detail: "The agent could not be reached.",
        answer: null,
        sources: [],
      };
    }
  },

  /** Runs the whole enabled suite and stores a historical run. */
  runSuite: async function ({ actor = null, testUuids = null } = {}) {
    const where = { enabled: true };
    if (Array.isArray(testUuids) && testUuids.length)
      where.uuid = { in: testUuids.map(String) };

    const tests = await this.tests(where);
    const run = await prisma.quality_runs.create({
      data: {
        uuid: uuidv4(),
        status: "running",
        total: tests.length,
        triggeredBy: actor?.id ? Number(actor.id) : null,
      },
    });

    let passed = 0;
    let needsReview = 0;
    let failed = 0;

    for (const test of tests) {
      const outcome = await this.runTest(test);
      if (outcome.verdict === VERDICTS.PASSED) passed += 1;
      else if (outcome.verdict === VERDICTS.NEEDS_REVIEW) needsReview += 1;
      else failed += 1;

      await prisma.quality_results.create({
        data: {
          run_id: run.id,
          test_id: test.id,
          verdict: outcome.verdict,
          score: outcome.score ?? null,
          answer: outcome.answer ? String(outcome.answer).slice(0, 8_000) : null,
          sources: JSON.stringify(
            (outcome.sources ?? [])
              .slice(0, 10)
              .map((s) => s?.title ?? s?.metadata?.title ?? null)
              .filter(Boolean)
          ),
          detail: outcome.detail ? String(outcome.detail).slice(0, 2_000) : null,
        },
      });
    }

    const completed = await prisma.quality_runs.update({
      where: { id: run.id },
      data: {
        status: "completed",
        passed,
        needs_review: needsReview,
        failed,
        completedAt: new Date(),
      },
    });

    await AuditLog.log({
      action: "quality_run.completed",
      category: AuditLog.CATEGORIES.SETTINGS,
      actor,
      resource: "quality_run",
      resourceId: completed.uuid,
      metadata: { total: tests.length, passed, needsReview, failed },
    });

    try {
      const { dispatch } = require("./notifier");
      await dispatch("quality_run.completed", {
        passed,
        needs_review: needsReview,
        failed,
        total: tests.length,
      });
    } catch (error) {
      console.error("[AIQuality] notification failed:", error.message);
    }

    return completed;
  },

  runs: async function (limit = 20) {
    try {
      return await prisma.quality_runs.findMany({
        take: Math.min(Number(limit) || 20, 100),
        orderBy: { startedAt: "desc" },
      });
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  runResults: async function (runUuid) {
    try {
      const run = await prisma.quality_runs.findUnique({
        where: { uuid: String(runUuid) },
      });
      if (!run) return { run: null, results: [] };

      const results = await prisma.quality_results.findMany({
        where: { run_id: run.id },
        orderBy: { id: "asc" },
      });
      const tests = await prisma.quality_tests.findMany({
        where: { id: { in: results.map((r) => r.test_id) } },
      });
      const byId = new Map(tests.map((t) => [t.id, t]));

      return {
        run,
        results: results.map((result) => ({
          ...result,
          question: byId.get(result.test_id)?.question ?? "(test removed)",
          testUuid: byId.get(result.test_id)?.uuid ?? null,
        })),
      };
    } catch (error) {
      console.error(error.message);
      return { run: null, results: [] };
    }
  },
};

module.exports = { AIQuality, VERDICTS };
