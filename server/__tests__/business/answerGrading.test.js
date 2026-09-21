/**
 * AI quality grading.
 *
 * The suite this replaces graded by asking "do all the concept's words appear
 * somewhere in the answer?", which passed negated answers and wrong numbers.
 * The first describe block pins the exact reported regressions; the rest cover
 * the surrounding behaviour.
 */

const { AIQuality, VERDICTS } = require("../../business/services/aiQuality");
const grading = require("../../business/services/answerGrading");

const g = (answer, concepts, extra = {}) =>
  AIQuality.grade({ answer, concepts, ...extra });

describe("reported grading defects", () => {
  const concept = ["30 day refund"];

  it("passes a correctly worded answer", () => {
    expect(g("Refunds are available within 30 days.", concept).verdict).toBe(
      VERDICTS.PASSED
    );
  });

  it("FAILS a negated answer that contains every concept word", () => {
    const result = g("Refunds are NOT available within 30 days.", concept);
    expect(result.verdict).toBe(VERDICTS.FAILED);
    expect(result.detail).toMatch(/denies/i);
  });

  it("FAILS a numerically wrong answer (300 must not match 30)", () => {
    const result = g("Refunds are available within 300 days.", concept);
    expect(result.verdict).toBe(VERDICTS.FAILED);
    expect(result.detail).toMatch(/300/);
    expect(result.detail).toMatch(/30/);
  });
});

describe("number handling", () => {
  it.each([
    ["30", "300", false],
    ["300", "30", false],
    ["5", "50", false],
    ["1000", "10000", false],
    ["30", "30", true],
  ])("concept %s vs answer %s -> match=%s", (want, got, shouldMatch) => {
    const result = g(`The limit is ${got} units.`, [`${want} units`]);
    expect(result.verdict === VERDICTS.PASSED).toBe(shouldMatch);
  });

  it.each([
    ["thirty", 30],
    ["twenty five", 25],
    ["one hundred", 100],
    ["ninety", 90],
  ])("normalizes the written number %s to %i", (words, value) => {
    expect(grading.wordsToNumber(words.split(" "))).toBe(value);
  });

  it("treats a written number as equal to its digits", () => {
    expect(g("Refunds take thirty days.", ["30 day refund"]).verdict).toBe(
      VERDICTS.PASSED
    );
  });

  it("strips thousands separators and currency symbols", () => {
    expect(g("The fee is $5,000 per month.", ["$5000 per month"]).verdict).toBe(
      VERDICTS.PASSED
    );
  });

  it("rejects a different currency amount", () => {
    const result = g("The fee is $500 per month.", ["$5000 per month"]);
    expect(result.verdict).toBe(VERDICTS.FAILED);
    expect(result.detail).toMatch(/500/);
  });

  it("matches a hyphenated figure", () => {
    expect(g("We offer a 30-day refund window.", ["30 day refund"]).verdict).toBe(
      VERDICTS.PASSED
    );
  });
});

describe("negation and polarity", () => {
  it.each([
    "Refunds are not available within 30 days.",
    "There is no 30 day refund.",
    "We never offer a 30 day refund.",
    "A 30 day refund is unavailable.",
    "Customers cannot get a 30 day refund.",
  ])("fails the negated answer %p", (answer) => {
    expect(g(answer, ["30 day refund"]).verdict).toBe(VERDICTS.FAILED);
  });

  it("passes when the concept itself is negative and the answer agrees", () => {
    expect(
      g("Refunds are not available after 30 days.", ["not available 30 day refund"])
        .verdict
    ).toBe(VERDICTS.PASSED);
  });

  it("fails when a negative concept is answered positively", () => {
    const result = g("Refunds are available after 30 days.", [
      "not available 30 day refund",
    ]);
    expect(result.verdict).toBe(VERDICTS.FAILED);
  });

  it("does not treat 'not only ... but also' as a denial", () => {
    expect(grading.clauseIsNegated("not only fast but also free")).toBe(false);
  });
});

describe("clause scoping", () => {
  it("rejects concept words scattered across unrelated sentences", () => {
    const answer =
      "We offer refunds. Our showroom is open 30 days a year. Day passes are sold separately.";
    expect(g(answer, ["30 day refund"]).verdict).toBe(VERDICTS.FAILED);
  });

  it("rejects a match split across a contrastive conjunction", () => {
    expect(
      g("Refunds are available, but not within 30 days.", ["30 day refund"]).verdict
    ).toBe(VERDICTS.FAILED);
  });

  it("accepts a match contained in a single clause of a longer answer", () => {
    const answer =
      "Shipping is free. Refunds are available within 30 days. Contact support for help.";
    expect(g(answer, ["30 day refund"]).verdict).toBe(VERDICTS.PASSED);
  });

  it("splits on sentence terminators and semicolons", () => {
    expect(grading.splitClauses("One. Two; three")).toEqual([
      "One.",
      "Two",
      "three",
    ]);
  });
});

