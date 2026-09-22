# Deployment Guide

Managed Business AI Operations Platform — one application, many founder-created
customer accounts.

---

## 1. Architecture

**One application. One database. Many customer accounts.**

A customer is an account the founder creates inside the running application.
Selling to someone does not start a container, does not need a new domain and
does not create a second website.

| | |
| --- | --- |
| Application | One deployment serving every customer |
| Database | One SQLite file (or PostgreSQL), holding all accounts |
| Customer account | A `users` row plus a `business_customers` row |
| Login | Email + password, both set by the founder |
| Access control | `users.suspended`, founder-controlled, checked on every request |
| Isolation between customers | Workspace membership — a customer only sees workspaces they belong to |
| Payment | Stripe, entirely outside the application |

### What this is not

- Not one deployment per customer.
- Not one website or domain per customer.
- Not Stripe-driven: no API key, no webhook, nothing automatic about access.
- Not self-service: there is no public signup.

Self-hosting the application for a single business on its own box is still
supported — that is what `scripts/operator.sh` and the Docker setup below are
for. It is infrastructure tooling, not the commercial account model.

---

## 2. Prerequisites

- A Linux host with Docker Engine and the Compose plugin
- A DNS record for the customer subdomain pointing at the host
- A reverse proxy terminating TLS (Caddy or nginx)
- The customer's AI provider API key
- Stripe account with the commercial product configured (see §7)

---

## 2a. Selling a customer, and the founder console

**This is the commercial workflow.** `scripts/operator.sh` and Docker are
infrastructure tooling for running the application; they are not how you take
on a customer.

A customer is an **account in the application**. Creating one starts no
container, needs no new domain and needs no second website.

### The workflow

1. Qualify the business.
2. Email them your Stripe-hosted subscription Payment Link. This happens
   entirely outside the application.
3. They subscribe.
4. You confirm the payment in Stripe.
5. They tell you the email address and password they want.
6. Sign in at `https://your-app/founder`.
7. Create their account: business name, their login email, their password.
8. They sign in at `https://your-app/` with that email and password.

Stripe bills them every month on its own. The application never talks to
Stripe, needs no Stripe API key, and receives no webhook to let them in.

### If they stop paying

Open `/founder`, find them, **Disable access**. Their current session stops
working on their very next request — not when their token expires. No data is
deleted. When they resolve it, **Restore access** and they can sign in again.

You are the source of truth. Nothing automates this, on purpose.

### Enabling the console

Generate the password hash. The script reads the password with echo off and
prints only the hash; the password is never written, echoed or passed as an
argument, and it refuses to run without a terminal so it cannot land in shell
history:

```bash
node scripts/founder-password.cjs
```

Put what it prints into the application's `.env`:

```
FOUNDER_CONSOLE_ENABLED=true
FOUNDER_PASSWORD_HASH=$2b$12$…
```

Restart, then open `https://your-app/founder`.

With `FOUNDER_CONSOLE_ENABLED` unset, every founder route answers 404 — not
401, which would confirm the paths exist.

### What the console does

| | |
| --- | --- |
| Create a customer | Business name, authorized login email, their chosen password |
| List customers | Login email, access state, created date |
| Edit | Business information, contact, your own payment note |
| Change email | The old address stops working immediately |
| Set a new password | The old one stops working. The current one cannot be shown — only a hash exists |
| Disable / restore | Application access, founder-controlled |
| Remove | Permanent, and requires typing the business name back |

### Two things to get right

- **Restrict `/founder` at the reverse proxy** to your own address as well. The
  password is the control, but there is no reason to offer the login page to
  the internet.
- **Customers are `default` role**, never admin. An admin would see every other
  customer's workspaces. The console enforces this; do not create customer
  accounts by hand through the admin UI.

---

## 3. First deployment

Every deployment is created and operated with one tool: `scripts/operator.sh`.
It generates the secrets, writes the customer's configuration file, produces the
reverse-proxy config, and keeps each customer separate from every other customer
on the host. You do not need to edit Compose files or remember any commands
beyond the ones below.

Install the platform once per host.

**A default clone gives you the wrong code.** This repository's default branch
is upstream AnythingLLM; the commercial application lives on its own branch.
Clone that branch explicitly:

