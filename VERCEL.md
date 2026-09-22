# Deploying this application to Vercel

**Deployed.** One Vercel project, building from this branch, serving the
application. It needs two values to be a product a customer can pay for, and
refuses to pretend otherwise until it has them.

| | |
| --- | --- |
| Project | `business-ai-operations-platform` (`prj_dfX3B70SA8MH0fn2dSzbszqsOlTp`) |
| Team | `22500107zcs-projects` |
| URL | https://business-ai-operations-platform-22500107zcs-projects.vercel.app |
| Source | `22500107Zc/LLM`, branch `claude/commercial-b2b-ai-platform-0skp39` |

## 1. The two values it still needs

Both go in the project's environment variables. Nothing else is required, and
no code change is involved.

| Variable | What to put there |
| --- | --- |
| `DATABASE_URL` | A Postgres connection string. Neon, Supabase and Vercel's own marketplace all have a free tier. The build creates the schema itself with `prisma db push`. |
| `OPEN_AI_KEY` | A model provider key. Any provider the product supports works; the variable name changes with it (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, and so on, with `LLM_PROVIDER` set to match). |

Then redeploy. Open `/founder`, sign in, create a customer, and they can sign
in at `/` and start a conversation.

Retrieval needs nothing further: `VECTOR_DB` defaults to `pgvector` on this
runtime and reuses the same `DATABASE_URL`, so there is no second database to
buy. If that Postgres has no `vector` extension, conversation still works and
retrieval over uploaded documents simply reports nothing — which is accurate,
because document upload is unavailable here anyway (see §3).

## 1a. What is verified live

```
/                 200   "Business AI Operations Platform"
/founder          200   (SPA route)
/login            200   (SPA route)
/assets/*.js      200
/api/*            503   {"error":"unavailable","message":"The service is not available right now…"}
/api/founder/*    503   {"error":"misconfigured","message":"DATABASE_URL is not set…"}
```

The 503 is correct and deliberate. The serverless function boots, loads the
whole application and answers — then refuses every API call because it has
nowhere durable to keep customer accounts. A founder would otherwise create a
customer, watch it succeed, and find it gone after the next cold start.

The two bodies differ on purpose. The founder is the person who can fix this
and is told exactly what is missing; anyone else gets a service message,
because which environment variable is unset is not theirs to read.

Neither the served HTML nor the JavaScript bundle contains the founder
password hash. Checked on the live deployment, not locally.

## 1b. What the whole commercial loop is proved against

`scripts/production-loop-verification.cjs` drives **this file** — `api/index.js`,
the real Vercel entry point — over a real socket against a real Postgres, with
every `STRIPE_*` variable deleted from the process:

```
COMMERCIAL LOOP: 88 passed, 0 failed, 1 blocked
```

The one blocked item is a model provider key, which this machine does not
have. It is reported as blocked, never as passed.

## 1c. Seven real problems the deployment surfaced

Each of these failed for real and was fixed, not worked around:

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
5. **A `default`-role customer could not create a workspace**, so they would
   have signed in to an empty product with no way to fix it. Creating the
   account now provisions their first workspace. (They are deliberately not
   admins: an admin sees every other customer's workspaces.)
6. **Every customer message would have hung.** The default chat mode is
   `automatic`, and with a tool-calling model that routes every message into
   the agent flow — which answers with a websocket address. There are no
   websockets here, so the browser would have waited forever with no error.
   `api/index.js` now turns agent chat off on this runtime and says so.

7. **The frontend bundle contained the server's secrets.** Upstream's vite
   config carried `define: { "process.env": process.env }`, which inlines the
   build machine's entire environment. On this runner that put
   `FOUNDER_PASSWORD_HASH`, `JWT_SECRET`, `SIG_KEY` and `SIG_SALT` into
   `dist/index.js`, downloadable by anyone. Found by scanning the deployed
   bundle — the repository was clean throughout, which is why a source-only
   scan never saw it. The config now exposes `NODE_ENV` only, the build fails
   if any secret value appears in a built file, and the three machine-generated
   secrets were rotated. The founder password hash still needs replacing; see
   PROGRESS.md "Next action".

There was also a bug in my own provider switcher: its first version matched the
commented-out Postgres block in the schema and rewrote the documentation
instead of the configuration. It looked like it worked and changed nothing.

## 1d. What a customer sees when something breaks

Nothing from the engine room. Provider errors, missing keys and module
failures are translated by `server/business/services/customerFacing.js` into a
sentence in the customer's own language; the real error goes to the server log,
where it is useful. A test asserts that no API key text, module name, database
name or stack frame can reach a customer's screen.

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
| LanceDB | `server/storage/lancedb` (`utils/vectorDbProviders/lance/index.js:25`) | embedded documents vanish; retrieval returns nothing — **solved**, this runtime uses pgvector on the same Postgres |
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

## 3. What the migration actually took, and what it cost

In dependency order, all done:

1. **Postgres instead of SQLite.** The provider cannot be an environment
   variable in Prisma 5.3, so `scripts/prisma-provider.cjs` rewrites the
   datasource at build time. The committed migration history is SQLite DDL and
   will not apply to Postgres, so the build uses `prisma db push`.
2. **pgvector instead of LanceDB.** The same Postgres, through the `pg`
   client — no second service and no second bill. Selected automatically by
   `selectVectorStore()` in `api/index.js`.
3. **Provider embeddings instead of native.** `@xenova/transformers` and
   `onnxruntime-node` are out of the function bundle. The native embedder's
   import is lazy, so the module still loads; it simply never runs here.
4. **Agent chat turned off on this runtime**, because a websocket address that
   cannot be connected to is worse than an honest refusal.
5. **Document upload answers 503 with a plain sentence**, because the collector
   is a second long-running service and there is nothing here to run it.

What that cost the product: on Vercel it requires a hosted Postgres and a model
provider, and document upload does not work. Self-hosted — the Docker image in
this repository — none of that applies: SQLite, LanceDB, native embeddings, the
collector and agents all work as they always did. Both are the same one
application and the same founder/customer model; only the runtime differs.

## 4. What is true either way

- One application, one set of accounts. No per-customer deployment.
- Founder login, founder-created customer accounts, founder-controlled
  ACTIVE/DISABLED access.
- No public signup.
- Stripe entirely outside the authorization path; no API key, no webhook.
- Disabling a customer ends their live session on the next request.
- One customer cannot see another's workspaces, enforced server-side.
