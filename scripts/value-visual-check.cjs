#!/usr/bin/env node
/**
 * Visual check of the revised Value page, with real figures in it.
 *
 * The general visual sweep only ever sees an empty Value page. This one seeds
 * records through the API first, so what is screenshotted and asserted is the
 * page a customer with data actually sees: a return multiple, the benefit that
 * produced it, the subscription cost, net value, and the breakdown.
 *
 * It checks desktop and phone, and it opens the Estimate value calculator.
 *
 * THIS SUITE WRITES DATA. Use a disposable deployment.
 *
 *   BASE_URL=http://localhost:3001 SEED_USERNAME=owner SEED_PASSWORD=... \
 *   OUT_DIR=test-results/value-screenshots \
 *     node scripts/value-visual-check.cjs
 */

const path = require("path");
const fs = require("fs");
const { assertSafeTarget, REPO_ROOT } = require("./lib/harness.cjs");

const BASE_URL = (process.env.BASE_URL || "http://localhost:3001").replace(/\/$/, "");
assertSafeTarget(BASE_URL, { suiteName: "The Value visual check" });

const USERNAME = process.env.SEED_USERNAME || "";
const PASSWORD = process.env.SEED_PASSWORD || "";
const OUT_DIR =
  process.env.OUT_DIR || path.join(REPO_ROOT, "test-results", "value-screenshots");
const CHROMIUM = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";

/** A month of its own, so this never disturbs another suite's figures. */
const PERIOD = "2026-07";

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const results = [];
const record = (name, passed, detail = "") => {
  results.push({ name, passed, detail });
  const tag = passed ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`${tag}  ${name}${detail ? `  — ${detail}` : ""}`);
};

