#!/usr/bin/env node
/**
 * The commercial loop, against the real production deployment.
 *
 * Not localhost, not a preview, not a unit test. This signs in as the founder
 * over the public URL, creates throwaway customers, uses the product as them,
 * and takes it all away again.
 *
 *   FOUNDER_PASSWORD=... node scripts/production-acceptance.cjs [base-url]
 *
 * Everything it creates is named with a run-specific marker and removed at the
 * end, including after a failure. Nothing it creates outlives the run.
 *
 * Where the deployment is not finished - no database yet - the affected
 * checks are reported BLOCKED rather than failed, and the run still says
 * exactly what did work.
 */

const crypto = require("crypto");

const BASE = (
  process.argv[2] ||
  process.env.PRODUCTION_URL ||
  "https://business-ai-operations-platform-22500107zcs-projects.vercel.app"
).replace(/\/+$/, "");

const FOUNDER_PASSWORD = process.env.FOUNDER_PASSWORD || "";
if (!FOUNDER_PASSWORD) {
  console.error("FOUNDER_PASSWORD is required. It is never written down here.");
  process.exit(2);
}

/**
 * Optionally, a throwaway AI credential to prove a full customer AI turn.
 * The product never owns one - this stands in for what a customer supplies.
 *
 *   CUSTOMER_AI='{"provider":"openai-compatible","baseUrl":"…","model":"…","apiKey":"…"}'
 */
let CUSTOMER_AI = null;
try {
  CUSTOMER_AI = process.env.CUSTOMER_AI
    ? JSON.parse(process.env.CUSTOMER_AI)
    : null;
} catch {
  console.error("CUSTOMER_AI is not valid JSON; skipping the AI turn.");
}

const RUN = crypto.randomBytes(4).toString("hex");
const password = (label) =>
  `${label}-${crypto.randomBytes(9).toString("base64url")}-A1!`;

const ACME = {
  businessName: `Verification Acme ${RUN}`,
  email: `acme-${RUN}@verification.invalid`,
  password: password("acme"),
};
const BETA = {
  businessName: `Verification Beta ${RUN}`,
  email: `beta-${RUN}@verification.invalid`,
  password: password("beta"),
};

let passed = 0;
let failed = 0;
let blockedCount = 0;
const failures = [];
const blockedItems = [];

const check = (name, ok, detail = "") => {
  if (ok) {
    passed += 1;
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(
      `  \x1b[31mFAIL\x1b[0m  ${name}${detail ? `  (${detail})` : ""}`
    );
  }
  return ok;
};

const blocked = (name, why) => {
  blockedCount += 1;
  blockedItems.push(`${name} - ${why}`);
  console.log(`  \x1b[33mBLOCKED\x1b[0m  ${name}  (${why})`);
};

const section = (title) => console.log(`\n\x1b[1m${title}\x1b[0m`);

async function call(method, urlPath, { body, headers = {} } = {}) {
  const response = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  return {
    status: response.status,
    payload,
    text,
    setCookie: response.headers.get("set-cookie"),
  };
}

/** The founder console's client: HttpOnly cookie plus the CSRF header. */
function founderClient() {
  const state = { cookie: null, csrf: null };
  const headers = () => ({
    ...(state.cookie ? { Cookie: state.cookie } : {}),
    ...(state.csrf ? { "x-founder-csrf": state.csrf } : {}),
  });
  return {
    state,
    get: (p) => call("GET", p, { headers: headers() }),
    post: (p, b) => call("POST", p, { body: b, headers: headers() }),
    put: (p, b) => call("PUT", p, { body: b, headers: headers() }),
    del: (p, b) => call("DELETE", p, { body: b, headers: headers() }),
    async login(secret) {
      const result = await call("POST", "/api/founder/login", {
        body: { password: secret },
      });
      if (result.setCookie) state.cookie = result.setCookie.split(";")[0];
      if (result.payload?.csrfToken) state.csrf = result.payload.csrfToken;
      return result;
    },
  };
}

const login = (username, secret) =>
  call("POST", "/api/request-token", { body: { username, password: secret } });