```bash
git clone --branch claude/commercial-b2b-ai-platform-0skp39 \
  https://github.com/22500107Zc/LLM.git /opt/platform
cd /opt/platform
```

Or pin a known release commit, which is what to do for a customer:

```bash
git clone https://github.com/22500107Zc/LLM.git /opt/platform
cd /opt/platform
git checkout <release-commit-sha>
```

Confirm you have the commercial application before going further — these files
exist only on the commercial branch:

```bash
ls server/business/config.js scripts/operator.sh && echo "commercial code present"
```

If that fails, you are on upstream master and nothing below will work.

### Provision a customer

Pick a **slug** (lowercase short name, e.g. `acme`), the **domain** they will
use, and a **port** on this host that no other customer uses (3101, 3102, 3103…).

```bash
cd /opt/platform
./scripts/operator.sh provision acme --domain acme.yourdomain.com --port 3101 --name "Acme Corporation"
```

This creates `deployments/acme/` containing:

| File | What it is |
| --- | --- |
| `.env` | The customer's configuration and secrets, written `0600` |
| `caddy.conf` | Ready-to-install reverse-proxy config (Caddy) |
| `nginx.conf` | The same, for nginx |
| `backups/` | Where this customer's backups are written |

`DEPLOYMENT_ID`, `JWT_SECRET`, `SIG_KEY`, `SIG_SALT` and `HEALTHCHECK_TOKEN` are
generated on the host and never printed to the screen. The tool refuses to
provision if the slug, port or domain is already taken by another deployment, or
if anything else on the host already holds that port.

To see exactly what would happen without changing anything, add `--dry-run` to
any command.

### Fill in the customer's details

```bash
$EDITOR deployments/acme/.env
```

Set at minimum:

- `SUPPORT_EMAIL` — where their staff should write for help
- the AI provider key (`OPEN_AI_KEY`, or the equivalent for their provider)
- the Stripe values from §7, once the subscription exists

Then confirm the configuration is still valid:

```bash
./scripts/operator.sh check acme
```

### Install the reverse proxy

`provision` writes the config; it does not install it. Copying the file is not
enough on a default install — Caddy does not read a `sites/` directory unless
its main Caddyfile imports one.

**Prerequisites:** a DNS `A`/`AAAA` record for the customer's domain already
pointing at this host, and ports 80 and 443 reachable. Caddy needs both to
obtain a certificate.

**Caddy — first time on this host only:**

```bash
sudo apt install -y caddy                     # if not already installed
sudo mkdir -p /etc/caddy/sites
# Make Caddy read the per-customer directory, once:
grep -q 'import sites/\*' /etc/caddy/Caddyfile \
  || echo 'import sites/*' | sudo tee -a /etc/caddy/Caddyfile
```

**Caddy — for each customer:**

```bash
sudo cp deployments/acme/caddy.conf /etc/caddy/sites/acme.conf
sudo caddy validate --config /etc/caddy/Caddyfile   # check before reloading
sudo systemctl reload caddy
```

**nginx — for each customer:**

```bash
sudo cp deployments/acme/nginx.conf /etc/nginx/sites-available/acme.conf
sudo ln -sf /etc/nginx/sites-available/acme.conf /etc/nginx/sites-enabled/acme.conf
sudo nginx -t                                        # check before reloading
sudo systemctl reload nginx
```

The nginx config expects a certificate at
`/etc/letsencrypt/live/<domain>/`. Obtain one first, or nginx will fail to
reload:

```bash
sudo certbot certonly --nginx -d acme.yourdomain.com
```

Caddy obtains and renews its own certificate; nothing extra is needed there.

**Confirm the proxy is actually serving the customer's domain:**

```bash
curl -fsS -o /dev/null -w '%{http_code}\n' https://acme.yourdomain.com/api/ping
```

`401` or `200` means the proxy is reaching the deployment. A connection error
or `502` means it is not — check the proxy's logs before going further.

### Start it

```bash
./scripts/operator.sh update acme
```

`update` backs up first — and **stops if that backup fails** — then builds,
starts, and waits until the deployment reports ready through its health probe,
not merely until the port answers. It tells you plainly if it does not come up.

### Check it

```bash
./scripts/operator.sh status acme     # one customer
./scripts/operator.sh list            # every customer on this host
```

