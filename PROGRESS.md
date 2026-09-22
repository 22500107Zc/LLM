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
| Database | **SQLite via Prisma** (`server/prisma/schema.prisma`). Not PostgreSQL. |
| Frontend | React + Vite (`frontend/`) |
| Collector | Separate Node service for document parsing (`collector/`) |
| Money | **Integer cents everywhere.** No floats, no Decimal library needed. |
| Tenancy | **One business = one dedicated deployment.** Isolation is the container boundary, not a `company_id` column. There is no shared multi-tenant database. |
| Provisioning | `scripts/operator.sh` — the operator/founder CLI |

### What this repository is NOT

It contains no revenue-leakage engine, no findings/evidence model, no contract
or billing comparison, no FastAPI, no PostgreSQL, no Python, and no multi-tenant
company table. If a prompt describes those, they do not exist here — check
before building, and do not create a second application alongside this one.

There **is** now a founder control plane (`/founder`), but it is not a tenancy
layer: it reads the operator host's `deployments/` directory and each
deployment's own status endpoint. See "Founder control plane" below.

---

## Completed

- **Commercial platform core** — billing, security hardening, business domain
  models, 14-item customer navigation, agents, knowledge/RAG, website embed
  agents, leads, escalation, conversations, analytics, knowledge gaps, AI
  quality testing, team roles, integrations, audit log.
- **AI quality grader** — clause-aware deterministic grading
  (`server/business/services/answerGrading.js`). No paid LLM call to grade.
- **Stripe deployment binding** — `server/business/billing/binding.js`. An
  unbound deployment can only bind from a checkout it can prove is its own.
- **Value / return on subscription** — `server/business/models/value.js`.
  Reports the customer's own return; no targets, no qualification verdict.
  Separates recorded/estimated from verified. Never counts a lead as revenue.
- **Operator CLI** — `scripts/operator.sh`: provision, check, update, status,
  list, backup, restore-test, restore, suspend, resume, logs,
  remove-containers. Update stops if its backup fails. No data-deletion command.
- **Stripe-hosted Payment Link** — the preferred way to take payment. See
  "Important architectural decisions" below.
- **Access-gate coverage** — `GATED_AI_PATHS` in
  `server/business/routes/index.js` lists every path where AI usage is gated,
  and a test walks the real route files and fails if any endpoint reaching a
  model is missing from it. This found and closed a real gap: the developer
  API's thread chat endpoints were ungated, so a restricted deployment could
  keep using the model by calling them directly.
- **Security and dependency gates** — zero critical advisories in production
  dependencies; remaining highs documented in `SECURITY_AUDIT.md` with chain and
  reachability. Committed-secret scanner reports locations only, never values.
- **Founder control plane** — `server/business/founder/`, `/founder` in the
  frontend, documented in `DEPLOYMENT.md` §2a. See below.

## Currently implementing

Nothing in flight.

## Remaining / next actions

1. **Run the three credential-bound gates** (no code needed, see below).
2. **Private repository migration** — `PRIVATE_REPO_MIGRATION.md`. Blocked on an
   account action; the script copies and verifies and deletes nothing.

---

## Test status

```
npx jest                       1521 passed, 3 failed (ffmpeg), 1524 total
npx jest __tests__/business     429 passed, 429 total   (run from server/)
./scripts/final-verification.sh 19 passed, 1 failed, 3 blocked
./scripts/operator-backup-test.sh   18 passed, 0 failed
```

The founder suite was proved to catch what it exists for: each of ten defects
was reintroduced one at a time — the route's auth gate removed, an unknown
session token accepted, the CSRF check skipped, the password hash returned from
`/session`, a business provisioned already active, an unpaid deployment treated
as paid, a payment link accepted on any host, and the operator status endpoint
left open with no token configured, the login lockout keyed on a forgeable
`X-Forwarded-For`, and the failed-attempt map left unbounded — and the suite
failed on every one.

The 3 failures are `FFMPEGWrapper` tests needing an ffmpeg binary this machine
cannot download. **Proved** pre-existing: `scripts/final-verification.sh` builds
a worktree at `origin/master` (untouched upstream) and gets the same 3 failures;
the ffmpeg source and tests are byte-identical to upstream.

---

## Known issues

- **ffmpeg** — see above. Environmental, affects audio/video transcription only.
- **Three gates cannot run here** and are never reported as passing:

| Gate | Needs | Command |
| --- | --- | --- |
| Genuine Stripe checkout | test-mode key + price + `stripe` CLI | `node scripts/stripe-live-test-checkout.cjs` |
| Provider answer correctness | a model provider key | `OPEN_AI_KEY=... ./scripts/run-disposable-acceptance.sh` |
| Production image build/boot | a Docker daemon | `./scripts/docker-image-verification.sh` |

- **Repository is public.** `22500107Zc/LLM` is a public fork; GitHub will not
  make a fork private. All commercial commits are on the feature branch, not on
  `master`.

---

## Founder control plane

`/founder` — one operator, one password. Optional: `scripts/operator.sh` remains
the complete operator interface and nothing depends on the console.