async function api(pathname, { method = "GET", body = null, token } = {}) {
  const response = await fetch(`${BASE_URL}/api${pathname}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
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

  const login = await api("/request-token", {
    method: "POST",
    body: { username: USERNAME, password: PASSWORD },
  });
  const token = login.json?.token;
  const user = login.json?.user;
  record("Signed in", !!token);
  if (!token) process.exit(1);

  // --- seed figures that produce a known, readable result -------------------
  const summaryBefore = await api(`/business/value/summary?period=${PERIOD}`, { token });
  const feeCents = summaryBefore.json?.summary?.fee?.monthlyCents ?? 0;
  record("Deployment has a configured subscription fee", feeCents > 0, `${feeCents} cents`);

  const seeded = [];
  const seed = async (body) => {
    const created = await api("/business/value/records", {
      method: "POST",
      token,
      body: { period: PERIOD, ...body },
    });
    if (created.json?.record?.uuid) seeded.push(created.json.record.uuid);
    return created;
  };

  // 20x from gross profit, 10x from a cash saving: 30x in total.
  await seed({
    category: "closed_won_revenue",
    amountCents: feeCents * 20,
    evidenceRef: "INV-VISUAL-1",
    sourceReference: "opp-visual-1",
    description: "Closed deal attributed to the website agent",
  });
  await seed({
    category: "vendor_cost_avoided",
    amountCents: feeCents * 10,
    baselineCents: feeCents * 30,
    measuredCents: feeCents * 15,
    baselineApprovedBy: "CFO",
    evidenceRef: "VENDOR-VISUAL-1",
    sourceReference: "vendor-visual-1",
    description: "Retired helpdesk tool",
  });

  const summaryAfter = await api(`/business/value/summary?period=${PERIOD}`, { token });
  const s = summaryAfter.json?.summary ?? {};
  record("Seeded figures produce a 30x return", s.returnMultiple === 30, `${s.returnMultiple}x`);
  record("Net ROI is 2,900%", s.netRoiPercent === 2900, `${s.netRoiPercent}%`);

  // --- look at the page a customer would see -------------------------------
  const puppeteer = require(path.join(REPO_ROOT, "collector", "node_modules", "puppeteer"));
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    for (const view of [
      { name: "desktop", width: 1440, height: 900, isMobile: false, ua: null },
      { name: "mobile", width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3, ua: MOBILE_UA },
    ]) {
      const page = await browser.newPage();
      const { name, ua, ...metrics } = view;
      await page.setViewport(metrics);
      if (ua) await page.setUserAgent(ua);

      await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.evaluate(
        (t, u) => {
          localStorage.setItem("anythingllm_authToken", t);
          localStorage.setItem("anythingllm_user", JSON.stringify(u));
        },
        token,
        user
      );
      await page.goto(`${BASE_URL}/value`, { waitUntil: "networkidle2", timeout: 60000 });

      // Move the page to the seeded month.
      await page.evaluate((period) => {
        const input = document.querySelector('input[type="month"]');
        if (!input) return;
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value"
        ).set;
        setter.call(input, period);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }, PERIOD);
      await new Promise((r) => setTimeout(r, 2500));

      await page.screenshot({ path: path.join(OUT_DIR, `${name}-value.png`) });
      const text = await page.evaluate(() => document.body.innerText || "");

      record(`${name} · the return multiple is shown`, /\b30x\b/.test(text), "30x");
      record(
        `${name} · the recorded benefit is shown`,
        /Recorded benefit/i.test(text)
      );
      record(
        `${name} · the subscription cost is shown`,
        /Subscription cost/i.test(text)
      );
      record(
        `${name} · net value and net ROI are separately labelled`,
        /Net value after subscription/i.test(text) && /net ROI/i.test(text)
      );
      record(
        `${name} · the breakdown separates time valued from cash saved`,
        /Time valued/i.test(text) && /Cash costs avoided/i.test(text)
      );
      record(
        `${name} · unverified input is labelled an estimate`,
        /Estimated return/i.test(text) || /includes estimates/i.test(text)
      );
      record(
        `${name} · no qualification language anywhere on the page`,
        !/qualif|90x|100x|threshold|shortfall/i.test(text),
        (text.match(/qualif\w*|90x|100x|threshold|shortfall/i) ?? []).join(", ")
      );

      if (view.isMobile) {
        const overflow = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        record(
          `${name} · no sideways scroll`,
          overflow.scrollWidth <= overflow.clientWidth + 2,
          `${overflow.scrollWidth}px in ${overflow.clientWidth}px`
        );
      }

      // --- the Estimate value calculator ------------------------------------
      const opened = await page.evaluate(() => {
        const button = [...document.querySelectorAll("button")].find((b) =>
          /estimate value/i.test(b.textContent || "")
        );
        if (!button) return false;
        button.click();
        return true;
      });
      record(`${name} · the Estimate value calculator opens`, opened);

      if (opened) {
        await new Promise((r) => setTimeout(r, 1200));
        await page.screenshot({
          path: path.join(OUT_DIR, `${name}-value-calculator.png`),
        });
        const modal = await page.evaluate(() => document.body.innerText || "");
        record(
          `${name} · the calculator asks for savings and gross profit`,
          /cost savings/i.test(modal) && /gross profit/i.test(modal)
        );
        record(
          `${name} · the calculator names no target to work toward`,
          !/qualif|90x|100x|required|threshold/i.test(modal)
        );
      }

      await page.close();
    }
  } finally {
    await browser.close().catch(() => {});
  }

  // --- leave the deployment as it was found --------------------------------
  for (const uuid of seeded)
    await api(`/business/value/records/${uuid}`, { method: "DELETE", token });
  const after = await api(`/business/value/records?period=${PERIOD}`, { token });
  record("Seeded fixtures cleaned up", (after.json?.records ?? []).length === 0);

  const failed = results.filter((r) => !r.passed);
  console.log(
    `\n==================================================================\n` +
      `VALUE VISUAL CHECK: ${results.length - failed.length}/${results.length} passed\n` +
      `Screenshots: ${OUT_DIR}\n` +
      `==================================================================`
  );
  if (failed.length) {
    console.log("FAILED:");
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
  }
  process.exit(failed.length ? 1 : 0);
})().catch((error) => {
  console.error("The Value visual check could not run:", error.message);
  process.exit(3);
});
