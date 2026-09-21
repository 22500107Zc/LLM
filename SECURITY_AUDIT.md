# Security Audit

Managed Business AI Operations Platform. This records what was audited, what
was fixed, what remains, and why each remaining item is acceptable.

**Date of this pass:** 2026-09-21
**Scope:** production dependencies, committed secrets, repository hygiene, and
the platform's own security controls.

**This product holds no certification.** It is not SOC 2 audited, not HIPAA
certified and not ISO 27001 certified, and it inherits no certification from
any upstream project or hosting provider. Nothing in this document should be
presented to a customer as one.

---

## 1. Dependency audit

Audits were run per workspace with that workspace's own package manager and
lockfile (`yarn audit`, yarn 1.22, `yarn.lock` in each of `server/`,
`frontend/`, `collector/`). The root `package.json` declares only
`concurrently` and `jest`, has no lockfile and no installed tree, and nothing
from it reaches the runtime image.

### Production dependencies — before and after this pass

| Workspace | Deps | Critical before | Critical after | High before | High after |
| --- | ---: | ---: | ---: | ---: | ---: |
| `server` | 1084 | 5 | **0** | 142 | 25 |
| `frontend` | 284 | 1 | **0** | 11 | **0** |
| `collector` | 497 | 4 | **0** | 89 | 24 |

"High" counts are advisory instances, not distinct packages. After this pass
the 25 server instances come from 7 packages and the 24 collector instances
from 7 packages; they are listed individually in §1.3.

### Development dependencies (not in the runtime image)

| Workspace | Deps | Critical | High |
| --- | ---: | ---: | ---: |
| `server` | 333 | 0 | 20 |
| `frontend` | 800 | 0 | 48 |
| `collector` | 120 | 0 | 16 |

These are build and test tooling. `docker/Dockerfile` installs the server and
collector with `yarn install --production`, and the frontend is built in a
throwaway stage from which only `dist/` is copied, so no development
dependency is present in the shipped image. Verified by reading the Dockerfile
stages; not verified against a built image, because no Docker daemon was
available in this environment.

### 1.1 Criticals — all resolved

| Package | Where | Fix |
| --- | --- | --- |
| `decompress` (no patch exists) | `collector` → `officeparser@4` → `decompress`. **Reachable**: extracting an uploaded `.pptx` / `.odt` / `.odp`. Zip-slip write outside the target directory. | Upgraded `officeparser` to `5.1.1`, which replaced `decompress` with `yauzl`. `decompress` is gone from the tree. |
| `basic-ftp` | `collector` → `puppeteer` → `pac-proxy-agent` → `get-uri` → `basic-ftp`. Path traversal. | Resolution `basic-ftp@^5.2.0`. |
| `protobufjs` (6.11.4 and 7.2.4) | `server`, `collector`, `frontend` → `@xenova/transformers` / `onnxruntime-web` / `@zilliz/milvus2-sdk-node` → `protobufjs`. Arbitrary code execution and prototype pollution. | Scoped resolutions `**/onnx-proto/protobufjs@^7.5.5`, `@zilliz/milvus2-sdk-node/protobufjs@^7.5.5`, `onnxruntime-web/protobufjs@^7.5.5`. Every `protobufjs` in all three trees is now ≥ 7.6.4. |
| `fast-xml-parser` | `server` → `@langchain/anthropic` → `fast-xml-parser`. Entity-encoding bypass. | Resolution `fast-xml-parser@^4.5.4`. |

The `protobufjs` 6 → 7 jump crosses a major version, so it was verified rather
than assumed: the native embedder, which loads `onnxruntime-web` at import
time, was run end to end and returned a correct 384-dimension vector, and the
full document pipeline (upload → parse → embed → retrieve) passed afterwards.

### 1.2 Highs fixed in this pass

Applied only where the fix stays inside the installed major version, or where
the upgrade was verified by running the affected code path:

`server`: `@grpc/grpc-js`, `@modelcontextprotocol/sdk` (1.24.3 → 1.30.0),
`adm-zip`, `axios`, `fast-uri`, `form-data`, `js-yaml`, `lodash`, `lodash-es`,
`minimatch`, `multer` (2.0.0 → 2.3.0), `mysql2`, `nanoid`, `path-to-regexp`,
`sharp` (0.32.6 → 0.35.4), `tar-fs`, `tmp`, `undici`, `ws`, `jws`.

