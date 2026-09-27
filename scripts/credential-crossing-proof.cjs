#!/usr/bin/env node
/**
 * Proof that concurrent customers never use each other's AI credentials.
 *
 * AnythingLLM's provider classes read process.env in their constructors, so
 * business/ai/adapters.js substitutes a customer's values, constructs, and
 * restores them inside ONE synchronous block. That is safe only if nothing
 * can interleave with it. This is the test of that claim under real load.
 *
 * Each customer points at a DIFFERENT OpenAI-compatible endpoint on
 * localhost, and every endpoint records the Authorization header it receives.
 * All customers then chat at once, repeatedly. If endpoint i ever receives a
 * key that is not customer i's, credentials crossed.
 *
 * The product is not mocked: the real serverless entry, a real Postgres,
 * real HTTP, real streaming. Only the model on the far end is a stand-in -
 * and it is the thing doing the recording.
 *
 *   DATABASE_URL=postgresql://... node scripts/credential-crossing-proof.cjs
 */

const crypto = require("crypto");
const http = require("http");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const bcrypt = require(path.join(ROOT, "server", "node_modules", "bcryptjs"));

const CUSTOMERS = Number(process.env.CUSTOMERS || 8);
const ROUNDS = Number(process.env.ROUNDS || 6);
const FOUNDER_PASSWORD = `proof-${crypto.randomBytes(9).toString("base64url")}-A1!`;

if (!String(process.env.DATABASE_URL ?? "").startsWith("postgres")) {
  console.error("DATABASE_URL must point at Postgres.");
  process.exit(2);
}

for (const key of Object.keys(process.env))
  if (
    /^(STRIPE_|OPEN_AI_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|LLM_PROVIDER)/.test(
      key
    )
  )
    delete process.env[key];

Object.assign(process.env, {
  NODE_ENV: "production",
  FOUNDER_CONSOLE_ENABLED: "true",
  FOUNDER_PASSWORD_HASH: bcrypt.hashSync(FOUNDER_PASSWORD, 10),
  JWT_SECRET: crypto.randomBytes(32).toString("hex"),
  SIG_KEY: crypto.randomBytes(32).toString("hex"),
  SIG_SALT: crypto.randomBytes(32).toString("hex"),
  AI_CREDENTIAL_KEY: crypto.randomBytes(32).toString("hex"),
  STORAGE_DIR: path.join(require("os").tmpdir(), `proof-${process.pid}`),
});

/** An OpenAI-compatible endpoint that remembers every key it was sent. */
function endpoint(answer) {
  const seen = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (part) => (body += part));
    request.on("end", () => {
      seen.push(request.headers.authorization ?? null);
      if (!request.url.includes("/chat/completions"))
        return response.writeHead(404).end("{}");

      let stream = false;
      try {
        stream = JSON.parse(body).stream === true;
      } catch {}

      if (!stream) {
        response.writeHead(200, { "Content-Type": "application/json" });
        return response.end(
          JSON.stringify({
            id: "x",
            object: "chat.completion",
            model: "m",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: answer },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        );
      }

      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const frame = (delta, finish = null) =>
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      // Delay a little so requests genuinely overlap in flight.
      setTimeout(
        () => {
          response.write(frame({ role: "assistant", content: answer }));
          response.write(frame({}, "stop"));
          response.end("data: [DONE]\n\n");
        },
        15 + Math.floor(Math.random() * 40)
      );
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        seen,
        url: `http://127.0.0.1:${server.address().port}/v1`,
        close: () => {
          server.closeAllConnections?.();
          return new Promise((r) => server.close(r));
        },
      })
    )
  );
}

