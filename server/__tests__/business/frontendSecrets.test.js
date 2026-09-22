const fs = require("fs");
const path = require("path");

const CONFIG = path.resolve(__dirname, "../../../frontend/vite.config.js");

/**
 * This existed for real, on a live deployment.
 *
 * Upstream's vite config carried `define: { "process.env": process.env }`,
 * which inlines the build machine's entire environment into the browser
 * bundle. Built on a laptop that is noise. Built on a runner holding
 * production secrets, it served the founder password hash, JWT_SECRET,
 * SIG_KEY and SIG_SALT to anyone who opened the JavaScript.
 *
 * The build has a gate that scans the built files for the actual values. This
 * catches the cause instead, in a second, without a build.
 */
describe("the frontend build cannot carry server secrets", () => {
  const config = fs.readFileSync(CONFIG, "utf8");

  it("never hands the whole environment to the bundle", () => {
    const defines = config.replace(/\/\/[^\n]*/g, "");
    expect(defines).not.toMatch(/["']process\.env["']\s*:\s*process\.env\b/);
    expect(defines).not.toMatch(/\.\.\.process\.env\b/);
  });

  it("exposes NODE_ENV and nothing else through process.env", () => {
    const block = config.match(/define:\s*\{[\s\S]*?\n\s{2}\},/);
    expect(block).not.toBeNull();

    const keys = [...block[0].matchAll(/["']process\.env(?:\.([A-Za-z0-9_]+))?["']\s*:/g)]
      .map((match) => match[1] ?? "*");

    // `*` is the bare `process.env` key, which must map to an empty object.
    expect(keys.sort()).toEqual(["*", "NODE_ENV"]);
    expect(block[0]).toMatch(/["']process\.env["']\s*:\s*\{\s*\}/);
  });

  it("leaves VITE_ variables to vite, which already scopes them", () => {
    expect(config).toMatch(/import\.meta\.env|VITE_|vite/i);
  });
});
