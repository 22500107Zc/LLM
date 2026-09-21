/**
 * Regression guard for a production-breaking upstream behaviour.
 *
 * `dumpENV()` in utils/helpers/updateENV.js rewrites server/.env from scratch,
 * keeping ONLY the keys in its `protectedKeys` allowlist. It runs whenever an
 * administrator saves a setting in production. Any commercial key missing from
 * that list is silently deleted - which would take Stripe billing, branding
 * and the operational limits down on a live customer deployment.
 *
 * This test fails if a new commercial environment variable is introduced in
 * business/config.js without being added to the allowlist.
 */

const fs = require("fs");
const path = require("path");

const UPDATE_ENV = path.join(__dirname, "../../utils/helpers/updateENV.js");
const CONFIG = path.join(__dirname, "../../business/config.js");

function protectedKeysBlock() {
  const source = fs.readFileSync(UPDATE_ENV, "utf8");
  const start = source.indexOf("const protectedKeys = [");
  const end = source.indexOf("// Simple sanitization", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** Every env var business/config.js reads, scraped from its helper calls. */
function commercialEnvKeys() {
  const source = fs.readFileSync(CONFIG, "utf8");
  const keys = [...source.matchAll(/(?:str|bool|int|color)\(\s*"([A-Z0-9_]+)"/g)].map(
    (match) => match[1]
  );
  // NODE_ENV is set by the runtime, not persisted in .env.
  return [...new Set(keys)].filter((key) => key !== "NODE_ENV");
}

describe("commercial environment variables survive dumpENV()", () => {
  const block = protectedKeysBlock();
  const keys = commercialEnvKeys();

  it("scrapes a meaningful number of keys from the config module", () => {
    // Guards the scraper itself: if config.js is refactored so the regex stops
    // matching, this test would otherwise pass vacuously.
    expect(keys.length).toBeGreaterThan(30);
  });

  it.each(keys)("protects %s", (key) => {
    expect(block).toContain(`"${key}"`);
  });

  it.each([
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICE_ID",
    "STRIPE_CUSTOMER_ID",
    "STRIPE_SUBSCRIPTION_ID",
    "BILLING_ENFORCEMENT_ENABLED",
    "BILLING_GRACE_PERIOD_DAYS",
  ])("explicitly protects the billing-critical key %s", (key) => {
    expect(block).toContain(`"${key}"`);
  });

  it("still protects the upstream keys it shipped with", () => {
    for (const key of ["JWT_EXPIRY", "SIG_KEY", "SIG_SALT", "STORAGE_DIR"])
      expect(block).toContain(`"${key}"`);
  });
});