### Adding the second, third, tenth customer

Exactly the same command with a different slug, domain and port:

```bash
./scripts/operator.sh provision globex --domain globex.yourdomain.com --port 3102 --name "Globex"
```

Each customer gets its own Compose project, container, storage volumes, backups
and configuration file. One customer's build, restart, backup, restore or
failure cannot touch another's.

### Create the owner account

Open `https://acme.yourdomain.com` and complete the first-run flow. The first
account created becomes an administrator; promote it to **Owner** on the Team
page.

Until multi-user mode is enabled, production blocks every non-bootstrap route
with `401`. This is the guard that prevents an unconfigured deployment from
serving the whole application anonymously. The container also refuses to start
if `DEPLOYMENT_ID`, `JWT_SECRET`, `SIG_KEY` or `SIG_SALT` is missing or weak.
That is deliberate.

### Every command, in one place

| Command | What it does |
| --- | --- |
| `./scripts/operator.sh provision <slug> --domain <d> --port <p>` | Create a new customer deployment |
| `./scripts/operator.sh check <slug>` | Validate configuration, secrets and file permissions |
| `./scripts/operator.sh update <slug>` | Back up, rebuild, restart, wait for health |
| `./scripts/operator.sh status <slug>` | Show one customer's state |
| `./scripts/operator.sh list` | Show every customer on this host |
| `./scripts/operator.sh backup <slug>` | Back up that customer's data |
| `./scripts/operator.sh restore-test <slug>` | Prove the newest backup restores — live deployment untouched |
| `./scripts/operator.sh suspend <slug>` | Stop the containers; data is kept |
| `./scripts/operator.sh resume <slug>` | Start them again |
| `./scripts/operator.sh logs <slug>` | Follow the logs |
| `./scripts/operator.sh remove-containers <slug>` | Remove containers only; volumes, backups and `.env` are kept |

Add `--dry-run` to any of them to see what it would do.

**There is no command that deletes customer data.** That is deliberate. Removing
a customer's data is a manual, deliberate act performed by a human who has
confirmed the contract has ended and a final backup exists.

### Never commit a customer's configuration

`deployments/` and `backups/` are excluded from Git. The `.env` file holds that
customer's secrets. Back it up somewhere safe and encrypted — without it, their
stored integration credentials cannot be read back after a restore.

---

## 4. Reverse proxy and HTTPS

The container listens on loopback only, on the port you chose for that
customer (`127.0.0.1:3101` for `acme` above). TLS terminates at the proxy.
`operator.sh provision` already wrote a correct config for the customer's
domain and port to `deployments/<slug>/caddy.conf` and `nginx.conf`; the
templates below are what they contain.

### Caddy (recommended — automatic certificates)

```caddy
customer.yourdomain.com {
    encode gzip

    # Streaming chat responses must not be buffered.
    reverse_proxy 127.0.0.1:3001 {
        flush_interval -1
    }

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
    }
}
```

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name customer.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/customer.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/customer.yourdomain.com/privkey.pem;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options nosniff always;

    client_max_body_size 3G;   # document uploads

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;

        # Agent websockets
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Streaming chat: disable buffering or replies arrive all at once.
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 600s;
    }
}

server {
    listen 80;
    server_name customer.yourdomain.com;
    return 301 https://$host$request_uri;
}
```

`X-Forwarded-Proto` and `X-Forwarded-Host` matter: the Stripe Checkout return
URL and the website-agent snippet are built from them when `PUBLIC_URL` is not
set. Setting `PUBLIC_URL` explicitly is safer.

---

## 5. Stripe (optional, and outside the application)

**No Stripe configuration is required.** The product does not ask Stripe
anything to decide who may sign in, and it needs no Stripe API key. A customer
can use the application with every Stripe variable unset — there is a test that
proves it by deleting all of them and signing a customer in anyway.

How payment works is in §2a: you email a hosted Payment Link, they subscribe,
Stripe bills them monthly, and you create their account once you see the money.

The billing module and webhook endpoint still exist for operators who want
subscription *reporting* inside the application. They are inert as far as
access is concerned:

- A webhook **cannot** create an account.
- A webhook **cannot** activate, disable or restore one.
- A payment failure **cannot** lock anybody out.

If you want that reporting, point a Stripe webhook at
`https://your-app/api/billing/stripe/webhook` and set `STRIPE_WEBHOOK_SECRET`.
The endpoint is mounted with a raw body parser ahead of the JSON parser so the
exact signed bytes are preserved; unsigned, mis-signed, tampered and replayed
requests are all rejected. Skip this entirely if you do not want it.

