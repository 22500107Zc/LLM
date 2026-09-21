#!/usr/bin/env node
/**
 * Desktop and mobile visual check of the customer-facing pages.
 *
 * Loads each page in a real browser at both widths, screenshots it, and
 * asserts three things that a build passing cannot tell you:
 *
 *   1. the page rendered something (not a blank screen or a crash overlay)
 *   2. it does not scroll sideways at phone width
 *   3. no upstream product name appears anywhere in the rendered DOM
 *
 * Usage:
 *   BASE_URL=http://localhost:3001 \
 *   SEED_USERNAME=owner SEED_PASSWORD=... \
 *   OUT_DIR=test-results/<stamp>/screenshots \
 *   node scripts/visual-check.cjs
 */

const path = require("path");
const fs = require("fs");

const REPO_ROOT = path.resolve(__dirname, "..");
const BASE_URL = (process.env.BASE_URL || "http://localhost:3001").replace(/\/$/, "");
const USERNAME = process.env.SEED_USERNAME || "";
const PASSWORD = process.env.SEED_PASSWORD || "";
const OUT_DIR = process.env.OUT_DIR || path.join(REPO_ROOT, "test-results", "screenshots");
const CHROMIUM = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";

const PAGES = [
  ["Dashboard", "/dashboard"],
  ["Agents", "/agents"],
  ["Knowledge", "/knowledge"],
  ["Conversations", "/conversations"],
  ["Value", "/value"],
  ["Team", "/team"],
  ["Integrations", "/integrations"],
  ["Audit log", "/audit-log"],
  ["Billing", "/settings/billing"],
];

// The application picks its mobile layout from the user agent (react-device-
// detect), not from the viewport width, so the mobile pass must send a real
// phone user agent. Emulating only the viewport tests something no customer
// ever sees.
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const VIEWPORTS = [
  {
    name: "desktop",
    width: 1440,
    height: 900,
    isMobile: false,
    deviceScaleFactor: 1,
    userAgent: null,
  },
  {
    name: "mobile",
    width: 390,
    height: 844,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    userAgent: MOBILE_UA,
  },
];

/** Upstream names that must not survive into a rendered page. */
const FORBIDDEN = [/AnythingLLM/i, /Mintplex/i, /anythingllm\.com/i];

const results = [];
const record = (name, passed, detail = "") => {
  results.push({ name, passed, detail });
  const tag = passed ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`${tag}  ${name}${detail ? `  — ${detail}` : ""}`);
};

async function login() {
  const response = await fetch(`${BASE_URL}/api/request-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  const body = await response.json().catch(() => ({}));
  if (!body?.token) throw new Error(`Could not sign in as ${USERNAME}: ${body?.message ?? response.status}`);
  return { token: body.token, user: body.user };
}

(async () => {
  if (!USERNAME || !PASSWORD) {
    console.log("BLOCKED: SEED_USERNAME and SEED_PASSWORD are required.");
    process.exit(2);
  }
  if (!fs.existsSync(CHROMIUM)) {
    console.log(`BLOCKED: no Chromium at ${CHROMIUM}.`);
    process.exit(2);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const puppeteer = require(path.join(REPO_ROOT, "collector", "node_modules", "puppeteer"));

  const { token, user } = await login();
  record("Signed in for the visual check", !!token, user?.username ?? "");

  const browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    for (const viewport of VIEWPORTS) {
      for (const [label, route] of PAGES) {
        const page = await browser.newPage();
        const { name: _n, userAgent, ...metrics } = viewport;
        await page.setViewport(metrics);
        if (userAgent) await page.setUserAgent(userAgent);
        try {
          // Seed the session before the app boots, so it never bounces to login.
          await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
          await page.evaluate(
            (t, u) => {
              localStorage.setItem("anythingllm_authToken", t);
              localStorage.setItem("anythingllm_user", JSON.stringify(u));
            },
            token,
            user
          );

          await page.goto(`${BASE_URL}${route}`, { waitUntil: "networkidle2", timeout: 60000 });
          await new Promise((r) => setTimeout(r, 1500));

          const file = path.join(OUT_DIR, `${viewport.name}-${route.replace(/\W+/g, "") || "root"}.png`);
          await page.screenshot({ path: file, fullPage: false });

          const probe = await page.evaluate(() => ({
            text: document.body.innerText || "",
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
            nodes: document.querySelectorAll("*").length,
          }));

          record(
            `${viewport.name} · ${label} renders`,
            probe.nodes > 50 && probe.text.trim().length > 0,
            `${probe.nodes} nodes`
          );

          if (viewport.isMobile) {
            record(
              `${viewport.name} · ${label} has no sideways scroll`,
              probe.scrollWidth <= probe.clientWidth + 2,
              `${probe.scrollWidth}px in ${probe.clientWidth}px`
            );
          }

          const hit = FORBIDDEN.find((re) => re.test(probe.text));
          record(
            `${viewport.name} · ${label} shows no upstream branding`,
            !hit,
            hit ? `matched ${hit}` : ""
          );
        } catch (error) {
          record(`${viewport.name} · ${label}`, false, error.message);
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.passed);
  console.log(
    `\n==================================================================\n` +
      `VISUAL CHECK: ${results.length - failed.length}/${results.length} passed\n` +
      `Screenshots: ${OUT_DIR}\n` +
      `==================================================================`
  );
  if (failed.length) {
    console.log("FAILED:");
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
  }
  process.exit(failed.length ? 1 : 0);
})().catch((error) => {
  console.error("Visual check could not run:", error.message);
  process.exit(3);
});
