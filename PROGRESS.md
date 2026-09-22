# Progress and handoff

A future session should be able to read this, `git log`, and the tests, and know
exactly where development stopped. Keep it factual.

**Last updated:** 2026-09-22
**Branch:** `claude/commercial-b2b-ai-platform-0skp39`

---

## What this repository actually is

Read this first, because it is easy to assume otherwise.

This is a fork of **AnythingLLM** (Mintplex Labs, MIT — see `LICENSE` and
`NOTICE`) turned into a **Managed Business AI Operations Platform**, sold at a
configurable subscription fee (currently $3,888.88/month via
`PLAN_AMOUNT_CENTS`).

| | |
| --- | --- |
| Backend | Node / Express (`server/`), commercial code isolated in `server/business/` |
| Database | SQLite via Prisma locally; **Postgres on Vercel** — `scripts/prisma-provider.cjs` switches the datasource. |
| Frontend | React + Vite (`frontend/`) |
| Collector | Separate Node service for document parsing (`collector/`) |
| Money | **Integer cents everywhere.** No floats, no Decimal library needed. |
| Accounts | **One application, many founder-created customer accounts.** A customer is a `users` row plus a `business_customers` row. Isolation is workspace membership. |
| Onboarding | The founder console at `/founder`. `scripts/operator.sh` still exists for self-hosted/dev operations but is NOT the commercial onboarding path. |

### What this repository is NOT

It contains no revenue-leakage engine, no findings/evidence model, no contract
or billing comparison, no FastAPI, no PostgreSQL, no Python, and no multi-tenant
company table. If a prompt describes those, they do not exist here — check
before building, and do not create a second application alongside this one.

There **is** a founder control plane at `/founder`. It manages customer
*accounts* in this one application — it does not create deployments, containers
or websites. See "Founder control plane" below.

---

## Completed

- **Commercial platform core** — billing, security hardening, business domain
  models, 14-item customer navigation, agents, knowledge/RAG, website embed
  agents, leads, escalation, conversations, analytics, knowledge gaps, AI
  quality testing, team roles, integrations, audit log.
- **AI quality grader** — clause-aware deterministic grading
  (`server/business/services/answerGrading.js`). No paid LLM call to grade.
- **Founder-controlled customer accounts** — `server/business/models/customer.js`
  and `server/business/founder/`. The founder creates, disables and restores
  accounts. Stripe is not consulted.
- **Value / return on subscription** — `server/business/models/value.js`.
  Reports the customer's own return; no targets, no qualification verdict.
  Separates recorded/estimated from verified. Never counts a lead as revenue.
- **Operator CLI** — `scripts/operator.sh`: provision, check, update, status,
  list, backup, restore-test, restore, suspend, resume, logs,
  remove-containers. Update stops if its backup fails. No data-deletion command.
- **Stripe stays outside the application** — payment is arranged by sending a
  hosted Payment Link by email. No Stripe API key is required and no webhook
  grants access.
- **AI endpoint coverage** — `AI_ENDPOINTS` in
  `server/business/routes/index.js` lists every endpoint that reaches a model,
  and a test walks the real route files and fails if a new one appears that is
  not accounted for.
- **Security and dependency gates** — zero critical advisories in production
  dependencies; remaining highs documented in `SECURITY_AUDIT.md` with chain and
  reachability. Committed-secret scanner reports locations only, never values.
- **Founder control plane** — `server/business/founder/`, `/founder` in the
  frontend, documented in `DEPLOYMENT.md` §2a. See below.
- **The whole commercial loop, proved on Postgres through the real Vercel
  entry point** — `scripts/production-loop-verification.cjs`. 86 checks, 0
  failures, 1 honestly blocked. See "Proof, not assertion" below.
- **A customer lands somewhere usable** — creating an account provisions that
  business its first workspace. Customers are `default` role and cannot create
  one themselves, which is deliberate: an admin would see everyone's data.
- **Nothing from the engine room reaches a customer** —
  `server/business/services/customerFacing.js` translates provider errors,
  missing keys and module failures into plain sentences; the real error goes to
  the log. Tested against API keys, module names, Prisma errors and stack text.
