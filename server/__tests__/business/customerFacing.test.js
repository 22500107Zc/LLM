const {
  customerFacingMessage,
  FALLBACK,
} = require("../../business/services/customerFacing");

// The real error belongs in the log, not on the customer's screen.
beforeAll(() => jest.spyOn(console, "error").mockImplementation(() => {}));
afterAll(() => console.error.mockRestore());

describe("what a customer is told when the AI fails", () => {
  it("never repeats the provider's own words", () => {
    const leaks = [
      "No OpenAI API key was set.",
      "401 Incorrect API key provided: sk-abc123",
      "Cannot find module '@lancedb/lancedb'",
      "connect ECONNREFUSED 127.0.0.1:11434",
      "PrismaClientKnownRequestError: Invalid `prisma.users.findFirst()`",
    ];

    for (const raw of leaks) {
      const shown = customerFacingMessage(new Error(raw));
      expect(shown).not.toContain(raw);
      expect(shown.toLowerCase()).not.toMatch(
        /api key|module|lancedb|prisma|econnrefused|sk-/
      );
    }
  });

  it("says something the customer can act on", () => {
    expect(customerFacingMessage(new Error("rate limit exceeded"))).toMatch(
      /try that again/i
    );
    expect(customerFacingMessage(new Error("socket hang up"))).toMatch(
      /try again/i
    );
    expect(
      customerFacingMessage(new Error("maximum context length is 8192 tokens"))
    ).toMatch(/shorter/i);
  });

  it("treats a missing or broken provider as our problem, not theirs", () => {
    expect(customerFacingMessage(new Error("No OpenAI API key was set."))).toMatch(
      /not on your side|not available right now/i
    );
  });

  it("falls back rather than guessing, and still stays readable", () => {
    expect(customerFacingMessage(new Error("something nobody predicted"))).toBe(
      FALLBACK
    );
    expect(FALLBACK).toMatch(/contact support/i);
  });

  it("survives a non-Error, because not everything thrown is one", () => {
    expect(typeof customerFacingMessage("a bare string")).toBe("string");
    expect(typeof customerFacingMessage(null)).toBe("string");
    expect(typeof customerFacingMessage(undefined)).toBe("string");
  });

  it("logs the real failure so it is still diagnosable", () => {
    customerFacingMessage(new Error("the actual reason"), "chat");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("chat"),
      "the actual reason"
    );
  });
});
