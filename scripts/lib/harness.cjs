/**
 * Shared harness for the repository's live-server test scripts.
 *
 * Three jobs:
 *   1. Resolve every path from this file's own location, so a script works
 *      from any clone on any machine.
 *   2. Make a mutating test suite safe to run: unique credentials per run,
 *      a cleanup registry, and a refusal to touch anything that looks like a
 *      customer deployment unless the operator explicitly overrides it.
 *   3. Give the scripts one consistent result format and exit contract.
 */

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// scripts/lib/harness.cjs -> repository root
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SERVER_DIR = path.join(REPO_ROOT, "server");
const COLLECTOR_DIR = path.join(REPO_ROOT, "collector");

/** Requires a module from the server workspace by its repo-relative path. */
function serverRequire(relativePath) {
  return require(path.join(SERVER_DIR, relativePath));
}

// ------------------------------------------------------------- safety ------
/**
 * Hosts a mutating suite may touch without an override. Anything else is
 * assumed to be somebody's real deployment.
 */
const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "host.docker.internal",
]);

/**
 * These suites create users, agents, leads and API keys. Running one against a
 * customer's deployment would pollute their data, so a non-local target is
 * refused unless ALLOW_REMOTE_ACCEPTANCE=1 is set deliberately.
 */
function assertSafeTarget(baseUrl, { suiteName = "This suite" } = {}) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    fail(`BASE_URL is not a valid URL: ${baseUrl}`);
  }

  const host = url.hostname.toLowerCase();
  const isLocal = LOCAL_HOSTS.has(host) || host.endsWith(".localhost");
  if (isLocal) return url;

  if (process.env.ALLOW_REMOTE_ACCEPTANCE !== "1") {
    fail(
      [
        `Refusing to run against ${url.origin}.`,
        "",
        `${suiteName} CREATES AND DELETES DATA: users, agents, website agents,`,
        "leads, escalations, quality tests and API keys. It is meant for a",
        "disposable test deployment, not a customer's live system.",
        "",
        "Run it against a disposable environment instead:",
        "  ./scripts/run-disposable-acceptance.sh",
        "",
        "If you genuinely intend to mutate this deployment, re-run with:",
        "  ALLOW_REMOTE_ACCEPTANCE=1",
      ].join("\n")
    );
  }

  console.log(
    [
      "",
      "\x1b[41m\x1b[97m  DESTRUCTIVE TEST WARNING  \x1b[0m",
      `\x1b[31mRunning a data-mutating suite against a REMOTE target: ${url.origin}\x1b[0m`,
      "\x1b[31mThis creates users, agents, leads and API keys on that deployment.\x1b[0m",
      "\x1b[31mIt is not intended for a customer's live system.\x1b[0m",
      "",
    ].join("\n")
  );
  return url;
}

function fail(message) {
  console.error(`\n\x1b[31m${message}\x1b[0m\n`);
  process.exit(2);
}

// ------------------------------------------------------- run identity ------
/**
 * A short, unique tag for this run. Every record the suite creates carries it,
 * so fixtures never collide across runs and cleanup can find its own work.
 */
