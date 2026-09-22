# Deploying this application to Vercel

**Deployed.** One Vercel project, building from this branch, serving the
application. It needs one more value to be usable — a Postgres `DATABASE_URL`
— and refuses to pretend otherwise until it has one.

| | |
| --- | --- |
| Project | `business-ai-operations-platform` (`prj_dfX3B70SA8MH0fn2dSzbszqsOlTp`) |
| Team | `22500107zcs-projects` |
| URL | https://business-ai-operations-platform-22500107zcs-projects.vercel.app |
| Source | `22500107Zc/LLM`, branch `claude/commercial-b2b-ai-platform-0skp39` |

## 1. What is verified live

```
/                 200   "Business AI Operations Platform"
/founder          200   (SPA route)
/login            200   (SPA route)
/assets/*.js      200
/api/*            500   {"error":"misconfigured","message":"DATABASE_URL is not set…"}
```

The 500 is correct and deliberate. The serverless function boots, loads the
whole application and answers — then refuses every API call because it has
nowhere durable to keep customer accounts. A founder would otherwise create a
customer, watch it succeed, and find it gone after the next cold start.

Neither the served HTML nor the JavaScript bundle contains the founder
password hash. Checked on the live deployment, not locally.

## 1a. The one remaining step

Add a Postgres connection string as `DATABASE_URL` in the project's
environment variables and redeploy. Any Postgres works — Neon, Supabase and
Vercel's own marketplace all have a free tier. The build creates the schema
automatically (`prisma db push`); nothing else is needed.

Then: open `/founder`, sign in, create a customer, and they can sign in at `/`.

## 1b. Four real problems the deployment surfaced

Each of these failed a build and was fixed, not worked around:

1. **`npm install` refused the dependency tree.** `@langchain/community` wants
   `@datastax/astra-db-ts ^1.0.0`; the tree pins `^0.1.3`. This repository
   installs with yarn, which tolerates it. `--legacy-peer-deps` matches that.
2. **A postinstall downloaded a binary the API never loads** (`@vscode/ripgrep`).
   `--ignore-scripts`, with the Prisma client generated explicitly instead.
3. **`vite: command not found`.** Vercel sets `NODE_ENV=production`, so npm
   skipped devDependencies — and vite is one.
4. **Rollup could not resolve `regenerator-runtime`**, imported directly by the
   speech-to-text component. npm's tree did not hoist it; yarn's does. The
   frontend now builds with `yarn --frozen-lockfile` against its committed
   lockfile.

There was also a bug in my own provider switcher: its first version matched the
commented-out Postgres block in the schema and rewrote the documentation
instead of the configuration. It looked like it worked and changed nothing.

## 2. What actually blocks a serverless deployment

### 2.1 The production dependency tree is 669 MB

Resolved by walking `server/package.json` `dependencies` transitively through
the installed tree — 674 packages:

```
production packages resolved: 674
total                        669 MB
```

A Vercel Node function is limited to roughly **250 MB unzipped**. The largest
contributors are the AI runtime, not the application:

| Package | Size | What it is |
| --- | --- | --- |
| `onnxruntime-web` | 67 MB | ONNX inference runtime |
| `chromadb-default-embed` | 45 MB | bundled embedding model |
| `@xenova/transformers` | 45 MB | native in-process embeddings |
| `@prisma/engines` | 38 MB | query engine binaries |
| `prisma` | 29 MB | CLI |
| `chromadb` | 26 MB | vector client |
| `@lancedb/lancedb` | 178 MB | native Rust vector database |
| `onnxruntime-node` | 93 MB | native ONNX bindings |

Removing the six AI-native packages (`@lancedb`, `onnxruntime-node`,
`onnxruntime-web`, `@xenova`, `chromadb`, `chromadb-default-embed`) saves
**449 MB** and leaves **218 MB** — under the limit, but with roughly 30 MB of
headroom, which is not much.

### 2.2 Three things persist to local disk

Size is the loud problem; this is the fundamental one. A serverless function
gets a read-only filesystem plus an ephemeral `/tmp`, and a fresh instance each
time it scales.

| What | Where it writes | Consequence on Vercel |
| --- | --- | --- |
| SQLite (Prisma) | `server/storage/anythingllm.db` | every account, workspace and chat vanishes on the next cold start |
| LanceDB | `server/storage/lancedb` (`utils/vectorDbProviders/lance/index.js:25`) | embedded documents vanish; retrieval returns nothing |
| Native embeddings | model files cached to disk by `@xenova/transformers` | re-downloaded per instance, or fails |
| Uploaded documents | `STORAGE_DIR/documents` (`utils/files/index.js:10`) | uploads vanish |

None of these is a configuration problem. They are architectural: the code
assumes a filesystem that stays.

### 2.3 The collector is a second long-running service

`collector/` is a separate Node service the server calls on port 8888
(`utils/collectorApi/index.js:22`). Document upload and parsing goes through
it. It has no serverless entry point and would need to be hosted separately.

### 2.4 WebSocket agents — no longer a blocker

`server/endpoints/agentWebsocket.js:26` opens `app.ws("/agent-invocation/:uuid")`
via `@mintplex-labs/express-ws`. Vercel now supports WebSockets, so this is
adaptable rather than fatal, but it is not free: it would need porting to
Vercel's own upgrade mechanism.

---

## 3. What a Vercel migration would actually require

In dependency order:

1. **Postgres instead of SQLite.** Prisma's schema already carries a
   commented-out `postgresql` datasource. The provider cannot be chosen by an
   environment variable in Prisma 5.3, so this means a second schema file or a
   build step, plus regenerating the migration history for Postgres.
2. **A hosted vector database instead of LanceDB.** The product already
   supports Pinecone, Qdrant, Weaviate, Milvus and Astra over HTTP. Choosing
   one and **removing `@lancedb/lancedb` from `dependencies`** is what actually
   reclaims the 178 MB — setting `VECTOR_DB` alone does not, because the
   package still ships.
3. **Provider embeddings instead of native.** Same reasoning: setting
   `EMBEDDING_ENGINE=openai` stops ONNX running, but `@xenova/transformers` and
   `onnxruntime-node` still ship. They have to come out of `dependencies`.
4. **Blob storage for uploaded documents**, e.g. Vercel Blob.
5. **Host the collector somewhere with a filesystem**, or accept that document
   upload does not work.
6. **Port the agent WebSocket** to Vercel's upgrade API.

Steps 2 and 3 are the ones that are not just packaging. They remove
self-hosted, no-external-dependency operation from the product: today a
customer can run this with nothing but an LLM key, and afterwards they could
not. That is a product decision.

---

## 4. The choice

**Option A — make it fit Vercel.** Do all six steps above. One Vercel project,
one URL, and the founder/customer model already built works there unchanged.
Cost: the product permanently requires a hosted vector database and a hosted
embedding provider, and document upload needs the collector hosted elsewhere.

**Option B — host it where it keeps a filesystem.** One container on Fly.io,
Railway, Render or a plain VPS. One application, one URL, one project — every
product requirement is satisfied except the specific word "Vercel". Nothing is
removed, the collector runs beside the server as it already does, and the
existing Docker image is the deployment artifact.

The founder-controlled account model this repository now implements is
**identical either way**. It does not depend on where the application runs.

---

## 5. What is already done, whichever is chosen

- One application, one set of accounts. No per-customer deployment.
- Founder login, founder-created customer accounts, founder-controlled
  ACTIVE/DISABLED access.
- No public signup.
- Stripe entirely outside the authorization path; no API key, no webhook.
- Disabling a customer ends their live session on the next request.

None of that needs to change to deploy anywhere.