| Piece | Where |
| --- | --- |
| Authentication | `server/business/founder/auth.js` |
| API | `server/business/founder/routes.js`, mounted at `/api/founder` |
| Live status reader | `server/business/founder/deploymentStatus.js` |
| Shared provisioning core | `server/business/services/provisioning.js` |
| CLI bridge to that core | `scripts/provision-core.cjs` |
| Password hash generator | `scripts/founder-password.cjs` |
| UI | `frontend/src/pages/Founder/`, `frontend/src/models/founder.js` |
| Setup | `DEPLOYMENT.md` §2a |

**One provisioning implementation, two front doors.** `cmd_provision` in
`operator.sh` is entirely filesystem work, so it moved into a shared Node
service that both the CLI and the console call. Two copies of the collision
checks would eventually differ in a way that puts two customers on one port.

**The password exists only as a bcrypt hash in `FOUNDER_PASSWORD_HASH`.** A test
walks the source tree and fails if `FOUNDER_PASSWORD_HASH` is read anywhere but
`founder/auth.js` (and `updateENV.js`, which only keeps it from being deleted),
or if the string appears anywhere in the frontend. The session is an opaque
random token in an HttpOnly cookie, held server-side; the client keeps only a
CSRF token, which does nothing without the cookie.

**A customer session is worth nothing here.** `requireFounder` looks only at the
founder cookie and the server-side store. The router is mounted on `app` before
the customer API router, so no customer middleware touches it and it touches
none of theirs.

**Where there is no state directory, there is no console.** A customer's own
deployment has none, so `availability()` fails and every route answers 404 —
not 401, which would confirm the paths exist.

**No founder input reaches a shell.** The provisioning service executes no
process and never talks to Docker. Starting a container is the one privileged
operation in the platform; it stays in the CLI and the console prints the exact
command. There is no `run`, `exec` or equivalent endpoint, and a test asserts
that several plausible spellings of one are unhandled.

**Nothing in the console can mark a business paid.** Only the Stripe webhook
does that, from an event it can prove belongs to that deployment. Unmatched
events are inspection-only and resolved in Stripe — rebinding one from a web
form is exactly the mistake an unmatched event is warning about.

**A provisioned business starts unpaid.** Provisioning writes
`BILLING_ENFORCEMENT_ENABLED=true` and `BILLING_REQUIRE_ACTIVATION=true`, so AI
usage is suspended until the webhook records the first payment. Data is
untouched and administration stays available. `BILLING_REQUIRE_ACTIVATION`
defaults to `false`, so no existing deployment's behaviour changed.

**Live status comes over loopback.** Each deployment serves
`GET /api/platform/operator-status`, guarded by a *strict* health-token check
that 404s when no token is configured (unlike the uptime probe, which passes
through so bring-up works). The console calls it on 127.0.0.1 at the port
recorded in the state directory — never a host from a request — using the
`HEALTHCHECK_TOKEN` provisioning already generated. It returns subscription
state, readiness and unmatched events; no Stripe key, no signing secret, no
customer data, and the deployment identifier only as an 8-character
fingerprint.

## Important architectural decisions

**Payment: Stripe-hosted Payment Link, not an API-created Checkout Session.**
Creating a Checkout Session needs an outbound Stripe call at the exact moment a
customer is paying, so a network blip or an expired key becomes a failed sale.
`STRIPE_PAYMENT_LINK` is a static hosted URL; the application appends
`client_reference_id=<DEPLOYMENT_ID>` and hands it over. Nothing can fail at
purchase time. `createCheckoutSession` is **kept** for deployments with no link
configured — the payment-link path is additive, not a replacement.

**Matching: `client_reference_id`, not email.** `DEPLOYMENT_ID` is 64 random hex
characters that only ever leave the server inside that link. Stripe echoes it
back on `checkout.session.completed`, giving a stable match that does not depend
on the customer typing the right email. Email is a prefill convenience only.
Comparison is constant-time (`binding.idsMatch`).

**An unmatchable payment never activates anything.** Three outcomes, all
recorded in `billing_events`:
- `processed` — applied
- `rejected` — demonstrably belongs to another deployment
- `unmatched` — could not be told safely; **surfaced to a human** on the Billing
  page and via `GET /api/business/billing/events`

**Webhook idempotency** — every `stripe_event_id` is recorded before processing
and unique-constrained, so a replay cannot double-apply. Binding is a single
conditional `UPDATE` against the unbound state, so concurrent deliveries cannot
both win.

**Access is enforced server-side.** `server/business/middleware/billingGate.js`
returns HTTP 402 on restricted AI usage. Hiding frontend buttons is not the
control. Restriction suspends usage and never deletes data.

**Detected is not recovered.** The Value model refuses to treat an estimate as
verified, structurally cannot file a lead as revenue, and keeps one-time
recoveries out of the monthly multiple. Do not weaken this.

**Secrets never reach the browser.** `STRIPE_WEBHOOK_SECRET` and
`STRIPE_SECRET_KEY` are in `protectedKeys` in
`server/utils/helpers/updateENV.js` and are never returned by any route.
`GET /billing/events` returns the webhook *endpoint URL* and never the secret.

---

## Next action

Run the three credential-bound gates on a machine that has a Docker daemon, a
Stripe test key and a model provider key. No further code is required for them.
