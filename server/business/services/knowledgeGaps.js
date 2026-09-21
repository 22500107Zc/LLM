const prisma = require("../../utils/prisma");
const config = require("../config");

/**
 * Knowledge-gap detection.
 *
 * Every answered question is inspected cheaply (no extra LLM call) for the
 * signals that mean "the approved knowledge did not cover this":
 *   - the answer came back with no sources at all
 *   - the answer was the configured refusal / fallback message
 *   - the answer contains an explicit "I don't know" style admission
 *   - a user left negative feedback
 *   - the conversation was escalated because knowledge was missing
 *
 * Similar questions are grouped by a normalized form so the dashboard shows
 * "this was asked 14 times" rather than 14 separate rows.
 */

const REASONS = Object.freeze({
  NO_SOURCES: "no_sources",
  REFUSAL: "refusal",
  LOW_CONFIDENCE: "low_confidence",
  NEGATIVE_FEEDBACK: "negative_feedback",
  ESCALATED: "escalated",
});

const STATUSES = Object.freeze([
  "open",
  "in_progress",
  "resolved",
  "dismissed",
]);

/** Phrases that indicate the model admitted it could not answer. */
const REFUSAL_PATTERNS = [
  /\bi (?:could ?n[o']?t|can ?n[o']?t|do ?n[o']?t|don't|cannot) find\b/i,
  /\bi (?:do ?n[o']?t|don't) (?:have|know)\b/i,
  /\bno (?:relevant )?information (?:was )?(?:found|available)\b/i,
  /\bnot (?:covered|available|found) in the (?:approved |provided |company )?(?:knowledge|documents?|context)\b/i,
  /\bunable to (?:answer|find|locate)\b/i,
  /\bi'?m (?:not sure|unsure|afraid i (?:do ?n[o']?t|don't))\b/i,
  /\bthere is no (?:information|mention)\b/i,
];

/** Very common words that carry no topical signal when grouping questions. */
const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "do",
  "does",
  "did",
  "doing",
  "have",
  "has",
  "had",
  "i",
  "you",
  "we",
  "they",
  "it",
  "he",
  "she",
  "me",
  "my",
  "your",
  "our",
  "their",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "at",
  "by",
  "from",
  "about",
  "as",
  "into",
  "and",
  "or",
  "but",
  "if",
  "then",
  "than",
  "so",
  "can",
  "could",
  "will",
  "would",
  "should",
  "there",
  "here",
  "what",
  "whats",
  "how",
  "when",
  "where",
  "who",
  "which",
  "why",
  "please",
  "tell",
  "know",
  "get",
  "any",
  "some",
  "this",
  "that",
  "these",
  "those",
  "am",
  "want",
  "need",
  "help",
]);

const MIN_QUESTION_LENGTH = 6;
const MAX_QUESTION_LENGTH = 500;

/**
 * Reduces a question to a stable grouping key: lowercased, punctuation
 * stripped, stop words removed, remaining words sorted and de-duplicated.
 * "What is your refund policy?" and "your refund policy is what" collapse
 * onto the same key, while genuinely different questions stay apart.
 */