`collector`: `@xmldom/xmldom`, `adm-zip`, `form-data`, `ip-address`, `js-yaml`,
`linkify-it`, `lodash`, `nodemailer` (7.0.10 → 7.0.13), `path-to-regexp`,
`sharp` (0.32.6/0.33.5 → 0.35.4), `tar-fs`, `underscore`, `ws`.

`frontend`: `markdown-it` (13.0.2 → 14.3.2, which carries the patched
`linkify-it`), `@remix-run/router`, `lodash`. The frontend now reports **zero
high and zero critical** production advisories.

Upgrades that would have required a breaking migration were **not** forced.
Specifically, the LangChain stack was left on its current line rather than
being pushed from 0.1/0.2 to 0.3, and `pdfjs-dist` was avoided entirely by
choosing `officeparser@5.1.1` over `5.2.x`.

After every change: 1433 of 1436 unit tests pass (the 3 failures are the
pre-existing ffmpeg-binary tests, see `FINAL_ACCEPTANCE.md`), the frontend
production build succeeds, and the disposable acceptance run reports 65/65
acceptance and 25/25 document-pipeline checks.

### 1.3 Remaining highs, with chain and reachability

No remaining item has a fix that does not require a breaking upgrade.

| Package | Chain | In image | Reachable from user input | Mitigation / why it is accepted |
| --- | --- | --- | --- | --- |
| `@langchain/core` 0.1.61 / 0.1.63 / 0.2.36 | `langchain`, `@langchain/community`, `@langchain/anthropic` | Yes | **No** | The advisory needs LangChain serialized objects to be deserialized from an untrusted source. This codebase never calls `langchain/load`, never pulls remote prompt manifests, and constructs its chains in code. Fixing requires the 0.1/0.2 → 0.3 migration of the whole LangChain stack, which is a separate, tested piece of work. |
| `langchain` 0.1.36 / 0.2.20 | direct | Yes | **No** | Same advisory and same reasoning. |
| `langsmith` 0.1.21 / 0.1.68 | via `@langchain/core` | Yes | **No** | Triggered by pulling a public prompt from the LangSmith hub. No LangSmith tracing or hub pull is configured or called; `LANGCHAIN_TRACING` / `LANGSMITH_*` are never set. |
| `expr-eval` 2.0.2 (no patch) | `@langchain/community` → `expr-eval` | Yes | **No** | Used only by LangChain's calculator tool, which this product never imports or exposes. |
| `brace-expansion` 1.1.11 | `exceljs` / `swagger-autogen` → `glob` → `minimatch` → `brace-expansion` | Yes | **No** | ReDoS on brace patterns. The only patterns reaching it are literal glob strings inside those libraries. Yarn 1 resolutions cannot address the 1.x line here without also forcing `minimatch@5`'s 2.x dependency down a major version, which would break it. |
| `image-size` 1.2.1 (no patch) | `pptxgenjs` → `image-size` | Yes | **Owner only** | Denial of service via a malformed ICNS/JXL/HEIF image. The only image the presentation plugin embeds is the deployment's own logo, uploaded by the owner. Not reachable by staff, customers or website visitors. |
| `ip` 2.0.1 (no patch) | direct | Yes | **No** | The advisory is in `isPublic()`. This codebase calls `ip.address()` only, to build the local pairing URL in `server/models/mobileDevice.js`. The platform's own SSRF defence does not use this package. |
| `extract-zip` 2.0.1 (no patch) | `puppeteer` → `@puppeteer/browsers` → `extract-zip` | Yes | **No** | Only runs when Puppeteer downloads a browser archive. The image sets `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true` and points `PUPPETEER_EXECUTABLE_PATH` at the Chromium already installed in the image, so the download path never executes at runtime. |
| `nodemailer` 7.0.13 | `mbox-parser` → `mailparser` → `nodemailer` | Yes | **Yes — authenticated staff** | Quadratic-time address parsing. Reached by uploading a crafted `.mbox` file. Upload requires an authenticated account with knowledge permissions; the impact is a slow parse in the collector, not data disclosure. The fix is `nodemailer@9`, a two-major upgrade of a transitive dependency of `mbox-parser`, which pins `7.x`. Accepted and tracked. |
| `undici` 5.29.0 | `youtubei.js` → `undici` | Yes | **Yes — authenticated staff** | WebSocket advisories (unbounded memory, unhandled exception). `youtubei.js` is used for the YouTube transcript connector and uses `undici`'s `fetch`, not its WebSocket client. Requires `undici@6`, which `youtubei.js@9` does not accept. Accepted and tracked. |
| `sharp` (libvips / libheif CVEs) | `@xenova/transformers` → `sharp`, and direct in `collector` | Yes | Image parsing | Already upgraded to `0.35.4`, the patched release. Residual libvips advisories track the bundled native library; there is no newer `sharp` to move to. |