describe("refusals and empty answers", () => {
  it.each([
    "I couldn't find that information in the approved company knowledge.",
    "I don't have information about that.",
    "No relevant information was found.",
  ])("fails the refusal %p", (answer) => {
    const result = g(answer, ["30 day refund"]);
    expect(result.verdict).toBe(VERDICTS.FAILED);
    expect(result.detail).toMatch(/could not answer/i);
  });

  it("fails an empty answer", () => {
    const result = g("", ["anything"]);
    expect(result.verdict).toBe(VERDICTS.FAILED);
    expect(result.detail).toMatch(/empty/i);
  });

  it("fails an errored run", () => {
    expect(
      AIQuality.grade({ answer: "text", concepts: [], errored: true }).verdict
    ).toBe(VERDICTS.FAILED);
  });
});

describe("multiple expected concepts", () => {
  const concepts = ["30 day refund", "receipt", "original payment method"];

  it("passes when every concept is satisfied", () => {
    const answer =
      "Refunds are issued within 30 days, a receipt is required, and funds return to the original payment method.";
    const result = g(answer, concepts);
    expect(result.verdict).toBe(VERDICTS.PASSED);
    expect(result.score).toBe(1);
  });

  it("needs review when most but not all are present", () => {
    const answer =
      "Refunds are issued within 30 days and a receipt is required.";
    const result = g(answer, concepts);
    expect(result.verdict).toBe(VERDICTS.NEEDS_REVIEW);
    expect(result.detail).toMatch(/original payment method/);
  });

  it("fails when most are missing", () => {
    const result = g("Refunds are issued within 30 days.", concepts);
    expect(result.verdict).toBe(VERDICTS.FAILED);
  });

  it("fails outright when one concept is contradicted, even if others match", () => {
    const answer =
      "A receipt is required. Refunds are not available within 30 days.";
    const result = g(answer, concepts);
    expect(result.verdict).toBe(VERDICTS.FAILED);
    expect(result.detail).toMatch(/denies/i);
  });

  it("reports a per-concept finding for each expectation", () => {
    const result = g("Refunds are issued within 30 days.", concepts);
    expect(result.findings).toHaveLength(3);
    expect(result.findings.map((f) => f.status)).toEqual(
      expect.arrayContaining(["matched", "missing"])
    );
  });
});

describe("required source citation", () => {
  it("needs review when the facts are right but the source is not cited", () => {
    const result = g("Refunds take 30 days.", ["30 day refund"], {
      requiredSource: "Refund Policy.pdf",
      sources: [{ title: "Shipping.pdf" }],
    });
    expect(result.verdict).toBe(VERDICTS.NEEDS_REVIEW);
    expect(result.detail).toMatch(/Refund Policy\.pdf/);
  });

  it("passes when the required source is cited", () => {
    expect(
      g("Refunds take 30 days.", ["30 day refund"], {
        requiredSource: "Refund Policy",
        sources: [{ title: "Refund Policy.pdf" }],
      }).verdict
    ).toBe(VERDICTS.PASSED);
  });

  it("still fails a wrong fact even when the source is cited", () => {
    expect(
      g("Refunds take 300 days.", ["30 day refund"], {
        requiredSource: "Refund Policy",
        sources: [{ title: "Refund Policy.pdf" }],
      }).verdict
    ).toBe(VERDICTS.FAILED);
  });
});

describe("expected_answer is used when no concepts are given", () => {
  it("derives checkable facts from the expected answer", () => {
    const result = AIQuality.grade({
      answer: "Refunds are issued within 30 days of purchase.",
      concepts: [],
      expectedAnswer: "Refunds are issued within 30 days of purchase.",
    });
    expect(result.verdict).toBe(VERDICTS.PASSED);
    expect(result.detail).toMatch(/derived from the expected answer/i);
  });

  it("fails an answer that contradicts the expected answer's figure", () => {
    const result = AIQuality.grade({
      answer: "Refunds are issued within 90 days of purchase.",
      concepts: [],
      expectedAnswer: "Refunds are issued within 30 days of purchase.",
    });
    expect(result.verdict).toBe(VERDICTS.FAILED);
    expect(result.detail).toMatch(/90/);
  });

  it("fails an answer that negates the expected answer", () => {
    const result = AIQuality.grade({
      answer: "Refunds are not issued within 30 days of purchase.",
      concepts: [],
      expectedAnswer: "Refunds are issued within 30 days of purchase.",
    });
    expect(result.verdict).toBe(VERDICTS.FAILED);
  });

  it("prefers explicit concepts over the expected answer when both exist", () => {
    const result = AIQuality.grade({
      answer: "A receipt is required.",
      concepts: ["receipt"],
      expectedAnswer: "Refunds are issued within 30 days.",
    });
    expect(result.verdict).toBe(VERDICTS.PASSED);
  });
});

describe("grading makes no model call", () => {
  it("is a pure function of its inputs", () => {
    // A billable call would need network or a provider client; grading must
    // not reach for either.
    const before = process.env.OPEN_AI_KEY;
    delete process.env.OPEN_AI_KEY;
    expect(() => g("Refunds take 30 days.", ["30 day refund"])).not.toThrow();
    if (before !== undefined) process.env.OPEN_AI_KEY = before;
  });
});