function normalizeQuestion(question) {
  const words = String(question ?? "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));

  // Light stemming so different forms of the same topic group together.
  // This is deliberately heuristic - it only needs to be good enough to count
  // "how do I get a refund" and "refunds?" as one question, not to be correct
  // linguistics.
  const stemmed = words.map((word) => {
    let stem = word;

    // Verb endings: "offered" -> "offer", "shipping" -> "ship".
    if (stem.length > 5 && stem.endsWith("ing")) stem = stem.slice(0, -3);
    else if (stem.length > 4 && stem.endsWith("ed")) stem = stem.slice(0, -2);

    // Undo the consonant doubling that those endings introduce.
    if (stem.length > 3 && /([bdfglmnprt])\1$/.test(stem))
      stem = stem.slice(0, -1);

    // Plural endings: "policies" -> "policy", "boxes" -> "box".
    if (stem.length > 4 && stem.endsWith("ies")) return `${stem.slice(0, -3)}y`;
    if (stem.length > 4 && /(?:ch|sh|ss|x|z)es$/.test(stem))
      return stem.slice(0, -2);
    if (stem.length > 3 && stem.endsWith("s") && !stem.endsWith("ss"))
      return stem.slice(0, -1);

    return stem;
  });

  return [...new Set(stemmed)].sort().join(" ").slice(0, 300);
}

function looksLikeRefusal(text, fallbackMessage = null) {
  const answer = String(text ?? "").trim();
  if (!answer) return true;
  if (
    fallbackMessage &&
    answer
      .toLowerCase()
      .includes(String(fallbackMessage).toLowerCase().slice(0, 40))
  )
    return true;
  return REFUSAL_PATTERNS.some((pattern) => pattern.test(answer));
}

/**
 * Decides whether an exchange represents a knowledge gap.
 * @param {{question: string, answer: string, sources?: any[], fallbackMessage?: string|null, feedback?: boolean|null, escalated?: boolean}} exchange
 * @returns {{isGap: boolean, reasons: string[]}}
 */
function evaluate(exchange = {}) {
  const reasons = [];
  const question = String(exchange.question ?? "").trim();

  // Ignore greetings and other non-questions - they are not knowledge gaps.
  if (question.length < MIN_QUESTION_LENGTH) return { isGap: false, reasons };

  const sourceCount = Array.isArray(exchange.sources)
    ? exchange.sources.length
    : 0;
  const refused = looksLikeRefusal(exchange.answer, exchange.fallbackMessage);

  if (refused) reasons.push(REASONS.REFUSAL);
  if (sourceCount === 0 && refused) reasons.push(REASONS.NO_SOURCES);
  if (exchange.feedback === false) reasons.push(REASONS.NEGATIVE_FEEDBACK);
  if (exchange.escalated) reasons.push(REASONS.ESCALATED);

  return { isGap: reasons.length > 0, reasons: [...new Set(reasons)] };
}

/**
 * Records a gap, incrementing the frequency of an existing group when the
 * question is a near-duplicate of one already tracked.
 */
async function record(exchange = {}) {
  try {
    const { isGap, reasons } = evaluate(exchange);
    if (!isGap) return null;

    const question = String(exchange.question)
      .trim()
      .slice(0, MAX_QUESTION_LENGTH);
    const normalized = normalizeQuestion(question);
    // A question made entirely of stop words carries no topic to group on.
    if (!normalized) return null;

    // Two visitors can ask the same unanswerable question at the same moment.
    // A find-then-create would let one of them lose to the unique index and be
    // dropped, under-counting exactly the questions that matter most, so the
    // create path catches the constraint violation and folds into an update.
    const bumpExisting = async (existing) => {
      const merged = [
        ...new Set([...JSON.parse(existing.reasons || "[]"), ...reasons]),
      ];
      return prisma.knowledge_gaps.update({
        where: { normalized },
        data: {
          frequency: { increment: 1 },
          reasons: JSON.stringify(merged),
          lastSeenAt: new Date(),
          // A gap marked resolved but still being asked reopens itself.
          ...(existing.status === "resolved" ? { status: "open" } : {}),
        },
      });
    };

    const existing = await prisma.knowledge_gaps.findUnique({
      where: { normalized },
    });
    if (existing) return await bumpExisting(existing);

    try {
      return await prisma.knowledge_gaps.create({
        data: {
          normalized,
          question,
          frequency: 1,
          reasons: JSON.stringify(reasons),
          agent_profile_id: exchange.agentProfileId ?? null,
          workspace_id: exchange.workspaceId ?? null,
          embed_id: exchange.embedId ?? null,
          status: "open",
          suggested_action: suggestAction(reasons),
        },
      });
    } catch (error) {
      // P2002 == another request created this same gap first.
      if (error?.code !== "P2002") throw error;
      const raced = await prisma.knowledge_gaps.findUnique({
        where: { normalized },
      });
      return raced ? await bumpExisting(raced) : null;
    }
  } catch (error) {
    // Detection must never break a chat response.
    console.error("[KnowledgeGaps] record failed:", error.message);
    return null;
  }
}

function suggestAction(reasons) {
  if (reasons.includes(REASONS.ESCALATED))
    return "Customers are escalating on this topic. Add an authoritative document, then retest.";
  if (reasons.includes(REASONS.NEGATIVE_FEEDBACK))
    return "The existing answer was rated unhelpful. Review and improve the source document.";
  if (reasons.includes(REASONS.NO_SOURCES) || reasons.includes(REASONS.REFUSAL))
    return "No approved document covers this. Upload or write content that answers it.";
  return "Review this topic and confirm the approved knowledge covers it.";
}

/**
 * Called from the chat pipeline. Fire-and-forget: it never blocks or throws
 * into the caller's promise chain.
 */
function observe(exchange) {
  if (!config.billingPolicy) return; // defensive: config must be loaded
  setImmediate(() => {
    record(exchange).catch((error) =>
      console.error("[KnowledgeGaps] observe failed:", error.message)
    );
  });
}

/** Marks negative feedback against the question that produced it. */
async function recordNegativeFeedback({ question, workspaceId = null }) {
  return record({
    question,
    answer: "",
    sources: [],
    feedback: false,
    workspaceId,
  });
}

const KnowledgeGaps = {
  REASONS,
  STATUSES,
  normalizeQuestion,
  looksLikeRefusal,
  evaluate,
  record,
  observe,
  recordNegativeFeedback,
  suggestAction,

  where: async function (clause = {}, limit = 100, offset = 0) {
    try {
      return await prisma.knowledge_gaps.findMany({
        where: clause,
        take: Math.min(Number(limit) || 100, 500),
        skip: Number(offset) || 0,
        orderBy: [{ frequency: "desc" }, { lastSeenAt: "desc" }],
      });
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  count: async function (clause = {}) {
    try {
      return await prisma.knowledge_gaps.count({ where: clause });
    } catch (error) {
      console.error(error.message);
      return 0;
    }
  },

  update: async function ({ id, status = null, note = null, actor = null }) {
    const { AuditLog } = require("../models/audit");
    try {
      const data = { lastSeenAt: undefined };
      if (status !== null) {
        if (!STATUSES.includes(String(status)))
          return { success: false, error: "Unknown status." };
        data.status = String(status);
      }
      if (note !== null) data.note = String(note).slice(0, 4_000);

      const gap = await prisma.knowledge_gaps.update({
        where: { id: Number(id) },
        data,
      });

      await AuditLog.log({
        action: "knowledge_gap.updated",
        category: AuditLog.CATEGORIES.KNOWLEDGE,
        actor,
        resource: "knowledge_gap",
        resourceId: id,
        metadata: { status: gap.status },
      });
      return { success: true, gap };
    } catch (error) {
      console.error("[KnowledgeGaps] update failed:", error.message);
      return { success: false, error: "Unable to update the knowledge gap." };
    }
  },
};

module.exports = { KnowledgeGaps, REASONS };
