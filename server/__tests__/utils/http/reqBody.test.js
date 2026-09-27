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

describe("rejectUnreadableBody", () => {
  const { rejectUnreadableBody } = require("../../../utils/http");

  function run(body) {
    const request = { body };
    const response = {
      statusCode: null,
      payload: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.payload = payload;
        return this;
      },
    };
    let nexted = false;
    rejectUnreadableBody(request, response, () => (nexted = true));
    return { request, response, nexted };
  }

  it("answers a text body that is not JSON with 400, before any route runs", () => {
    const { response, nexted } = run("<<<not json>>>");
    expect(nexted).toBe(false);
    expect(response.statusCode).toBe(400);
    expect(response.payload.error).toBe("bad_request");
    expect(JSON.stringify(response.payload)).not.toContain("not json");
  });

  it("lets a JSON text body through untouched, and reqBody reuses the parse", () => {
    const { request, nexted } = run('{"username":"a@b.test"}');
    expect(nexted).toBe(true);
    expect(request.body).toBe('{"username":"a@b.test"}');
    expect(reqBody(request)).toEqual({ username: "a@b.test" });
  });

  it("lets parsed, empty and absent bodies through", () => {
    expect(run({ a: 1 }).nexted).toBe(true);
    expect(run("").nexted).toBe(true);
    expect(run(undefined).nexted).toBe(true);
  });
});