---

## 6. Container security posture

| Control | Setting |
| --- | --- |
| Linux capabilities | `cap_drop: ALL` — upstream's `SYS_ADMIN` grant is removed |
| Privilege escalation | `no-new-privileges:true` |
| User | Non-root (`UID:GID`, default `1000:1000`) |
| Network exposure | `127.0.0.1:3001` only |
| Restart policy | `unless-stopped` |
| Healthcheck | `/api/ping` every 30s |
| Log rotation | 20 MB × 5 files |

`SYS_ADMIN` exists upstream so Chromium's sandbox can run for the web-scraping
data connector. That capability is close to host root, and core functionality
— documents, RAG, chat, agents, website agents, the API — does not need it. If
a customer requires web scraping, attach a Chrome seccomp profile rather than
restoring the capability.

---

## 7. Setting up the Payment Link in Stripe

This is done once, in the Stripe Dashboard. The application is not involved and
needs none of these IDs.

1. **Product** → name `Managed Business AI Platform`
2. **Price** → `3888.88 USD`, recurring, monthly
3. **Payment Link** → create one for that price, with the subscription options
   you want. Copy the `https://buy.stripe.com/…` URL.
4. That URL is what you email a customer. Keep it somewhere you can find it.

That is the whole integration. You are not required to create an API key, and
you should not put one in the application.

The optional reporting features in §5 and §9 need `STRIPE_SECRET_KEY` and
`STRIPE_WEBHOOK_SECRET`. Skip them unless you want in-app billing reporting;
nothing about customer access depends on them.

---

## 8. Backups

```bash
# Manual, for one customer
./scripts/operator.sh backup acme

# Nightly at 02:30, every customer on this host
30 2 * * * cd /opt/platform && for c in $(ls deployments); do ./scripts/operator.sh backup "$c"; done >> /var/log/platform-backup.log 2>&1
```

Backups land in `deployments/<slug>/backups/` and contain only that customer's
data and configuration: the database, documents, vector data, the encryption
material, and that deployment's own `.env`.

By default `backup` briefly stops **only that one customer** so the snapshot is
consistent — a tar of a live SQLite file can capture a half-written page and
restore to a corrupt database. The pause lasts as long as the copy and the
customer is started again immediately, including if the backup fails. Add
`--online` to skip the pause; the archive's manifest then records that it is an
online copy rather than a consistent snapshot.

`update` takes a backup **first and stops if it fails.** An existing deployment
is never rebuilt without one. A brand-new deployment with no data yet proceeds
without a backup, because there is nothing to lose. `--skip-backup` overrides
the stop and says plainly that you are accepting the risk.

Backs up the database, documents, vector data, encryption keys and `.env`.
Excludes model caches and scratch directories.

**The archive contains secrets and customer documents.** It is written `0600`.
Store it encrypted and off-host.

### Restore

Prove a backup is restorable **before** you need it. This extracts the newest
archive to a throwaway directory and verifies it; the live deployment is never
touched:

```bash
./scripts/operator.sh restore-test acme
```

`restore-test` does more than check that a file exists: it extracts into
isolated temporary storage, runs SQLite's own `integrity_check`, then opens the
restored database and reads real rows out of it. It also confirms the archive
contains the deployment's configuration, without which a restored deployment
could not read back its stored integration secrets.

To perform a real restore into the customer's own Docker volume:

```bash
./scripts/operator.sh restore acme                                   # newest backup
./scripts/operator.sh restore acme deployments/acme/backups/backup-<timestamp>.tar.gz
```

It asks you to type the customer slug, takes a safety backup of what is there
now, stops that customer, writes the restored data into **that customer's**
volume (`platform-<slug>_platform-storage`), and starts it again.

The previous contents are moved aside **inside the volume** to
`.pre-restore-<timestamp>` rather than deleted, so a bad restore is still
recoverable. The archive's `config/<slug>.env` is **not** applied
automatically — compare it with `deployments/<slug>/.env` yourself first.

