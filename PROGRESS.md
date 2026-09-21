# Progress and handoff

A future session should be able to read this, `git log`, and the tests, and know
exactly where development stopped. Keep it factual.

**Last updated:** 2026-09-21
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
or billing comparison, no FastAPI, no PostgreSQL, no Python, no multi-tenant
company table, and no separate founder web control plane. If a prompt describes
those, they do not exist here — check before building, and do not create a
second application alongside this one.

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
- **Security and dependency gates** — zero critical advisories in production
  dependencies; remaining highs documented in `SECURITY_AUDIT.md` with chain and
  reachability. Committed-secret scanner reports locations only, never values.

## Currently implementing

Nothing in flight. The working tree is clean.

## Remaining / next actions

1. **Run the three credential-bound gates** (no code needed, see below).
2. **Founder control plane** — today provisioning is the `operator.sh` CLI. A
   founder-only web surface does not exist. If one is wanted, it belongs in
   `server/business/` behind a server-side secret; never put a founder password
   in frontend code, a bundle, seed data or a log.
3. **Private repository migration** — `PRIVATE_REPO_MIGRATION.md`. Blocked on an
   account action; the script copies and verifies and deletes nothing.

---

## Test status

```
npx jest                       1460 passed, 3 failed (ffmpeg), 1463 total
npx jest __tests__/business     381 passed, 381 total   (run from server/)
./scripts/final-verification.sh 19 passed, 1 failed, 3 blocked
./scripts/operator-backup-test.sh   18 passed, 0 failed
```

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
