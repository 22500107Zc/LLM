# Final Acceptance

Managed Business AI Operations Platform — $3,888.88 per month, one business per
dedicated deployment.

**Verification run:** `20260921T190412Z`
**Commit under test:** `41608f6` (return-on-subscription pass)
**Evidence:** `test-results/20260921T190412Z/` (excluded from Git and from the
runtime image; reproduce with `./scripts/final-verification.sh`)

Every result below was produced by running the gate in this pass. Nothing is
carried over from an earlier run, and nothing is reported as passing that was
not observed passing.

---

## 1. Results

| Result | Gate | Evidence |
| --- | --- | --- |
| **PASS** | `git diff --check` — no whitespace damage | `git-diff-check.log` |
| **PASS** | server lint | `lint-server.log` |
| **PASS** | frontend lint | `lint-frontend.log` |
| **PASS** | collector lint | `lint-collector.log` |
| **PASS** | frontend production build | `frontend-build.log` |
| **FAIL** | unit tests — 1460 of 1463 pass; the 3 failures are the ffmpeg tests below | `unit-tests.log` |
| **PASS** | the 3 ffmpeg failures reproduce identically on untouched upstream | `ffmpeg-baseline.log` |
| **PASS** | business, billing, Stripe binding and value tests — 368 tests | `business-tests.log` |
| **PASS** | adversarial answer-grading tests | `grading-tests.log` |
| **PASS** | zero critical advisories in production dependencies | `audit-summary.log` |
| **PASS** | Compose config resolves, and fails loudly when a variable is missing | `compose-config.log` |
| **PASS** | acceptance suite against a live deployment — 65/65 | `disposable.log` |
| **PASS** | document pipeline, PDF + DOCX + PPTX end to end — 25/25 | `disposable.log` |
| **PASS** | restart persistence — data identical before and after | `disposable.log` |
| **PASS** | backup and restore into a clean target | `disposable.log` |
| **PASS** | desktop and mobile visual check of 9 pages — 46/46 | `disposable.log`, `live-run/screenshots/` |
| **PASS** | Value page and calculator with real figures, desktop and phone — 26/26 | `live-run/value-visual.log` |
| **PASS** | backup-before-update gating, in isolation — 18/18 | `scripts/operator-backup-test.sh` |
| **PASS** | no customer-visible upstream branding in source | `branding-search.log` |
| **PASS** | no hardcoded developer paths | `hardcoded-paths.log` |
| **PASS** | no fixed credentials in the test scripts | `fixed-credentials.log` |
| **PASS** | no committed secrets in the tree or in any commit | `secret-scan.log` |
| **BLOCKED** | Stripe test-mode lifecycle | needs `STRIPE_SECRET_KEY` (test mode) |
| **BLOCKED** | provider-backed answer correctness | needs a model provider API key |
| **BLOCKED** | fresh container boot | needs a Docker daemon |

**19 passed · 1 failed · 3 blocked**, plus the two suites above run directly.

---

## 2. The one failure

`collector/__tests__/utils/WhisperProviders/ffmpeg/index.test.js` — three tests:

```
● FFMPEGWrapper › should find ffmpeg executable
● FFMPEGWrapper › should validate ffmpeg executable
● FFMPEGWrapper › should convert audio file to wav format
```

All three throw `FFMPEG binary not found.`

**This was not assumed to be pre-existing — it was proved.** The gate creates a
git worktree at `origin/master` (commit `da6685510ce691b2e1be417f739c7dffee3cfc49`,
untouched upstream code with none of the commercial changes) and runs the same
suite there:

| | This branch | Untouched upstream |
| --- | ---: | ---: |
| Distinct `FFMPEGWrapper` failures | 3 | 3 |

The same three tests, with the same error. `git diff origin/master HEAD` over
`collector/utils/WhisperProviders` and its tests is **empty** — the code and the
tests are byte-identical to upstream.

The cause is environmental: `ffmpeg-static` downloads its binary at install
time, and that download is blocked here. It affects audio and video
transcription only. Nothing else in the product depends on it, and a deployment
built from `docker/Dockerfile` on a host with normal network access will have
the binary.

---

## 3. What the three blocked gates need

None of these can be satisfied from this environment. They are listed so nobody
mistakes "not run" for "passed".

| Blocked gate | What it needs | How to run it |
| --- | --- | --- |
| Stripe webhook handling (**simulated** — self-signed events) | A Stripe **test-mode** secret key | `STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-test-mode-verification.cjs` |
| Genuine Stripe checkout, subscription, paid invoice and real event delivery | Test-mode key, price id, and either the `stripe` CLI or a configured webhook endpoint | `BASE_URL=... STRIPE_SECRET_KEY=sk_test_... STRIPE_PRICE_ID=price_... TEST_USER=... TEST_PASSWORD=... STRIPE_CLI=1 node scripts/stripe-live-test-checkout.cjs` |
| Provider-backed answer correctness | A model provider API key | `OPEN_AI_KEY=... ./scripts/run-disposable-acceptance.sh` |
| Production Docker image build and boot | A Docker daemon | `./scripts/docker-image-verification.sh` |

