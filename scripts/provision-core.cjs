#!/usr/bin/env node
/**
 * CLI bridge to the shared provisioning service.
 *
 * `scripts/operator.sh provision` and the founder console call the SAME code
 * through this, so the validation rules, the collision checks and the env
 * template cannot drift apart. Two copies of this logic would eventually
 * differ in a way that puts two customers on one port.
 *
 *   node scripts/provision-core.cjs --slug acme --domain acme.example.com \
 *     --port 3101 --name "Acme Corporation" [--payment-link https://buy.stripe.com/...]
 *
 * Prints human-readable progress on stdout and exits non-zero on refusal.
 */

const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const provisioning = require(
  path.join(REPO_ROOT, "server", "business", "services", "provisioning")
);

/** Parses `--flag value` pairs. Nothing here ever reaches a shell. */
function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

const result = provisioning.provision({
  slug: args.slug,
  name: args.name,
  domain: args.domain,
  port: args.port,
  paymentLink: args["payment-link"],
});

if (!result.success) {
  for (const problem of result.problems ?? [result.error])
    console.error(`\x1b[31m[provision]\x1b[0m ${problem}`);
  process.exit(1);
}

const deployment = result.deployment;
console.log(`\x1b[32m[provision]\x1b[0m Wrote ${deployment.directory}`);
console.log(`  name   : ${deployment.name}`);
console.log(`  domain : ${deployment.domain}`);
console.log(`  port   : 127.0.0.1:${deployment.port}`);
console.log(`  project: ${deployment.project}`);
console.log(
  `  secrets: generated and written 0600 (DEPLOYMENT_ID, JWT_SECRET, SIG_KEY, SIG_SALT, HEALTHCHECK_TOKEN)`
);
process.exit(0);
