/** Business feature logic: knowledge gaps, AI quality grading and lead rules. */

describe("knowledge gap detection", () => {
  const { KnowledgeGaps } = require("../../business/services/knowledgeGaps");
  const n = (q) => KnowledgeGaps.normalizeQuestion(q);

  it.each([
    ["What is your refund policy?", "What are your refund policies?"],
    ["How do I reset my password", "password resets, how?"],
    ["Where are your offices", "where is your office"],
    ["Do you offer a discount?", "discounts offered?"],
  ])("groups %p with %p", (a, b) => {
    expect(n(a)).toBe(n(b));
    expect(n(a)).not.toBe("");
  });

  it.each([
    ["refund policy", "shipping policy"],
    ["how do I reset my password", "how do I change my email"],
  ])("keeps %p separate from %p", (a, b) => {
    expect(n(a)).not.toBe(n(b));
  });

  it("produces no key for a question made only of stop words", () => {
    expect(n("what is it")).toBe("");
  });

  it.each([
    "I couldn't find that information in the approved company knowledge.",
    "I don't have information about that.",
    "I cannot find anything on that topic.",
    "No relevant information was found.",
    "There is no mention of that in the documents.",
    "I'm unable to answer that question.",
    "That is not covered in the approved knowledge.",
    "",
  ])("treats %p as a refusal", (answer) => {
    expect(KnowledgeGaps.looksLikeRefusal(answer)).toBe(true);
  });

  it.each([
    "Our refund window is 30 days from the purchase date.",
    "You can reset your password from the account settings page.",
    "We have offices in London and New York.",
  ])("treats %p as a real answer", (answer) => {
    expect(KnowledgeGaps.looksLikeRefusal(answer)).toBe(false);
  });

  it("matches a configured fallback message even when it is custom", () => {
    expect(
      KnowledgeGaps.looksLikeRefusal(
        "Sorry — please contact our team for help with that.",
        "Sorry — please contact our team for help with that."
      )
    ).toBe(true);
  });

  it("flags an answer with no sources and a refusal", () => {
    const result = KnowledgeGaps.evaluate({
      question: "what is the refund policy",
      answer: "I could not find that information.",
      sources: [],
    });
    expect(result.isGap).toBe(true);
    expect(result.reasons).toContain("refusal");
    expect(result.reasons).toContain("no_sources");
  });

  it("does not flag a good, sourced answer", () => {
    expect(
      KnowledgeGaps.evaluate({
        question: "what is the refund policy",
        answer: "Refunds are available for 30 days.",
        sources: [{ title: "Refund Policy.pdf" }],
      }).isGap
    ).toBe(false);
  });

  it("flags an answer the user rated negatively even when it looked fine", () => {
    const result = KnowledgeGaps.evaluate({
      question: "what is the refund policy",
      answer: "Refunds are available for 30 days.",
      sources: [{ title: "x.pdf" }],
      feedback: false,
    });
    expect(result.isGap).toBe(true);
    expect(result.reasons).toContain("negative_feedback");
  });

  it("flags an escalated conversation", () => {
    expect(
      KnowledgeGaps.evaluate({
        question: "do you integrate with our ERP",
        answer: "Yes we do.",
        sources: [{ title: "x" }],
        escalated: true,
      }).reasons
    ).toContain("escalated");
  });

  it("ignores greetings and other non-questions", () => {
    for (const greeting of ["hi", "hello", "yo", "ok"])
      expect(KnowledgeGaps.evaluate({ question: greeting, answer: "" }).isGap).toBe(
        false
      );
  });
});

describe("AI quality grading", () => {
  const { AIQuality, VERDICTS } = require("../../business/services/aiQuality");

  it("passes when every expected concept is present", () => {
    const result = AIQuality.grade({
      answer: "Refunds are available for 30 days after purchase with a receipt.",
      concepts: ["30 days", "refund", "receipt"],
    });
    expect(result.verdict).toBe(VERDICTS.PASSED);
    expect(result.score).toBe(1);
  });

  it("fails when most concepts are missing", () => {
    const result = AIQuality.grade({
      answer: "Refunds are available.",
      concepts: ["30 days", "refund", "receipt required"],
    });
    expect(result.verdict).toBe(VERDICTS.FAILED);
  });

  it("needs review when concepts are present but a required source was not cited", () => {
    const result = AIQuality.grade({
      answer: "Refunds take 30 days.",
      concepts: ["30 days", "refund"],
      requiredSource: "Refund Policy.pdf",
      sources: [{ title: "Shipping.pdf" }],
    });
    expect(result.verdict).toBe(VERDICTS.NEEDS_REVIEW);
  });

  it("passes when the required source is cited", () => {
    const result = AIQuality.grade({
      answer: "Refunds take 30 days.",
      concepts: ["30 days", "refund"],
      requiredSource: "Refund Policy",
      sources: [{ title: "Refund Policy.pdf" }],
    });
    expect(result.verdict).toBe(VERDICTS.PASSED);
  });

  it("fails a refusal regardless of expectations", () => {
    expect(
      AIQuality.grade({
        answer: "I couldn't find that information in the approved company knowledge.",
        concepts: [],
      }).verdict
    ).toBe(VERDICTS.FAILED);
  });

  it("fails an empty or errored answer", () => {
    expect(AIQuality.grade({ answer: "", concepts: ["x"] }).verdict).toBe(
      VERDICTS.FAILED
    );
    expect(AIQuality.grade({ answer: "anything", errored: true }).verdict).toBe(
      VERDICTS.FAILED
    );
  });

  it("matches concepts word-wise rather than as exact phrases", () => {
    expect(
      AIQuality.conceptPresent("refunds are issued within 30 days", "30 day refund")
    ).toBe(true);
    expect(AIQuality.conceptPresent("we ship worldwide", "30 day refund")).toBe(false);
  });

  it("parses concepts from an array, JSON or a delimited string", () => {
    expect(AIQuality.parseConcepts(["a", "b"])).toEqual(["a", "b"]);
    expect(AIQuality.parseConcepts('["a","b"]')).toEqual(["a", "b"]);
    expect(AIQuality.parseConcepts("a, b; c")).toEqual(["a", "b", "c"]);
    expect(AIQuality.parseConcepts(null)).toEqual([]);
  });
});

