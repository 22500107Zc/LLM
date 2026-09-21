# Deployment Guide

Managed Business AI Operations Platform — one business, one dedicated deployment.

---

## 1. Architecture

Each customer receives an isolated deployment:

| Isolated | How |
| --- | --- |
| Application | Its own container |
| Database | Its own SQLite file (or PostgreSQL instance) on a dedicated volume |
| Users, workspaces, agents | Scoped to that database |
| Vector data | Its own LanceDB directory on the same volume |
| Documents | Its own storage volume |
| API credentials | Its own `.env` |
| Integrations, logs, backups | Per deployment |
| Domain | `customer.yourdomain.com` |

No data is shared between customers. There is no shared multi-tenant layer and
no Kubernetes requirement.

---

## 2. Prerequisites

- A Linux host with Docker Engine and the Compose plugin
- A DNS record for the customer subdomain pointing at the host
- A reverse proxy terminating TLS (Caddy or nginx)
- The customer's AI provider API key
- Stripe account with the commercial product configured (see §7)

---

## 3. First deployment

```bash
git clone <this-repo> /opt/platform-acme
cd /opt/platform-acme

cp docker/.env.production.example docker/.env

# Generate the three required secrets
printf 'JWT_SECRET=%s\nSIG_KEY=%s\nSIG_SALT=%s\n' \
  "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" \
  >> docker/.env

# Fill in branding, customer identity, Stripe and the AI provider key
$EDITOR docker/.env

docker compose -f docker/docker-compose.production.yml up -d --build
docker compose -f docker/docker-compose.production.yml logs -f
```

The container refuses to start if `JWT_SECRET`, `SIG_KEY` or `SIG_SALT` is
missing or weak. That is deliberate.

Wait for:

```
[Platform] Acme AI Operations v1.16.1 - Acme Corporation
Primary server in HTTP mode listening on port 3001
```

### Create the owner account

Open `https://customer.yourdomain.com` and complete the first-run flow. The
first account created becomes an administrator; promote it to **Owner** on the
Team page.

Until multi-user mode is enabled, production blocks every non-bootstrap route
with `401`. This is the guard that prevents an unconfigured deployment from
serving the whole application anonymously.

---

## 4. Reverse proxy and HTTPS

The container listens on `127.0.0.1:3001` only. TLS terminates at the proxy.

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

## 5. Stripe webhook

Point a Stripe webhook endpoint at:

```
https://customer.yourdomain.com/api/billing/stripe/webhook
```

Copy the resulting signing secret into `STRIPE_WEBHOOK_SECRET` and restart.

The endpoint is mounted with a raw body parser ahead of the JSON parser so the
exact signed bytes are preserved for verification. Unsigned, mis-signed,
tampered and replayed requests are all rejected.

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

## 7. Stripe product configuration

Create once in the Stripe Dashboard, then reuse the IDs for every deployment.

1. **Product** → name `Managed Business AI Platform`
2. **Price** → `3888.88 USD`, recurring, monthly → copy `price_…` into `STRIPE_PRICE_ID`
3. Copy the product id `prod_…` into `STRIPE_PRODUCT_ID`
4. **Customer Portal** → enable, allow payment-method updates, invoice history
   and cancellation; disable plan switching (there is only one plan). Copy the
   configuration id into `STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID`
5. **Webhook** → the URL in §5, subscribing to the events in §9

Verify with **Billing → Refresh from Stripe**. The Billing page warns if the
configured price does not equal $3,888.88/month.

---

## 8. Backups

```bash
# Manual
STORAGE_DIR=/var/lib/docker/volumes/business-ai-platform_platform-storage/_data \
  ./scripts/backup.sh /opt/backups/acme

# Nightly at 02:30
30 2 * * * cd /opt/platform-acme && STORAGE_DIR=... ./scripts/backup.sh /opt/backups/acme >> /var/log/platform-backup.log 2>&1
```

Backs up the database, documents, vector data, encryption keys and `.env`.
Excludes model caches and scratch directories.

**The archive contains secrets and customer documents.** It is written `0600`.
Store it encrypted and off-host.

### Restore

```bash
./scripts/restore.sh /opt/backups/acme/backup-<timestamp>.tar.gz --force
cd server && npx prisma migrate deploy
docker compose -f docker/docker-compose.production.yml restart
```

Restore moves any existing storage aside to `storage.pre-restore.<timestamp>`
rather than deleting it, and refuses to overwrite a non-empty directory without
`--force`. Configuration files are extracted as `restored-*.env` for review
rather than applied automatically.

Test a restore into a scratch directory before you need one:

```bash
./scripts/restore.sh <archive> --target /tmp/restore-test
```

---

## 9. Stripe events consumed

| Event | Effect |
| --- | --- |
| `checkout.session.completed` | Binds customer + subscription, activates |
| `customer.subscription.created` | Syncs state |
| `customer.subscription.updated` | Syncs state, period, cancellation flag |
| `customer.subscription.deleted` | Marks canceled (no data is deleted) |
| `customer.subscription.paused` / `.resumed` | Syncs state |
| `invoice.paid` / `invoice.payment_succeeded` | Clears dunning, records payment |
| `invoice.payment_failed` | Starts the grace-period clock |
| `invoice.payment_action_required` | Flags for customer action |
| `customer.deleted` | Audited only |

Every event id is claimed in `billing_events` before being applied, so replays
are ignored. A failed apply releases the claim so Stripe's retry is processed.

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
cd /opt/platform-acme
STORAGE_DIR=... ./scripts/backup.sh /opt/backups/acme    # always back up first
git pull
docker compose -f docker/docker-compose.production.yml up -d --build
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