- **Agent chat is off where websockets cannot exist.** The default chat mode is
  `automatic`, which with a tool-calling model routes every message into the
  agent flow and answers with a websocket address. On Vercel that address goes
  nowhere and the chat would hang silently. `api/index.js` disables it there and
  the product says so; self-hosted, agents work unchanged.
- **Retrieval with no second service** — `VECTOR_DB` defaults to `pgvector` on
  the serverless runtime, reusing the same `DATABASE_URL`.
- **Nothing under `/api` answers with an HTML error page.** The serverless
  build mounts fewer endpoint groups than the long-running server; the ones the
  product has but this runtime cannot host answer 503 with a plan sentence, and
  anything that is not a route answers a plain JSON 404 - deliberately not a
  plan message, which would tell someone probing `/api/signup` that signup
  exists somewhere. An Express error handler catches the rest so no stack trace
  can reach a browser.

## Currently implementing

Nothing in flight.

## Remaining / next actions

1. **Add `DATABASE_URL` and a model provider key to the Vercel project** and
   redeploy — see `VERCEL.md` §1. Both are account actions; there is no code
   left to write for either.
2. **Run the two credential-bound gates** (no code needed, see below).
3. **Private repository migration** — `PRIVATE_REPO_MIGRATION.md`. Blocked on an
   account action; the script copies and verifies and deletes nothing.

## Proof, not assertion

`scripts/production-loop-verification.cjs` is the one to read. It requires a
Postgres `DATABASE_URL`, refuses to run against SQLite, deletes every `STRIPE_*`
variable from the process, and drives `api/index.js` — the actual Vercel entry
point, not a test harness — over a real socket.

```
DATABASE_URL=postgresql://… node scripts/production-loop-verification.cjs
COMMERCIAL LOOP: 86 passed, 0 failed, 1 blocked
```

Among the 70: a founder creates a customer; the customer signs in and lands in
their own workspace; the founder disables them and their **already issued**
session dies on the very next request; passwords are never stored or returned
in recoverable form; one customer cannot read another's workspace even by
calling the API directly; the handler is restarted with an empty module cache
and every account is still there; a customer's token is worthless on the
founder API.

Two AI sections, deliberately separate:

- **AI workflow** — needs a paid provider key, so it is reported **BLOCKED**.
  It is never reported as passing. What is checked without a key is that the
  failure reaches the customer as a readable sentence with no infrastructure
  detail in it.
- **AI pipeline, against a real OpenAI-compatible endpoint** — the product is
  not mocked, stubbed or short-circuited: it selects a provider, opens a real
  HTTP connection, sends the customer's message and the workspace system
  prompt, and parses a real SSE stream back. This proves the pipeline works end
  to end. It does **not** prove answer quality, and does not claim to.

---

## Test status

```
npx jest                       1531 passed, 3 failed (ffmpeg), 1534 total
npx jest __tests__/business     439 passed, 439 total   (run from server/)
node scripts/production-loop-verification.cjs   86 passed, 0 failed, 1 blocked
./scripts/final-verification.sh 19 passed, 1 failed, 3 blocked
./scripts/operator-backup-test.sh   18 passed, 0 failed
```

The 51 founder tests run against a real database, real HTTP and the real login
endpoint — including the one that matters most: sign a customer in, disable
them mid-session, and watch their very next request come back 401.

The 3 failures are `FFMPEGWrapper` tests needing an ffmpeg binary this machine
cannot download. **Proved** pre-existing: `scripts/final-verification.sh` builds
a worktree at `origin/master` (untouched upstream) and gets the same 3 failures;
the ffmpeg source and tests are byte-identical to upstream.

---

## Known issues

- **ffmpeg** — see above. Environmental, affects audio/video transcription only.
- **Two gates cannot run here** and are never reported as passing:

| Gate | Needs | Command |
| --- | --- | --- |
| Provider answer correctness | a model provider key | `OPEN_AI_KEY=... ./scripts/run-disposable-acceptance.sh` |
| Production image build/boot | a Docker daemon | `./scripts/docker-image-verification.sh` |