let base;
async function call(method, urlPath, { body, token, cookie, csrf } = {}) {
  const r = await fetch(`${base}${urlPath}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { "x-founder-csrf": csrf } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {}
  return {
    status: r.status,
    text,
    payload,
    setCookie: r.headers.get("set-cookie"),
  };
}

async function chat(token, slug) {
  const r = await fetch(`${base}/api/workspace/${slug}/stream-chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ message: "hello", attachments: [] }),
  });
  const body = await r.text();
  const chunks = body
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => {
      try {
        return JSON.parse(l.slice(5));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return {
    text: chunks.map((c) => c.textResponse ?? "").join(""),
    error: chunks.map((c) => c.error).find(Boolean) ?? null,
  };
}

(async () => {
  execFileSync(
    "node",
    [path.join(ROOT, "scripts", "production-bootstrap.cjs")],
    {
      cwd: ROOT,
      env: process.env,
      stdio: "ignore",
    }
  );
  execFileSync(
    "node",
    [
      "-e",
      `const p=require("${path.join(ROOT, "server", "utils", "prisma")}");
    (async()=>{await p.business_ai_connections.deleteMany({});await p.business_customers.deleteMany({});
    await p.users.deleteMany({});process.exit(0)})();`,
    ],
    { cwd: path.join(ROOT, "server"), env: process.env, stdio: "ignore" }
  );

  const handler = require(path.join(ROOT, "api", "index.js"));
  const server = http.createServer((q, s) => handler(q, s));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const login = await call("POST", "/api/founder/login", {
    body: { password: FOUNDER_PASSWORD },
  });
  const cookie = login.setCookie?.split(";")[0];
  const csrf = login.payload?.csrfToken;

  const people = [];
  for (let i = 0; i < CUSTOMERS; i++) {
    const ep = await endpoint(`answer-from-endpoint-${i}`);
    const email = `c${i}@proof.invalid`;
    const password = `Cc1!proof${i}xxxx`;
    await call("POST", "/api/founder/customers", {
      body: { businessName: `Proof Customer ${i}`, email, password },
      cookie,
      csrf,
    });
    const token = (
      await call("POST", "/api/request-token", {
        body: { username: email, password },
      })
    ).payload?.token;
    const key = `sk-customer-${i}-${crypto.randomBytes(10).toString("hex")}`;
    await call("POST", "/api/business/ai-connection", {
      token,
      body: {
        provider: "openai-compatible",
        baseUrl: ep.url,
        model: `model-${i}`,
        apiKey: key,
      },
    });
    const slug = (await call("GET", "/api/workspaces", { token })).payload
      ?.workspaces?.[0]?.slug;
    people.push({ i, token, key, slug, ep });
  }

  console.log(
    `\n${CUSTOMERS} customers, each on their own endpoint. ${ROUNDS} rounds, all at once.\n`
  );

  let turns = 0,
    wrongAnswer = 0,
    errors = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const results = await Promise.all(
      people.flatMap((p) => [
        chat(p.token, p.slug).then((r) => ({ p, r, kind: "chat" })),
        call("POST", "/api/business/ai-connection/test", {
          token: p.token,
          body: {},
        }).then((r) => ({
          p,
          r: {
            text: r.payload?.sample ?? "",
            error: r.payload?.ok ? null : r.payload?.reason,
          },
          kind: "test",
        })),
      ])
    );
    for (const { p, r } of results) {
      turns++;
      if (r.error) {
        errors++;
        continue;
      }
      if (!r.text.includes(`answer-from-endpoint-${p.i}`)) wrongAnswer++;
    }
  }

  let crossed = 0,
    delivered = 0;
  for (const p of people) {
    for (const auth of p.ep.seen) {
      delivered++;
      if (auth !== `Bearer ${p.key}`) {
        crossed++;
        const owner = people.find((o) => auth === `Bearer ${o.key}`);
        console.log(
          `  !! endpoint ${p.i} received ${owner ? `customer ${owner.i}'s key` : "an unknown key"}`
        );
      }
    }
  }

  const envLeak = Object.values(process.env).some((v) =>
    /sk-customer-/.test(String(v))
  );

  console.log(`  concurrent AI turns attempted:            ${turns}`);
  console.log(`  requests that reached a provider:         ${delivered}`);
  console.log(`  delivered with ANOTHER customer's key:    ${crossed}`);
  console.log(`  answers from the wrong customer's model:  ${wrongAnswer}`);
  console.log(`  turns that errored:                       ${errors}`);
  console.log(
    `  customer key left in process.env:         ${envLeak ? "YES" : "no"}`
  );

  for (const p of people) {
    await call(
      "DELETE",
      `/api/founder/customers/${p.i >= 0 ? (await call("GET", "/api/founder/customers", { cookie, csrf })).payload.customers.find((c) => c.businessName === `Proof Customer ${p.i}`)?.id : 0}`,
      { body: { confirmBusinessName: `Proof Customer ${p.i}` }, cookie, csrf }
    );
    await p.ep.close();
  }
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));

  const ok =
    crossed === 0 &&
    wrongAnswer === 0 &&
    errors === 0 &&
    !envLeak &&
    delivered >= turns;
  console.log(
    `\n${"=".repeat(60)}\nCREDENTIAL CROSSING: ${ok ? "NONE - PROVEN" : "FAILED"}\n${"=".repeat(60)}`
  );
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("proof crashed:", e);
  process.exit(1);
});
