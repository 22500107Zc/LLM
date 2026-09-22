const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/**
 * Provisioning a customer deployment: the shared core.
 *
 * WHY THIS IS A SERVICE AND NOT SHELL
 *
 * `scripts/operator.sh provision` is entirely filesystem work - validate the
 * slug, port and domain, check nothing collides, write a 0600 env file with
 * freshly generated secrets, write the reverse-proxy configs. None of it needs
 * docker, a shell, or any privilege beyond writing into the state directory.
 *
 * So it lives here, in ordinary Node, and BOTH the CLI and the founder console
 * call it. One implementation, one set of validation rules, one env template.
 * Two diverging copies of this would eventually differ in a way that matters.
 *
 * WHAT DELIBERATELY IS NOT HERE
 *
 * Starting the container (`docker compose up -d --build`) is a privileged host
 * operation. It stays in the CLI. Nothing in this file executes a process,
 * interpolates a shell, or talks to docker, so a founder HTTP request can
 * never become command execution.
 *
 * WHERE THIS RUNS
 *
 * The state directory holds every customer's configuration, so this is only
 * usable where that directory is - the operator's host, or a container with it
 * mounted. It is NEVER enabled inside a customer's own deployment.
 */

/** 3-32 lowercase letters, digits and hyphens. Becomes a directory, a Compose
 * project and a volume prefix, so it has to be restrictive. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const DOMAIN_PATTERN =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Reserved so a deployment can never shadow a path the tooling relies on. */
const RESERVED_SLUGS = new Set([
  "backups",
  "config",
  "node_modules",
  "platform",
  "public",
  "server",
  "storage",
  "tmp",
]);

function stateDir() {
  return (
    process.env.PLATFORM_STATE_DIR ||
    path.resolve(__dirname, "..", "..", "..", "deployments")
  );
}

const deploymentDir = (slug) => path.join(stateDir(), slug);
const envFileFor = (slug) => path.join(deploymentDir(slug), ".env");
const projectFor = (slug) => `platform-${slug}`;

/** Generated locally, written 0600, never returned to a caller. */
const generateSecret = () => crypto.randomBytes(32).toString("hex");

// ---------------------------------------------------------------- validate --

function validateSlug(slug) {
  const value = String(slug ?? "").trim();
  if (!SLUG_PATTERN.test(value))
    return "Use 3-32 lowercase letters, digits and hyphens, not starting or ending with a hyphen.";
  if (value.includes("--")) return "No double hyphens.";
  if (RESERVED_SLUGS.has(value)) return `"${value}" is reserved.`;
  return null;
}

function validatePort(port) {
  const value = Number(port);
  if (!Number.isInteger(value)) return "Port must be a whole number.";
  if (value < 1024 || value > 65535)
    return "Port must be between 1024 and 65535.";
  return null;
}

function validateDomain(domain) {
  const value = String(domain ?? "")
    .trim()
    .toLowerCase();
  if (!DOMAIN_PATTERN.test(value)) return "That is not a valid domain name.";
  if (value.length > 253) return "Domain is too long.";
  return null;
}