- **Repository is public.** `22500107Zc/LLM` is a public fork; GitHub will not
  make a fork private. All commercial commits are on the feature branch, not on
  `master`.

---

## Founder control plane

`/founder` — one operator, one password, and the customers of this one
application.

| Piece | Where |
| --- | --- |
| Authentication | `server/business/founder/auth.js` |
| API | `server/business/founder/routes.js`, mounted at `/api/founder` |
| Customer model | `server/business/models/customer.js` |
| Password hash generator | `scripts/founder-password.cjs` |
| UI | `frontend/src/pages/Founder/`, `frontend/src/models/founder.js` |
| Setup | `DEPLOYMENT.md` §2a |

### The commercial workflow

1. Qualify a business.
2. Send them the Stripe-hosted Payment Link **by email**, outside the product.
3. They subscribe. Confirm the money arrived.
4. In `/founder`, create their account with the login email and password they
   chose.
5. They sign in at the same application everyone else uses.
6. If they stop paying, disable them. If they resume, restore them.

There is no public signup, no free trial, no self-service organization, and no
route that turns a payment into an account.

### A customer is an account, not a deployment

One `users` row plus one `business_customers` row holding the business
information. Creating a customer starts no container, writes no env file and
needs no new website or domain.

### One credential store, one access flag

The login email is the `users.username` field, which already accepts a
lowercased address. The password is hashed by the inherited `User` model — the
same store `/request-token` reads. Nothing in `customer.js` hashes a password
itself.

Access state is `users.suspended` and nowhere else, because that is the flag
`utils/middleware/validatedRequest.js` already checks. It re-reads the user from
the database on **every authenticated request**, so disabling a customer ends
the session they are sitting in rather than lasting until their token expires —
and there is nothing to bypass by calling an endpoint directly.

Customers are created `default`, never `admin`: an admin would see every other
customer's workspaces. Workspace membership (`Workspace.whereWithUser`) is the
isolation primitive.

### Stripe is outside application authorization

No Stripe API key is required. No webhook grants, revokes or restores access.
No Checkout Session, customer or subscription is created through Stripe's API
by this product. The subscription gate that used to answer 402 on AI routes is
unmounted, and a test deletes every Stripe variable from the environment and
signs a customer in anyway.

`payment_note` on the customer record is the founder's own memo that money
arrived. Nothing reads it to decide anything.

The billing module survives as inert reporting. It can no longer conclude that
anyone should be locked out.

### Founder credential handling

The password exists only as a bcrypt hash in `FOUNDER_PASSWORD_HASH`. A test
walks the source tree and fails if it is read anywhere but `founder/auth.js`
(and `updateENV.js`, which only keeps it from being deleted), or if the string
appears anywhere in the frontend. The session is an opaque random token in an
HttpOnly cookie held server-side; the browser keeps only a CSRF token, which
does nothing without the cookie. Login is rate limited per address, keyed on
the address Express resolves rather than a forgeable `X-Forwarded-For`.

A customer's JWT is worth nothing on the founder API: `requireFounder` looks
only at the founder cookie and the server-side store, and the router mounts
ahead of the customer API router.

---

## Deploying to Vercel

**Deployed**, and waiting on two values. See `VERCEL.md`.

| | |
| --- | --- |
| Project | `business-ai-operations-platform` |
| URL | https://business-ai-operations-platform-22500107zcs-projects.vercel.app |
| Entry point | `api/index.js` |
| Build | `scripts/vercel-build.cjs` |
| Datasource switch | `scripts/prisma-provider.cjs` |

The site serves, the serverless function boots and answers, and every API call
returns a deliberate 500 saying `DATABASE_URL` is not set. Adding a Postgres
connection string and a model provider key and redeploying is the whole
remaining step; the build creates the schema itself.

**What does not work on Vercel**, and is not pretended to: document upload and
parsing (the collector is a second long-running service) and agent automations
(no websockets). Those answer 503 with a plain sentence about the plan rather
than an engineering error. Everything else — accounts, access control,
workspaces, conversation, retrieval over pgvector — runs there.

## Next action

Add `DATABASE_URL` and a model provider key to the Vercel project and redeploy.
That is the only thing between the live deployment and a paying customer.
