#!/usr/bin/env node
/**
 * Scans the working tree and the repository's history for committed secrets.
 *
 * It reports WHERE a match is, never WHAT it is. No matched value, and no
 * fragment of one, is ever printed or written to a file - a scanner that
 * prints secrets just moves the leak somewhere else.
 *
 *   node scripts/secret-scan.cjs              # tracked files only
 *   node scripts/secret-scan.cjs --history    # tracked files + every commit
 *
 * Exit code 0 when nothing is found, 1 when something is.
 */

const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const REPO_ROOT = path.resolve(__dirname, "..");
const SCAN_HISTORY = process.argv.includes("--history");

/**
 * Each rule is deliberately anchored on a provider's own key shape rather than
 * on the word "secret", so it catches real credentials instead of variable
 * names.
 */
const RULES = [
  { name: "Stripe live secret key", re: /sk_live_[0-9a-zA-Z]{20,}/ },
  { name: "Stripe test secret key", re: /sk_test_[0-9a-zA-Z]{20,}/ },
  { name: "Stripe restricted key", re: /rk_(live|test)_[0-9a-zA-Z]{20,}/ },
  { name: "Stripe webhook signing secret", re: /whsec_[0-9a-zA-Z]{24,}/ },
  { name: "OpenAI API key", re: /sk-(proj-)?[A-Za-z0-9_-]{32,}/ },
  { name: "Anthropic API key", re: /sk-ant-[A-Za-z0-9_-]{24,}/ },
  { name: "AWS access key id", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "GitHub token", re: /\bgh[pousr]_[0-9A-Za-z]{36,}\b/ },
  { name: "Slack token", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: "SendGrid API key", re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/ },
  { name: "Private key block", re: /-----BEGIN (RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/ },
  { name: "JSON web token", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: "Connection string with password", re: /\b(postgres|postgresql|mysql|mongodb(\+srv)?):\/\/[^\s:@/]+:[^\s:@/]+@/ },
  {
    // A long hex value assigned to something that names itself a credential.
    name: "Assigned high-entropy credential",
    re: /\b(JWT_SECRET|SIG_KEY|SIG_SALT|HEALTHCHECK_TOKEN|DEPLOYMENT_ID|API_KEY|SECRET_KEY|PRIVATE_KEY|PASSWORD|ACCESS_TOKEN)\s*[=:]\s*["']?[A-Fa-f0-9]{32,}/,
  },
];

/** Paths whose matches are examples, fixtures or vendored third-party data. */
const ALLOWED = [
  /^server\/__tests__\//,
  /^frontend\/src\/.*\.test\.jsx?$/,
  /^collector\/__tests__\//,
  /\.example$/,
  /^docker\/\.env\.example$/,
  /^docker\/\.env\.production\.example$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)package-lock\.json$/,
  /^open-computer\//,
  /(^|\/)node_modules\//,
  /^scripts\/secret-scan\.cjs$/,
  /\.(png|jpg|jpeg|gif|ico|webp|pdf|woff2?|ttf|mp3|wav|tar\.gz|zip|onnx|bin|node)$/i,
];

const isAllowed = (file) => ALLOWED.some((re) => re.test(file));

/**
 * Documentation, UI placeholders and template literals look exactly like
 * credentials to a regex. A match is discarded when the matched text itself
 * says it is an example. The matched text is examined here and nowhere else;
 * it is never returned, logged or stored.
 */
const PLACEHOLDER = new RegExp(
  [
    "\\$\\{", // `${username}:${password}@` - built at runtime
    "<[^>]*>", // <your-key>
    "\\b(username|password|user|pass|dbuser|dbuserpass|yourdb|mydb)\\b",
    "\\b(example|placeholder|changeme|replace[-_]?me|dummy|sample|test[-_]?key)\\b",
    "\\bxxx+\\b",
    "your[-_A-Za-z]*(key|token|secret|password|name)",
    "my[A-Z][A-Za-z]*", // sk-myApiKeyToAccess...
  ].join("|"),
  "i"
);

const isPlaceholder = (matched) => PLACEHOLDER.test(matched);

function git(args) {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 512,
  });
}

/** Records a hit by location only. The matched text never leaves this function. */
function scanText(text, label, findings, { lines = true } = {}) {
  const rows = lines ? text.split("\n") : [text];
  rows.forEach((row, index) => {
    if (row.length > 4000) return; // minified bundles and data URIs
    for (const rule of RULES) {
      const match = row.match(rule.re);
      if (!match) continue;
      if (isPlaceholder(match[0])) continue;
      findings.push({
        rule: rule.name,
        where: lines ? `${label}:${index + 1}` : label,
      });
    }
  });
}

function scanWorkingTree() {
  const findings = [];
  const files = git(["ls-files", "-z"]).split("\0").filter(Boolean);
  let scanned = 0;
  for (const file of files) {
    if (isAllowed(file)) continue;
    const full = path.join(REPO_ROOT, file);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) continue;
    const buffer = fs.readFileSync(full);
    if (buffer.includes(0)) continue; // binary
    scanned += 1;
    scanText(buffer.toString("utf8"), file, findings);
  }
  return { findings, scanned, total: files.length };
}

function scanHistory() {
  const findings = [];
  const commits = git(["rev-list", "--all"]).split("\n").filter(Boolean);
  for (const commit of commits) {
    let diff;
    try {
      diff = git(["show", "--format=", "--unified=0", "--no-color", commit]);
    } catch {
      continue;
    }
    let currentFile = "?";
    for (const line of diff.split("\n")) {
      if (line.startsWith("+++ b/")) {
        currentFile = line.slice(6);
        continue;
      }
      if (!line.startsWith("+") || line.startsWith("+++")) continue;
      if (isAllowed(currentFile)) continue;
      scanText(line.slice(1), `${commit.slice(0, 10)} ${currentFile}`, findings, {
        lines: false,
      });
    }
  }
  return { findings, commits: commits.length };
}

function report(title, findings) {
  const seen = new Set();
  const unique = findings.filter((f) => {
    const key = `${f.rule}|${f.where}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  console.log(`\n${title}: ${unique.length} finding(s)`);
  for (const f of unique) console.log(`  [${f.rule}] ${f.where}`);
  return unique.length;
}

const tree = scanWorkingTree();
console.log(
  `Scanned ${tree.scanned} of ${tree.total} tracked files ` +
    `(binary, vendored and example files skipped).`
);
let total = report("WORKING TREE", tree.findings);

if (SCAN_HISTORY) {
  const history = scanHistory();
  console.log(`\nScanned ${history.commits} commit(s).`);
  total += report("HISTORY", history.findings);
}

console.log(
  total === 0
    ? "\nNo committed secrets found. (Locations only are ever reported; values are never printed.)"
    : "\nSecrets found. Rotate them first, then remove them from the tree and history."
);
process.exit(total === 0 ? 0 : 1);
