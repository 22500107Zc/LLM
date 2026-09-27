const { reqBody } = require("../../../utils/http");

/**
 * On Vercel the request body can reach a handler as the raw string, and this
 * helper is where it is first parsed. A malformed body used to throw a bare
 * SyntaxError, which the error handler reported as a 500 with a stack trace -
 * found by a production stress test. It is the client's error, so it is 400.
 */
describe("reqBody", () => {
  it("passes an already-parsed body straight through", () => {
    const body = { username: "a@b.test" };
    expect(reqBody({ body })).toBe(body);
  });

  it("parses a JSON string, as some runtimes deliver it", () => {
    expect(reqBody({ body: '{"username":"a@b.test"}' })).toEqual({
      username: "a@b.test",
    });
  });

  it("marks an unparseable body as the client's error, 400", () => {
    let thrown;
    try {
      reqBody({ body: "<<<not json>>>" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect(thrown.status).toBe(400);
    expect(thrown.message).toMatch(/not valid JSON/i);
  });

  it("does not repeat the client's raw input in the message", () => {
    try {
      reqBody({ body: "secret-looking-garbage{" });
    } catch (error) {
      expect(error.message).not.toContain("secret-looking-garbage");
    }
  });
});