`scripts/restore.sh` is for a non-Docker install restoring into a host
directory. Do not use it against a Docker deployment: it writes to a filesystem
path, not to the customer's volume.

---

## 8a. Testing — never against a customer deployment

The acceptance, document and provider suites **create and delete data**: users,
agents, website agents, leads, escalations, quality tests and API keys. They
are written for a disposable deployment and refuse any non-local `BASE_URL`
unless `ALLOW_REMOTE_ACCEPTANCE=1` is set deliberately, which prints a
destructive-test warning.

Run them the safe way — this stands up a throwaway deployment with its own
storage, secrets and port, runs everything, saves the logs and tears it down:

```bash
./scripts/run-disposable-acceptance.sh
```

Results land in `test-results/<timestamp>/`. The runner prefers Docker and
falls back to isolated local processes when no daemon is available.

Provider-backed verification (real answers, citations, refusals, isolation)
needs a configured model provider. Without one it reports
`BLOCKED: PROVIDER CREDENTIAL REQUIRED` rather than passing:

```bash
BASE_URL=http://localhost:3001 \
DOC_TEST_USER=<admin> DOC_TEST_PASSWORD=<password> \
  node scripts/provider-verification.cjs
```

---

## 9. Stripe events (only if you enabled the optional reporting)

None of these grants, revokes or restores application access. That is the
founder's decision, made in `/founder`. These only update what the in-app
billing report shows.

| Event | Effect on the report |
| --- | --- |
| `checkout.session.completed` | Records the customer and subscription |
| `customer.subscription.created` | Syncs state |
| `customer.subscription.updated` | Syncs state, period, cancellation flag |
| `customer.subscription.deleted` | Marks canceled (no data is deleted) |
| `customer.subscription.paused` / `.resumed` | Syncs state |
| `invoice.paid` / `invoice.payment_succeeded` | Records payment |
| `invoice.payment_failed` | Records the failure |
| `invoice.payment_action_required` | Flags for attention |
| `customer.deleted` | Audited only |

Every event id is claimed in `billing_events` before being applied, so replays
are ignored. A failed apply releases the claim so Stripe's retry is processed.

**A failed payment does not lock anyone out.** If you want a customer to lose
access, disable them in `/founder`.

---

## 10. Health monitoring

| Endpoint | Audience |
| --- | --- |
| `GET /api/ping` | Container healthcheck |
| `GET /api/platform/health/probe` | External uptime monitor. Send `X-Health-Token` when `HEALTHCHECK_TOKEN` is set |
| `GET /api/business/health` | Full report, Owner/Administrator only |

Neither endpoint exposes credentials, connection strings or filesystem paths.

---

## 11. Updates

```bash
cd /opt/platform
git pull
./scripts/operator.sh update acme
```

`update` backs up that customer first, then rebuilds, restarts and waits for the
health check. Update one customer at a time so a bad release never takes every
customer down at once:

```bash
./scripts/operator.sh update acme      # verify it, then
./scripts/operator.sh update globex
```

Migrations run automatically at container start.

---

## 12. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Container exits immediately | Weak or missing `JWT_SECRET` / `SIG_KEY` / `SIG_SALT` | Check logs; generate with `openssl rand -hex 32` |
| Every route returns 401 | Multi-user mode not enabled | Complete first-run setup and create the owner account |
| Chat replies arrive all at once | Proxy is buffering | `proxy_buffering off` (nginx) or `flush_interval -1` (Caddy) |
| Website agent returns "Invalid request" | Requesting origin not in the allowlist | Add the exact origin including `https://` |
| Billing state looks stale | A webhook was missed | **Billing → Refresh from Stripe** |
| Stripe webhook 400s | Wrong `STRIPE_WEBHOOK_SECRET` | Recopy from the Stripe dashboard endpoint |
| Uploads fail at ~1 MB | Proxy body limit | `client_max_body_size 3G` |
| `COMPOSE_PROJECT_NAME is required` | Compose was run directly | Use `./scripts/operator.sh <command> <slug>` |
| `Port N is already in use` | Another customer or service holds it | Choose a different `--port` |
| Deployment does not become healthy | Build or configuration failure | `./scripts/operator.sh logs <slug>` |