/** Reads one value out of an env file without sourcing or evaluating it. */
function envValue(slug, key) {
  try {
    const contents = fs.readFileSync(envFileFor(slug), "utf8");
    const match = contents.match(new RegExp(`^${key}=(.*)$`, "m"));
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/** Every provisioned deployment on this host, newest configuration first. */
function listDeployments() {
  const root = stateDir();
  if (!fs.existsSync(root)) return [];

  const rows = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    if (!fs.existsSync(envFileFor(slug))) continue;

    let provisionedAt = null;
    try {
      provisionedAt = fs.statSync(envFileFor(slug)).birthtime ?? null;
    } catch {
      provisionedAt = null;
    }

    rows.push({
      slug,
      project: projectFor(slug),
      name: envValue(slug, "CUSTOMER_NAME") ?? slug,
      domain: envValue(slug, "CUSTOMER_DOMAIN"),
      port: envValue(slug, "SERVER_PORT_HOST"),
      supportEmail: envValue(slug, "SUPPORT_EMAIL") || null,
      billingEmail: envValue(slug, "BILLING_EMAIL") || null,
      // Presence only. The value itself is a secret and never leaves here.
      hasDeploymentId: !!envValue(slug, "DEPLOYMENT_ID"),
      paymentLinkConfigured: !!envValue(slug, "STRIPE_PAYMENT_LINK"),
      // Provisioned as unpaid, waiting for the webhook to activate it.
      awaitingActivation:
        envValue(slug, "BILLING_REQUIRE_ACTIVATION") === "true",
      enforcementEnabled:
        envValue(slug, "BILLING_ENFORCEMENT_ENABLED") === "true",
      stripeConfigured: !!envValue(slug, "STRIPE_SECRET_KEY"),
      providerConfigured: !!(
        envValue(slug, "OPEN_AI_KEY") || envValue(slug, "ANTHROPIC_API_KEY")
      ),
      provisionedAt,
      directory: deploymentDir(slug),
    });
  }
  return rows.sort((a, b) => a.slug.localeCompare(b.slug));
}

function getDeployment(slug) {
  if (validateSlug(slug)) return null;
  return listDeployments().find((row) => row.slug === slug) ?? null;
}

/**
 * Refuses a slug, port or domain another deployment already holds.
 *
 * Two customers sharing a port or a domain is not a cosmetic problem: it means
 * one business's traffic reaching another's container.
 */
function findCollisions({ slug, port, domain }) {
  const problems = [];
  if (fs.existsSync(deploymentDir(slug)))
    problems.push(`A deployment named "${slug}" already exists.`);

  for (const existing of listDeployments()) {
    if (existing.slug === slug) continue;
    if (existing.port && String(existing.port) === String(port))
      problems.push(`Port ${port} is already used by "${existing.slug}".`);
    if (
      existing.domain &&
      domain &&
      existing.domain.toLowerCase() === String(domain).toLowerCase()
    )
      problems.push(`Domain ${domain} is already used by "${existing.slug}".`);
  }
  return problems;
}

// ----------------------------------------------------------------- write ----

function envTemplate({ slug, name, domain, port, deploymentId, paymentLink }) {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return `# Deployment configuration for ${name} (${slug})
# Generated ${now}. NEVER COMMIT THIS FILE.

NODE_ENV=production
SERVER_PORT=3001
# The host port this deployment binds on loopback.
SERVER_PORT_HOST=${port}
STORAGE_DIR=/app/server/storage
DATABASE_URL=file:/app/server/storage/anythingllm.db
COLLECTOR_HOTDIR=/app/collector/hotdir

# --- identity ---------------------------------------------------------------
# Immutable. Stamped into every Stripe object this deployment creates and
# required to bind it to a Stripe customer. Never change it.
DEPLOYMENT_ID=${deploymentId}

JWT_SECRET=${generateSecret()}
SIG_KEY=${generateSecret()}
SIG_SALT=${generateSecret()}
HEALTHCHECK_TOKEN=${generateSecret()}

PUBLIC_URL=https://${domain}
PRIMARY_DOMAIN=${domain}
CUSTOMER_DOMAIN=${domain}
CUSTOMER_NAME=${name}
COMPANY_NAME=${name}
APP_NAME=${name} AI
SUPPORT_EMAIL=

# --- included limits --------------------------------------------------------
MAX_USERS=50
MAX_PUBLIC_AGENTS=3
STORAGE_LIMIT_GB=25

# --- security ---------------------------------------------------------------
REQUIRE_MULTI_USER_MODE=true
EMBED_REQUIRE_ALLOWLIST=true
PUBLIC_RATE_LIMIT_PER_MINUTE=30
PUBLIC_RATE_LIMIT_BURST=10
ALLOW_PRIVATE_NETWORK_WEBHOOKS=false
DISABLE_TELEMETRY=true

# --- billing ----------------------------------------------------------------
PLAN_AMOUNT_CENTS=388888
# The Stripe-hosted Payment Link this customer opens to pay. The application
# appends its own client_reference_id so the webhook can match the payment.
STRIPE_PAYMENT_LINK=${paymentLink}
STRIPE_SECRET_KEY=
STRIPE_PUBLISHABLE_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_ID=
STRIPE_PRODUCT_ID=
STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID=
STRIPE_CUSTOMER_ID=
STRIPE_SUBSCRIPTION_ID=
# A new business starts UNPAID. Enforcement is on and there is no subscription
# yet, so AI usage is suspended until the Stripe webhook records the first
# payment. Nothing else is restricted and no data is affected.
BILLING_ENFORCEMENT_ENABLED=true
BILLING_REQUIRE_ACTIVATION=true
BILLING_GRACE_PERIOD_DAYS=7

# --- AI provider (the CUSTOMER'S OWN credentials) ---------------------------
LLM_PROVIDER=openai
OPEN_AI_KEY=
OPEN_MODEL_PREF=gpt-4o
EMBEDDING_ENGINE=native
VECTOR_DB=lancedb

# --- notifications ----------------------------------------------------------
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM=
`;
}

function caddyConfig(domain, port) {
  return `# Reverse proxy for ${domain} -> 127.0.0.1:${port}
# Caddy obtains and renews the certificate automatically.
${domain} {
    encode gzip

    reverse_proxy 127.0.0.1:${port} {
        # Streaming chat responses must not be buffered.
        flush_interval -1
    }

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
    }

    request_body {
        max_size 3GB
    }
}
`;
}

function nginxConfig(domain, port) {
  return `# Reverse proxy for ${domain} -> 127.0.0.1:${port}
server {
    listen 443 ssl http2;
    server_name ${domain};

    ssl_certificate     /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options nosniff always;

    client_max_body_size 3G;

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;

        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Streaming chat: without this, replies arrive all at once.
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 600s;
    }
}

server {
    listen 80;
    server_name ${domain};
    return 301 https://$host$request_uri;
}
`;
}

/**
 * Provisions a customer deployment's configuration.
 *
 * Writes the state directory, the 0600 env file and both reverse-proxy
 * configs. It does NOT start anything: the returned `nextCommand` is the
 * privileged step an operator runs on the host.
 *
 * @param {{slug: string, name?: string, domain: string, port: number|string,
 *          paymentLink?: string}} input
 * @returns {{success: boolean, error?: string, problems?: string[],
 *            deployment?: object, nextCommand?: string}}
 */
function provision(input = {}) {
  const slug = String(input.slug ?? "")
    .trim()
    .toLowerCase();
  const domain = String(input.domain ?? "")
    .trim()
    .toLowerCase();
  // Normalized before anything uses it. `"0x0c65"` and `" 3101 "` both pass a
  // numeric check but would be written into the env file verbatim, and Docker
  // would then refuse to bind the port.
  const port = Number(input.port);
  const name = String(input.name ?? "").trim() || slug;
  const paymentLink = String(input.paymentLink ?? "").trim();

  const problems = [
    validateSlug(slug) && `Slug: ${validateSlug(slug)}`,
    validateDomain(domain) && `Domain: ${validateDomain(domain)}`,
    validatePort(port) && `Port: ${validatePort(port)}`,
  ].filter(Boolean);
  if (problems.length) return { success: false, problems };

  if (name.length > 120)
    return { success: false, problems: ["Name is too long (max 120)."] };
  // The name is written into an env file, so it must not be able to introduce
  // another variable or comment line.
  if (/[\r\n]/.test(name))
    return { success: false, problems: ["Name cannot contain line breaks."] };

  // Optional at provisioning time - the operator often creates the Stripe
  // Payment Link afterwards and records it then.
  if (paymentLink) {
    const problem = validatePaymentLink(paymentLink);
    if (problem) return { success: false, problems: [problem] };
  }

  const collisions = findCollisions({ slug, port, domain });
  if (collisions.length) return { success: false, problems: collisions };

  const dir = deploymentDir(slug);
  const deploymentId = generateSecret();

  try {
    fs.mkdirSync(path.join(dir, "backups"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      envFileFor(slug),
      envTemplate({ slug, name, domain, port, deploymentId, paymentLink }),
      { mode: 0o600 }
    );
    // Written again explicitly: an existing file keeps its old mode.
    fs.chmodSync(envFileFor(slug), 0o600);

    fs.writeFileSync(path.join(dir, "caddy.conf"), caddyConfig(domain, port), {
      mode: 0o644,
    });
    fs.writeFileSync(path.join(dir, "nginx.conf"), nginxConfig(domain, port), {
      mode: 0o644,
    });
  } catch (error) {
    return {
      success: false,
      problems: [`Could not write the deployment: ${error.message}`],
    };
  }

  return {
    success: true,
    deployment: getDeployment(slug),
    // Starting the container is privileged and stays with the operator.
    nextCommand: `./scripts/operator.sh update ${slug}`,
  };
}

/**
 * Validates a Stripe-hosted Payment Link.
 *
 * Only ever an https URL on stripe.com. A mistyped or substituted host would
 * send a paying customer somewhere neither we nor Stripe controls.
 */
function validatePaymentLink(value) {
  const link = String(value ?? "").trim();
  if (!link) return "A payment link is required.";
  let url;
  try {
    url = new URL(link);
  } catch {
    return "That is not a URL.";
  }
  if (url.protocol !== "https:" || !/(^|\.)stripe\.com$/.test(url.hostname))
    return `The payment link must be an https Stripe-hosted URL. Got host "${url.hostname}".`;
  return null;
}

/**
 * Records the Stripe-hosted Payment Link on an existing deployment.
 *
 * Rewrites exactly one line of the env file and leaves every other value -
 * including the generated secrets - untouched. The file is rewritten through a
 * temporary file so an interrupted write cannot leave a deployment with a
 * truncated configuration.
 *
 * @returns {{success: boolean, error?: string}}
 */
function setPaymentLink(slug, link) {
  if (validateSlug(slug))
    return { success: false, error: "Unknown deployment." };
  if (!fs.existsSync(envFileFor(slug)))
    return { success: false, error: "Unknown deployment." };

  const problem = validatePaymentLink(link);
  if (problem) return { success: false, error: problem };

  const value = String(link).trim();
  // Refuse anything that could introduce a second line into the env file.
  if (/[\r\n]/.test(value))
    return {
      success: false,
      error: "The payment link cannot contain line breaks.",
    };

  try {
    const file = envFileFor(slug);
    const contents = fs.readFileSync(file, "utf8");
    const line = `STRIPE_PAYMENT_LINK=${value}`;
    const updated = /^STRIPE_PAYMENT_LINK=.*$/m.test(contents)
      ? contents.replace(/^STRIPE_PAYMENT_LINK=.*$/m, line)
      : `${contents.replace(/\n*$/, "\n")}${line}\n`;

    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, updated, { mode: 0o600 });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    return {
      success: false,
      error: `Could not update the deployment: ${error.message}`,
    };
  }

  return { success: true };
}

/**
 * Whether this process can act as a control plane at all.
 *
 * A customer's own deployment has no state directory mounted, so it can never
 * accidentally become one.
 */
function stateDirAvailable() {
  try {
    return fs.statSync(stateDir()).isDirectory();
  } catch {
    return false;
  }
}

module.exports = {
  SLUG_PATTERN,
  DOMAIN_PATTERN,
  RESERVED_SLUGS,
  stateDir,
  stateDirAvailable,
  deploymentDir,
  envFileFor,
  projectFor,
  envValue,
  validateSlug,
  validatePort,
  validateDomain,
  validatePaymentLink,
  setPaymentLink,
  findCollisions,
  listDeployments,
  getDeployment,
  provision,
  // Exported for the CLI bridge and for tests.
  envTemplate,
  caddyConfig,
  nginxConfig,
};