Both Stripe scripts refuse any `sk_live_` key outright. The two Stripe entries
are deliberately separate: the first tests **this application's** handling of
events it signs itself, and proves nothing about Stripe. The second uses only
objects Stripe created and only events Stripe sent.

Until a provider key runs that suite, what is verified is that the endpoints,
retrieval, attribution, isolation, persistence and refusal *plumbing* work. The
**wording** of a generated answer has not been verified against a live model in
this pass, and the delivery report says so rather than implying otherwise.

---

## 4. Visual verification

Nine customer pages — Dashboard, Agents, Knowledge, Conversations, Value, Team,
Integrations, Audit log, Billing — loaded in Chromium at 1440×900 and at
390×844 with a real phone user agent. 18 screenshots in
`live-run/screenshots/`. 46 of 46 assertions passed:

- every page rendered real content, not a blank screen or an error overlay
- no page scrolls sideways at phone width
- no page's rendered DOM contains `AnythingLLM`, `Mintplex` or `anythingllm.com`

The mobile pass sends an iPhone user agent deliberately: the application
chooses its mobile layout from the user agent, not the viewport width, so
emulating only the width tested a layout no customer would ever see. Doing it
properly is what surfaced the fixed-header overlap that is now fixed.

---

## 5. Dependency audit, production vs development

Production dependencies (what ships in the image):

| Workspace | Deps | Critical | High |
| --- | ---: | ---: | ---: |
| `server` | 1084 | **0** | 25 |
| `frontend` | 284 | **0** | **0** |
| `collector` | 497 | **0** | 24 |

Development dependencies (build and test tooling; not in the image):

| Workspace | Deps | Critical | High |
| --- | ---: | ---: | ---: |
| `server` | 333 | 0 | 20 |
| `frontend` | 800 | 0 | 48 |
| `collector` | 120 | 0 | 16 |

`docker/Dockerfile` installs the server and collector with
`yarn install --production`, and builds the frontend in a stage from which only
`dist/` is copied, so no development dependency reaches the image. That is
established by reading the Dockerfile's build stages — **not** by scanning a
built image, because no Docker daemon was available here.

Every remaining high-severity advisory is listed in `SECURITY_AUDIT.md` with
its dependency chain, whether it is in the image, whether user input can reach
it, and its mitigation.

---

## 6. Upstream names that are deliberately kept

The branding search excludes identifiers that are load-bearing rather than
decorative. Renaming them would break the product without hiding anything from
a customer. They are listed here so the exclusion is visible:

| Kept | What it is |
| --- | --- |
| `anythingllm.db` | the SQLite filename; existing deployments and backups depend on it |
| `anythingllm_authToken`, `anythingllm_user`, `anythingllm_completed_questionnaire` | browser storage keys |
| `ANYTHING_LLM_RUNTIME`, `anythingllm-router` | internal runtime and provider identifiers |
| `cdn.anythingllm.com` | the host that actually serves the fallback embedding models |
| `hub.external.anythingllm.com` | the real Community Hub API (the feature is off by default) |
| `MintplexLabs/multilingual-e5-small` | a real Hugging Face model id |
| `Mintplex-Labs/epub2-static`, `@mintplex-labs/*` | real package names in `package.json` |
| source comments referencing upstream issues | accurate documentation; no customer reads them |

None of these appears anywhere a customer looks. The rendered-DOM assertion in
the visual check is the check that matters for that, and it passes on all nine
pages at both widths.

`LICENSE` and `NOTICE` keep the upstream copyright and attribution in full, as
the MIT License requires. That is attribution, not branding, and it stays.

---

## 7. Software verdict

**CONDITIONAL GO.**

Conditional on exactly three things, each needing a credential or a facility
this environment does not have:

1. Run the Stripe test-mode lifecycle with a test key before taking a payment.
2. Run the provider-backed verification with the customer's model provider key
   before telling them their AI answers correctly.
3. Build and boot the container on a host with a Docker daemon.

Everything under this repository's own control passes. The one failing gate is
proved to be upstream's and environmental.

**This is a verdict on the software. It is not a statement about business
return.** Passing tests say the product works. They say nothing about what any
particular customer will get back — that is measured per customer, from their
own records, on the Value page, after the product has been in use.

The Value page reports whatever that turns out to be. It sets no target, issues
no verdict, and treats 30x, 82x and 0.4x alike as results rather than grades,
so there is no commercial pass or fail for this release to report.