---

## 2. Committed secrets

`scripts/secret-scan.cjs` scans tracked files and every commit reachable from
any ref. It reports the file and line of a match and **never prints, logs or
stores the matched value** — a scanner that echoes secrets simply relocates the
leak.

```
node scripts/secret-scan.cjs --history
```

Result of this pass:

```
Scanned 1393 of 5765 tracked files (binary, vendored and example files skipped).
WORKING TREE: 0 finding(s)
Scanned 61 commit(s).
HISTORY: 0 finding(s)
```

The scanner was verified against a planted Stripe live-key-shaped value and a
planted 64-character hex `JWT_SECRET`; it found both and reported only their
locations. The eight initial matches were all upstream documentation
placeholders and runtime template literals (`postgresql://username:password@…`,
`sk-myApiKeyToAccess…`); the scanner now discards matches whose own text
identifies them as examples.

No history rewrite was needed, and none was performed.

### Repository hygiene

Confirmed excluded from Git (`git check-ignore`):

- `server/.env`, `server/.env.production`, `docker/.env`, `frontend/.env`,
  `collector/.env`
- `deployments/` — every generated customer `.env`, reverse-proxy config and
  per-customer backup
- `backups/` and any backup archive
- `server/storage/` — the customer database, uploaded and parsed documents,
  vector data and the `comkey` signing material
- `test-results/` — acceptance run output
- `scripts/fixtures/` — generated test fixtures
- `.stripe/`, `stripe-cli-*`, `*.stripe-events.json` — Stripe CLI artefacts

Nothing matching `.env`, a storage path, a `.pem` or a `.key` is currently
tracked.

---

## 3. Platform security controls

Re-run in this pass — `server/__tests__/business/security.test.js`, 97 tests,
all passing:

| Control | What is asserted |
| --- | --- |
| Outbound webhook SSRF | Loopback, RFC1918, link-local, CGNAT, cloud metadata and IPv4-mapped-IPv6 destinations are refused; redirects are never followed |
| Audit log redaction | Credential-bearing keys are redacted with exact-match and substring rules before anything is written |
| CSV export injection | Leading `=`, `+`, `-`, `@`, tab and CR are neutralised so an export cannot execute in a spreadsheet |
| Production authentication | A production deployment not in multi-user mode refuses every non-bootstrap route |
| Authenticated-mode guard cache | Only a positive result is cached, so enabling multi-user mode takes effect immediately |
| Boot posture | Missing or weak `DEPLOYMENT_ID`, `JWT_SECRET`, `SIG_KEY`, `SIG_SALT` stop the boot; `PLAN_AMOUNT_CENTS` is validated |
| Business role mapping | Owner, administrator, manager, member and viewer map to the correct permission set |
| Public rate limiting | Per-minute limit and burst are enforced on public agent endpoints |

The full business suite (8 files, 341 tests) passes, including the Stripe
deployment-binding tests and the value-record tests.

---

## 4. What this audit does not cover

- No penetration test was performed.
- No runtime scan of a built container image was performed; the
  production-dependency claim above rests on reading the Dockerfile's build
  stages, not on inspecting a built image.
- Advisory data is as published by the npm registry on the date above. Re-run
  `yarn audit --groups dependencies` per workspace before each release.