function runId() {
  return `t${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
}

/**
 * Generates a strong throwaway password. Never committed, never reused, and
 * only ever used against a disposable deployment.
 */
function ephemeralPassword() {
  // Mixed classes so it satisfies any password policy the deployment applies.
  return `Tt1!${crypto.randomBytes(18).toString("base64url")}`;
}

// ------------------------------------------------------------ results ------
class Results {
  constructor(title) {
    this.title = title;
    this.entries = [];
  }

  record(name, passed, detail = "") {
    this.entries.push({ name, passed: !!passed, detail, blocked: false });
    const mark = passed ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
    console.log(`${mark}  ${name}${detail ? `  — ${detail}` : ""}`);
  }

  /** A check that could not run for want of an external credential. */
  blocked(name, reason) {
    this.entries.push({ name, passed: false, detail: reason, blocked: true });
    console.log(`\x1b[33mBLOCK\x1b[0m ${name}  — ${reason}`);
  }

  section(name) {
    console.log(`\n\x1b[1m=== ${name} ===\x1b[0m`);
  }

  /**
   * Prints the summary and exits.
   * Blocked checks do not count as failures; they are reported separately so a
   * missing credential is never mistaken for a pass.
   */
  finish() {
    const passed = this.entries.filter((e) => e.passed).length;
    const blocked = this.entries.filter((e) => e.blocked);
    const failed = this.entries.filter((e) => !e.passed && !e.blocked);
    const runnable = this.entries.length - blocked.length;

    console.log("\n" + "=".repeat(66));
    console.log(`${this.title}: ${passed}/${runnable} passed`);
    if (blocked.length) console.log(`${blocked.length} BLOCKED (external credential required)`);
    if (failed.length) {
      console.log("\nFAILURES:");
      failed.forEach((f) => console.log(`  x ${f.name}${f.detail ? ` — ${f.detail}` : ""}`));
    }
    if (blocked.length) {
      console.log("\nBLOCKED:");
      blocked.forEach((b) => console.log(`  - ${b.name} — ${b.detail}`));
    }
    console.log("=".repeat(66));
    process.exit(failed.length ? 1 : 0);
  }
}

// ------------------------------------------------------------ cleanup ------
/**
 * Records undo actions and runs them in reverse, so a suite leaves the
 * deployment as it found it even when an assertion fails part way through.
 */
class Cleanup {
  constructor() {
    this.actions = [];
    this.registered = false;
  }

  add(label, fn) {
    this.actions.push({ label, fn });
    if (!this.registered) {
      this.registered = true;
      const run = () => this.run();
      process.on("exit", () => {});
      process.on("SIGINT", async () => {
        await run();
        process.exit(130);
      });
    }
  }

  async run({ quiet = false } = {}) {
    if (!this.actions.length) return;
    if (!quiet) console.log("\n\x1b[2m--- cleaning up test fixtures ---\x1b[0m");
    for (const { label, fn } of this.actions.reverse()) {
      try {
        await fn();
        if (!quiet) console.log(`\x1b[2m  removed ${label}\x1b[0m`);
      } catch (error) {
        console.log(`\x1b[33m  could not remove ${label}: ${error.message}\x1b[0m`);
      }
    }
    this.actions = [];
  }
}

// ----------------------------------------------------------- http ----------
/** Builds an API client bound to one base URL and bearer token. */
function apiClient(baseUrl) {
  const base = `${String(baseUrl).replace(/\/$/, "")}/api`;
  let token = null;

  async function call(pathname, options = {}) {
    const response = await fetch(`${base}${pathname}`, {
      method: options.method ?? "GET",
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.token !== undefined
          ? options.token
            ? { Authorization: `Bearer ${options.token}` }
            : {}
          : token
            ? { Authorization: `Bearer ${token}` }
            : {}),
        ...(options.headers ?? {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    let json = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { status: response.status, json, ok: response.ok };
  }

  return {
    base,
    call,
    setToken: (value) => {
      token = value;
    },
    getToken: () => token,
    raw: (pathname, init) => fetch(`${base}${pathname}`, init),
  };
}

/** Waits for a server to answer /api/ping, or gives up. */
async function waitForServer(baseUrl, { timeoutMs = 120_000, label = "server" } = {}) {
  const deadline = Date.now() + timeoutMs;
  const url = `${String(baseUrl).replace(/\/$/, "")}/api/ping`;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  console.error(`\x1b[31mTimed out waiting for the ${label} at ${baseUrl}\x1b[0m`);
  return false;
}

module.exports = {
  REPO_ROOT,
  SERVER_DIR,
  COLLECTOR_DIR,
  serverRequire,
  assertSafeTarget,
  fail,
  runId,
  ephemeralPassword,
  Results,
  Cleanup,
  apiClient,
  waitForServer,
  fs,
  path,
};