describe("lead validation", () => {
  const { Lead } = require("../../business/models/lead");

  it.each(["a@b.co", "first.last+tag@sub.example.com"])(
    "accepts the email %s",
    (email) => expect(Lead._validEmail(email)).toBe(true)
  );

  it.each(["", "notanemail", "a@b", "a b@c.com", "@b.co"])(
    "rejects the email %p",
    (email) => expect(Lead._validEmail(email)).toBe(false)
  );

  it("exposes the six commercial lead statuses", () => {
    expect(Lead.STATUSES).toEqual([
      "new",
      "qualified",
      "contacted",
      "opportunity",
      "closed",
      "disqualified",
    ]);
  });
});

describe("agent templates", () => {
  const { AgentProfile } = require("../../business/models/agentProfile");

  it("provides the five business starter templates", () => {
    const keys = AgentProfile.templateCatalogue().map((t) => t.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "customer_support",
        "sales_qualification",
        "internal_knowledge",
        "employee_assistant",
        "website_concierge",
      ])
    );
  });

  it("defaults customer-facing templates to source-grounded query mode", () => {
    for (const key of ["customer_support", "sales_qualification", "website_concierge"])
      expect(AgentProfile.TEMPLATES[key].chatMode).toBe("query");
  });

  it("instructs every template not to invent answers", () => {
    for (const template of Object.values(AgentProfile.TEMPLATES))
      expect(template.systemPrompt.toLowerCase()).toMatch(
        /never (invent|state|quote)|do not speculate|say so/
      );
  });

  it("substitutes the company name into a template prompt", () => {
    const rendered = AgentProfile.renderPrompt("Support for {{COMPANY}} only.");
    expect(rendered).not.toContain("{{COMPANY}}");
  });

  it("uses an approved-knowledge fallback by default", () => {
    expect(AgentProfile.DEFAULT_FALLBACK).toMatch(/approved company knowledge/i);
  });
});

describe("integration catalogue", () => {
  const { Integration } = require("../../business/models/integration");

  it("ships the five priority providers", () => {
    const providers = Integration.catalogue().map((c) => c.provider);
    expect(providers).toEqual(
      expect.arrayContaining(["webhook", "email", "slack", "hubspot", "salesforce"])
    );
  });

  it("marks the generic webhook as implemented", () => {
    const webhook = Integration.catalogue().find((c) => c.provider === "webhook");
    expect(webhook.implemented).toBe(true);
  });

  it("rejects an unknown provider", () => {
    expect(Integration.isValidProvider("myspace")).toBe(false);
  });

  it("never returns a secret value in the public shape", () => {
    const publicShape = Integration.toPublic({
      uuid: "u",
      name: "n",
      provider: "webhook",
      enabled: true,
      config: '{"url":"https://example.com"}',
      secret_ciphered: null,
      events: '["lead.created"]',
    });
    expect(publicShape).not.toHaveProperty("secret_ciphered");
    expect(JSON.stringify(publicShape)).not.toMatch(/signingSecret.*:.*"/);
    expect(Array.isArray(publicShape.configuredSecrets)).toBe(true);
  });
});

describe("conversation summarization", () => {
  const { Conversations } = require("../../business/services/conversations");

  it("summarizes without calling a model", () => {
    const summary = Conversations.summarize([
      { prompt: "Do you ship to Canada?", answer: "Yes, we ship to Canada." },
    ]);
    expect(summary).toContain("Do you ship to Canada?");
  });

  it("handles an empty conversation", () => {
    expect(Conversations.summarize([])).toMatch(/no visitor message/i);
  });
});