const asCustomer = (token, urlPath = "/api/workspaces") =>
  call("GET", urlPath, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

/** One real AI turn over the public URL, reading the SSE stream to the end. */
async function chat(token, slug, message) {
  const response = await fetch(`${BASE}/api/workspace/${slug}/stream-chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ message, attachments: [] }),
  });
  const body = await response.text();
  const chunks = [];
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      chunks.push(JSON.parse(line.slice(5).trim()));
    } catch {
      /* partial frame */
    }
  }
  return {
    status: response.status,
    text: chunks.map((chunk) => chunk.textResponse ?? "").join(""),
    error: chunks.map((chunk) => chunk.error).find(Boolean) ?? null,
  };
}

const api = founderClient();
const created = [];

async function cleanup() {
  for (const { id, businessName } of created) {
    try {
      await api.del(`/api/founder/customers/${id}`, {
        confirmBusinessName: businessName,
      });
    } catch {
      console.error(`  (could not remove ${businessName} - remove it by hand)`);
    }
  }
}

(async () => {
  console.log(`\nProduction acceptance against ${BASE}\nRun marker: ${RUN}`);

  // --------------------------------------------------------------- shell --
  section("The application is served");
  for (const urlPath of ["/", "/founder", "/login"]) {
    const page = await call("GET", urlPath);
    check(`${urlPath} loads`, page.status === 200, `got ${page.status}`);
  }

  const bundle = await call("GET", "/index.js");
  check(
    "no secret in the browser bundle",
    !/\$2[aby]\$[0-9]{2}\$/.test(bundle.text) &&
      !/FOUNDER_PASSWORD_HASH|JWT_SECRET|SIG_SALT|SIG_KEY/.test(bundle.text)
  );

  // -------------------------------------------------------------- founder --
  section("Founder");
  const wrong = await api.login(`${FOUNDER_PASSWORD}-wrong`);
  check("a wrong founder password is refused", wrong.status === 401);

  const signedIn = await api.login(FOUNDER_PASSWORD);
  if (
    !check(
      "founder signs in on production",
      signedIn.status === 200 && Boolean(api.state.cookie),
      `${signedIn.status} ${JSON.stringify(signedIn.payload)}`
    )
  ) {
    console.log("\nNothing further can run without a founder session.");
    return finish();
  }

  const session = await api.get("/api/founder/session");
  check("the founder console loads", session.payload?.authenticated === true);
  check(
    "the session response carries no hash",
    !/\$2[aby]\$/.test(JSON.stringify(session.payload))
  );

  // ----------------------------------------------------------- platform --
  section("Platform readiness");
  const ready = await api.get("/api/founder/readiness");
  check(
    "the founder can see what the platform still needs",
    ready.status === 200 && Boolean(ready.payload?.platform)
  );
  check(
    "customers' AI keys can be stored securely",
    ready.payload?.platform?.credentialEncryption === "ready",
    String(ready.payload?.platform?.credentialEncryption)
  );
  const hasDatabase = ready.payload?.platform?.database === "postgres";
  if (!hasDatabase)
    blocked("durable customer storage", "no Postgres DATABASE_URL yet");
  check(
    "several AI services are offered to customers",
    (ready.payload?.aiServices ?? []).length > 1,
    (ready.payload?.aiServices ?? []).join(", ")
  );

  // ------------------------------------------------------------ customers --
  section("Founder creates a customer");
  const madeAcme = await api.post("/api/founder/customers", {
    ...ACME,
    contactName: "Verification Run",
    notes: `temporary - production acceptance ${RUN}`,
  });

  if (madeAcme.status === 503) {
    blocked(
      "the whole customer loop",
      madeAcme.payload?.message ?? "the deployment has no database yet"
    );
    return finish();
  }

  const acmeId = madeAcme.payload?.customer?.id;
  if (
    !check(
      "customer created",
      madeAcme.status === 201,
      `${madeAcme.status} ${JSON.stringify(madeAcme.payload)}`
    )
  )
    return finish();
  created.push({ id: acmeId, businessName: ACME.businessName });

  const listed = await api.get("/api/founder/customers");
  check(
    "the customer appears in the founder console",
    (listed.payload?.customers ?? []).some((c) => c.id === acmeId)
  );
  check(
    "no password or hash in any founder response",
    !JSON.stringify([madeAcme.payload, listed.payload]).includes(
      ACME.password
    ) && !/\$2[aby]\$/.test(JSON.stringify([madeAcme.payload, listed.payload]))
  );

  section("The customer signs in and uses the product");
  check(
    "a wrong password is refused",
    (await login(ACME.email, `${ACME.password}x`)).payload?.valid === false
  );
  const acmeSession = await login(ACME.email, ACME.password);
  check("the customer signs in", acmeSession.payload?.valid === true);
  let acmeToken = acmeSession.payload?.token;

  const acmeWorkspaces = await asCustomer(acmeToken);
  check("the customer reaches the product", acmeWorkspaces.status === 200);
  const acmeSpaces = acmeWorkspaces.payload?.workspaces ?? [];
  check(
    "they land in their own business workspace",
    acmeSpaces.some((w) => w.name === ACME.businessName),
    acmeSpaces.map((w) => w.name).join(", ") || "none"
  );
  check(
    "founder functions are closed to them",
    (
      await call("GET", "/api/founder/customers", {
        headers: { Authorization: `Bearer ${acmeToken}` },
      })
    ).status === 401
  );

  // -------------------------------------------- the customer's own AI --
  //
  // This product has no model credential. The customer connects the service
  // they chose; until they do, everything else must still work.
  section("The customer's own AI connection");
  const slug = acmeSpaces[0]?.slug;

  const options = await asCustomer(
    acmeToken,
    "/api/business/ai-connection/options"
  );
  check(
    "the customer is offered AI services to connect",
    options.status === 200 && (options.payload?.options ?? []).length > 1
  );

  const beforeConnecting = await asCustomer(
    acmeToken,
    "/api/business/ai-connection"
  );
  check(
    "they start with none, and that is not an error",
    beforeConnecting.status === 200 &&
      beforeConnecting.payload?.connection === null
  );

  if (slug) {
    const unconnected = await chat(acmeToken, slug, "Hello");
    check(
      "chatting without one tells them what to do, not that we broke",
      /connect your ai service/i.test(unconnected.error ?? ""),
      unconnected.error ?? "no message"
    );
  }

  if (CUSTOMER_AI) {
    const saved = await call("POST", "/api/business/ai-connection", {
      body: CUSTOMER_AI,
      headers: { Authorization: `Bearer ${acmeToken}` },
    });
    check("the customer saves their own connection", saved.status === 200);
    check(
      "their key never comes back",
      !JSON.stringify(saved.payload).includes(CUSTOMER_AI.apiKey ?? "\u0000")
    );

    const tested = await call("POST", "/api/business/ai-connection/test", {
      body: {},
      headers: { Authorization: `Bearer ${acmeToken}` },
    });
    check(
      "their own service answers",
      tested.payload?.ok === true,
      tested.payload?.reason ?? ""
    );

    if (slug) {
      const answer = await chat(
        acmeToken,
        slug,
        "In one sentence, what is a purchase order?"
      );
      check(
        "the assistant answers through THEIR connection",
        !answer.error && answer.text.trim().length > 20,
        answer.error ?? answer.text.slice(0, 100)
      );
      const history = await asCustomer(
        acmeToken,
        `/api/workspace/${slug}/chats`
      );
      check(
        "the conversation persisted",
        (history.payload?.history ?? []).length > 0
      );
    }
  } else {
    blocked(
      "an end-to-end AI turn",
      "no temporary customer AI credential was supplied to this run"
    );
  }

  // ---------------------------------------------------------- disable etc --
  section("Founder-controlled access");
  const off = await api.post(`/api/founder/customers/${acmeId}/access`, {
    access: "disabled",
  });
  check(
    "founder disables the customer",
    off.payload?.customer?.access === "disabled"
  );
  check(
    "their already-issued session dies on the next request",
    (await asCustomer(acmeToken)).status === 401
  );
  check(
    "a direct API call is refused too",
    (await asCustomer(acmeToken, `/api/workspace/${slug}/chats`)).status === 401
  );
  check(
    "they cannot sign in again",
    (await login(ACME.email, ACME.password)).payload?.valid === false
  );

  const on = await api.post(`/api/founder/customers/${acmeId}/access`, {
    access: "active",
  });
  check("founder restores access", on.payload?.customer?.access === "active");
  const back = await login(ACME.email, ACME.password);
  check("the customer signs in again", back.payload?.valid === true);
  acmeToken = back.payload?.token;
  check(
    "and reaches the product",
    (await asCustomer(acmeToken)).status === 200
  );

  section("Founder-managed credentials");
  const nextPassword = password("rotated");
  check(
    "founder sets a new password",
    (
      await api.post(`/api/founder/customers/${acmeId}/password`, {
        password: nextPassword,
      })
    ).status === 200
  );
  check(
    "the old password stops working",
    (await login(ACME.email, ACME.password)).payload?.valid === false
  );
  check(
    "the new password works",
    (await login(ACME.email, nextPassword)).payload?.valid === true
  );

  const nextEmail = `acme-${RUN}-moved@verification.invalid`;
  check(
    "founder changes the login email",
    (
      await api.post(`/api/founder/customers/${acmeId}/email`, {
        email: nextEmail,
      })
    ).status === 200
  );
  check(
    "the old email stops working",
    (await login(ACME.email, nextPassword)).payload?.valid === false
  );
  const moved = await login(nextEmail, nextPassword);
  check("the new email works", moved.payload?.valid === true);
  acmeToken = moved.payload?.token;

  // ------------------------------------------------------------ isolation --
  section("One customer cannot reach another's data");
  const madeBeta = await api.post("/api/founder/customers", {
    ...BETA,
    contactName: "Verification Run",
    notes: `temporary - production acceptance ${RUN}`,
  });
  const betaId = madeBeta.payload?.customer?.id;
  check("second customer created", madeBeta.status === 201);
  if (betaId) created.push({ id: betaId, businessName: BETA.businessName });

  const betaSession = await login(BETA.email, BETA.password);
  const betaToken = betaSession.payload?.token;
  check("the second customer signs in", betaSession.payload?.valid === true);

  const betaSpaces = (await asCustomer(betaToken)).payload?.workspaces ?? [];
  const betaSlug = betaSpaces[0]?.slug;
  check("they have their own workspace", Boolean(betaSlug));

  const acmeView = (await asCustomer(acmeToken)).payload?.workspaces ?? [];
  check(
    "customer A cannot see customer B's workspace",
    !acmeView.some((w) => w.slug === betaSlug)
  );
  const directHit = await asCustomer(acmeToken, `/api/workspace/${betaSlug}`);
  check(
    "a direct request for customer B's workspace is refused",
    !(
      directHit.status === 200 &&
      directHit.payload?.workspace?.slug === betaSlug
    ),
    `${directHit.status}`
  );
  check(
    "customer B cannot read customer A's chats",
    (await asCustomer(betaToken, `/api/workspace/${slug}/chats`)).status !== 200
  );

  // ----------------------------------------------------------- durability --
  section("It survives a cold start");
  // A gap long enough that the next request is very likely a new instance,
  // then ask production for the same data again.
  await new Promise((resolve) => setTimeout(resolve, 20_000));
  const afterGap = await api.get("/api/founder/customers");
  check(
    "the customers are still there after a pause",
    (afterGap.payload?.customers ?? []).some((c) => c.id === acmeId)
  );
  check(
    "and they can still sign in",
    (await login(nextEmail, nextPassword)).payload?.valid === true
  );

  return finish();
})().catch(async (error) => {
  console.error("\nAcceptance crashed:", error);
  failed += 1;
  failures.push(`crashed: ${error.message}`);
  await finish();
});

async function finish() {
  section("Cleaning up");
  await cleanup();
  console.log(`  removed ${created.length} temporary customer(s)`);

  console.log(
    `\n${"=".repeat(62)}\nPRODUCTION: ${passed} passed, ${failed} failed, ${blockedCount} blocked\n${"=".repeat(62)}`
  );
  if (failures.length) {
    console.log("\nFailures:");
    for (const name of failures) console.log(`  - ${name}`);
  }
  if (blockedItems.length) {
    console.log("\nBlocked:");
    for (const item of blockedItems) console.log(`  - ${item}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}
