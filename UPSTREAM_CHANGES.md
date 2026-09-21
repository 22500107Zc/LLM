# Upstream Changes

This fork tracks **Mintplex-Labs/anything-llm** (v1.16.1) and adds a commercial
layer on top of it.

The guiding rule: **add, do not rewrite.** Almost all commercial functionality
lives in new directories (`server/business/`, `frontend/src/pages/Business/`)
that upstream will never touch. Only a small number of upstream files are
modified, each in a way designed to survive a merge.

---

## 1. Modified upstream files

### `server/index.js` — 4 insertions, ~20 lines

| Change | Reason | Merge risk |
| --- | --- | --- |
| Require the business router, Stripe webhook handler, boot checks and auth guard | Wire the commercial layer in | **Low** — additive imports |
| `bootCommercialPlatform()` before middleware | Refuse to start a production deployment with weak secrets | **Low** |
| Mount `/api/billing/stripe/webhook` with `express.raw()` **before** `bodyParser.json()` | Stripe signature verification needs the exact signed bytes. Placing it after the JSON parser silently breaks verification. | **Medium** — if upstream reorders body parsers, re-check that this stays *above* them |
| `apiRouter.use(requireAuthenticatedMode)` directly after `app.use("/api", apiRouter)` | Closes upstream's anonymous passthrough in production | **Medium** — must remain the first middleware on the api router |
| `businessEndpoints(apiRouter)` with the other endpoint registrations | Mount the business API | **Low** |

**Security-sensitive.** Both the webhook mount position and the auth guard
position matter. Verify them after any upstream merge.

### `server/prisma/schema.prisma` — appended only

15 new models appended to the end of the file. No upstream model, column,
relation or index is altered.

| Model | Purpose |
| --- | --- |
| `billing_subscription` | Singleton Stripe subscription state |
| `billing_events` | Webhook idempotency ledger |
| `audit_logs` | Business audit trail |
| `platform_user_profiles` | Business role per user |
| `agent_profiles` | Business agent layer over workspaces |
| `leads`, `escalations` | Lead capture and human handoff |
| `integrations`, `integration_deliveries` | Outbound business systems |
| `knowledge_gaps` | Unanswered-question detection |
| `quality_tests`, `quality_runs`, `quality_results` | AI regression testing |
| `conversation_reviews` | Conversation review state |
| `platform_settings` | Company profile and onboarding |

**Merge risk: Low.** Appended at the end. An upstream migration and ours can
both apply; resolve by keeping both blocks.

Migration: `server/prisma/migrations/20260920232133_commercial_platform/`

### `server/package.json` — 2 dependencies

`stripe` (billing) and `nodemailer` (lead/escalation email).
**Merge risk: Low.**

### `frontend/src/utils/paths.js`

- `github()`, `discord()`, `docs()`, `chatModes()`, `mailToMintplex()` and
  `hosting()` now resolve to the deployment's own support address instead of
  upstream properties. The helpers are **kept** rather than deleted so upstream
  components that import them keep compiling.
- Added a `business.*` path group.
- The default-exported object literal is now a named `paths` const so the
  helpers can reference one another.

**Merge risk: Medium** — upstream edits to this file will conflict on the
export shape. Keep the named const.

### `frontend/src/components/Footer/index.jsx`

Default footer shows the customer's support contact instead of GitHub, Discord
and upstream docs. The administrator-configured custom-footer-icons path is
unchanged. **Merge risk: Low.**

### `frontend/src/components/SettingsSidebar/index.jsx`

- Business navigation inserted at the top of `SidebarOptions`, above a divider;
  upstream's sections follow unchanged.
- `AppVersion` renders plain text instead of linking to upstream's releases.
- Phosphor icon imports extended.

**Merge risk: Medium** — upstream frequently edits this file. The business
block is contiguous and clearly commented for easy re-application.

### `frontend/src/components/UserMenu/UserButton/index.jsx`

`paths.mailToMintplex()` → `paths.support()`. **Merge risk: Low.**

### `frontend/src/pages/OnboardingFlow/Steps/`

- `Survey/` **deleted**. It POSTed the operator's email, use case and free-text
  comment to `https://onboarding.anythingllm.com`. Unacceptable for a customer
  deployment.
- `index.jsx` no longer registers the step.
- `DataHandling/index.jsx` now completes onboarding instead of routing to it.
- `ONBOARDING_SURVEY_URL` removed from `utils/constants.js`.

**Merge risk: Low** — if upstream reintroduces the survey, delete it again.

### `frontend/src/main.jsx`

13 business routes added before the catch-all. **Merge risk: Low.**

### `.gitignore`

Ignores `server/.env`, `server/.env.production`, `docker/.env`.

---

## 2. New files (no merge risk)

```
server/business/                          Commercial backend
  config.js                               Env-driven brand/limits/billing config
  boot.js                                 Production posture checks
  billing/{stripe,service,webhook}.js     Stripe integration
  models/                                 billing, audit, team, agentProfile,
                                          lead, escalation, integration,
                                          platformSettings
  services/                               notifier, outboundWebhook (SSRF),
                                          analytics, conversations,
                                          knowledgeGaps, aiQuality, health
  middleware/                             role/capability checks, rate limiting,
                                          billing gate, auth-mode enforcement
  routes/                                 billing, agents, knowledge, leads,
                                          insights, team, integrations,
                                          platform, publicCapture

server/__tests__/business/                161 tests

frontend/src/business/brand.js            Central brand config
frontend/src/models/business.js           Business API client
frontend/src/components/Business/Layout/  Shared UI primitives
frontend/src/pages/Business/*             13 business pages

scripts/backup.sh, scripts/restore.sh     Backup and restore
docker/docker-compose.production.yml      Hardened production compose
docker/.env.production.example            Deployment configuration template
DEPLOYMENT.md, UPSTREAM_CHANGES.md        Documentation
```

---

## 3. Upstream behaviour deliberately changed

| Behaviour | Upstream | Here | Why |
| --- | --- | --- | --- |
| Anonymous access | Single-user with no `AUTH_TOKEN` serves everything | Production returns 401 outside a bootstrap allowlist | A deployment on the public internet must not serve the whole application to anyone |
| Embed allowlist | Optional (`EMBED_REQUIRE_ALLOWLIST`) | Default on | An embed with no allowlist answers from any website |
| `SYS_ADMIN` capability | Granted in compose | Dropped, all caps dropped | Near-root on the host; not needed for core function |
| Onboarding survey | Sends operator data upstream | Removed | Customer data must not leave the deployment |
| Telemetry | On unless disabled | `DISABLE_TELEMETRY=true` in the template | Same reason |
| Embed overrides | Configurable | Model/temperature/prompt overrides forced off for business-created website agents | A website visitor must not be able to change the model or system prompt |

---

## 4. Merging an upstream release

```bash
git remote add upstream https://github.com/Mintplex-Labs/anything-llm.git
git fetch upstream
git merge upstream/master
```

Then verify, in order:

1. **`server/index.js`** — the Stripe webhook is still mounted *before*
   `bodyParser.json()`, and `requireAuthenticatedMode` is still the first
   middleware on `apiRouter`.
2. **`schema.prisma`** — both upstream's and our model blocks are present; run
   `npx prisma migrate dev`.
3. **`paths.js`** — the named `paths` const and `business.*` group survived.
4. **`SettingsSidebar`** — the business nav block is still at the top.
5. **Survey** — deleted again if upstream reintroduced it.
6. `npx jest` — the 161 business tests must pass.
7. `cd frontend && npx vite build`.

---

## 5. Licensing

Upstream AnythingLLM is MIT licensed. `LICENSE` is unmodified and retained.
We do not claim authorship of upstream code. Only marketing surfaces
(community links, hosted-instance upsells, the upstream survey) were removed
from the customer-facing UI; no copyright or licence notice was touched.
