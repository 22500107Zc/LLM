#!/usr/bin/env bash
#
# Operator CLI for dedicated customer deployments.
#
# One business = one dedicated deployment. This tool keeps several of them on
# one host without them ever touching each other: separate project, container,
# port, domain, storage volumes, env file and backups.
#
#   ./scripts/operator.sh provision acme --domain acme.yourdomain.com --port 3101
#   ./scripts/operator.sh status acme
#   ./scripts/operator.sh backup acme
#   ./scripts/operator.sh restore-test acme
#   ./scripts/operator.sh update acme
#   ./scripts/operator.sh suspend acme
#   ./scripts/operator.sh resume acme
#   ./scripts/operator.sh list
#
# Add --dry-run to any command to see exactly what it would do.
#
# Nothing here deletes customer data. There is no automatic data-deletion
# command by design.
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${PLATFORM_STATE_DIR:-$ROOT/deployments}"
COMPOSE_FILE="$ROOT/docker/docker-compose.production.yml"
DRY_RUN=0

# ---------------------------------------------------------------- output ----
c_info()  { printf '\033[36m[operator]\033[0m %s\n' "$*"; }
c_ok()    { printf '\033[32m[operator]\033[0m %s\n' "$*"; }
c_warn()  { printf '\033[33m[operator]\033[0m %s\n' "$*"; }
c_err()   { printf '\033[31m[operator]\033[0m %s\n' "$*" >&2; }
die()     { c_err "$*"; exit 1; }

run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '\033[2m  would run: %s\033[0m\n' "$*"
    return 0
  fi
  "$@"
}

# ------------------------------------------------------------ validation ----
# A slug becomes a compose project, a volume prefix and a directory name, so it
# must be restrictive.
validate_slug() {
  local slug="$1"
  [[ "$slug" =~ ^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$ ]] || \
    die "Invalid customer slug '$slug'. Use 3-32 lowercase letters, digits and hyphens, not starting or ending with a hyphen."
  [[ "$slug" == *--* ]] && die "Invalid customer slug '$slug': no double hyphens."
  return 0
}

validate_port() {
  local port="$1"
  [[ "$port" =~ ^[0-9]+$ ]] || die "Invalid port '$port'."
  [ "$port" -ge 1024 ] && [ "$port" -le 65535 ] || \
    die "Port $port is outside the usable range 1024-65535."
}

validate_domain() {
  local domain="$1"
  [[ "$domain" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || \
    die "Invalid domain '$domain'."
}

deployment_dir() { echo "$STATE_DIR/$1"; }
env_file_for()   { echo "$(deployment_dir "$1")/.env"; }
project_for()    { echo "platform-$1"; }

require_deployment() {
  local slug="$1"
  [ -d "$(deployment_dir "$slug")" ] || \
    die "No deployment '$slug'. Run: ./scripts/operator.sh provision $slug --domain <domain> --port <port>"
}

# Reads one value out of a deployment's env file without sourcing it.
env_value() {
  local slug="$1" key="$2"
  sed -n "s/^${key}=//p" "$(env_file_for "$slug")" 2>/dev/null | head -1
}

# True when something is already listening on 127.0.0.1:<port>. Uses whichever
# tool the host actually has; bash's /dev/tcp is the fallback that always works.
port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -q "[:.]$port[[:space:]]" && return 0
  elif command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN -Pn >/dev/null 2>&1 && return 0
  fi
  (exec 3<>"/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1 && { exec 3<&- 3>&-; return 0; }
  return 1
}

# Two deployments must never share a port, domain, project or storage path.
assert_no_collisions() {
  local slug="$1" port="$2" domain="$3"

  [ -d "$(deployment_dir "$slug")" ] && \
    die "Deployment '$slug' already exists at $(deployment_dir "$slug")."

  if [ -d "$STATE_DIR" ]; then
    for dir in "$STATE_DIR"/*/; do
      [ -d "$dir" ] || continue
      local other; other="$(basename "$dir")"
      [ "$other" = "$slug" ] && continue
      local other_port other_domain
      other_port="$(env_value "$other" SERVER_PORT_HOST)"
      other_domain="$(env_value "$other" CUSTOMER_DOMAIN)"
      [ "$other_port" = "$port" ] && \
        die "Port $port is already used by deployment '$other'."
      [ -n "$other_domain" ] && [ "$other_domain" = "$domain" ] && \
        die "Domain $domain is already used by deployment '$other'."
    done
  fi

  # Something else on the host may hold the port too.
  if port_in_use "$port"; then
    die "Port $port is already in use on this host."
  fi

  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    if docker volume ls --format '{{.Name}}' 2>/dev/null | grep -q "^$(project_for "$slug")_"; then
      die "Docker volumes for project $(project_for "$slug") already exist. Remove them deliberately, or choose another slug."
    fi
  fi
}

# --------------------------------------------------------------- secrets ----
# Generated locally, written 0600, never printed.
gen_secret() { openssl rand -hex 32; }

# ------------------------------------------------------------- provision ----
cmd_provision() {
  local slug="${1:-}"; shift || true
  [ -n "$slug" ] || die "Usage: operator.sh provision <slug> --domain <domain> --port <port> [--name \"Customer Name\"]"
  validate_slug "$slug"

  local domain="" port="" display_name="" memory_limit="8G"
  while [ $# -gt 0 ]; do
    case "$1" in
      --domain) domain="${2:-}"; shift 2 ;;
      --port)   port="${2:-}";   shift 2 ;;
      --name)   display_name="${2:-}"; shift 2 ;;
      --memory) memory_limit="${2:-}"; shift 2 ;;
      *) shift ;;
    esac
  done

  [ -n "$domain" ] || die "--domain is required."
  [ -n "$port" ]   || die "--port is required."
  validate_domain "$domain"
  validate_port "$port"
  assert_no_collisions "$slug" "$port" "$domain"

  local dir env_file
  dir="$(deployment_dir "$slug")"
  env_file="$(env_file_for "$slug")"
  display_name="${display_name:-$slug}"

  c_info "Provisioning '$slug'"
  c_info "  domain : $domain"
  c_info "  port   : 127.0.0.1:$port"
  c_info "  project: $(project_for "$slug")"
  c_info "  state  : $dir"

  run mkdir -p "$dir/backups"
  if [ "$DRY_RUN" = "1" ]; then
    printf '\033[2m  would write %s (0600) with freshly generated secrets\033[0m\n' "$env_file"
  else
    umask 077
    cat > "$env_file" <<ENVEOF
# Deployment configuration for $display_name ($slug)
# Generated $(date -u +%Y-%m-%dT%H:%M:%SZ). NEVER COMMIT THIS FILE.

NODE_ENV=production
SERVER_PORT=3001
# The host port this deployment binds on loopback.
SERVER_PORT_HOST=$port
STORAGE_DIR=/app/server/storage
DATABASE_URL=file:/app/server/storage/anythingllm.db
COLLECTOR_HOTDIR=/app/collector/hotdir

# --- identity ---------------------------------------------------------------
# Immutable. Stamped into every Stripe object this deployment creates and
# required to bind it to a Stripe customer. Never change it.
DEPLOYMENT_ID=$(gen_secret)

JWT_SECRET=$(gen_secret)
SIG_KEY=$(gen_secret)
SIG_SALT=$(gen_secret)
HEALTHCHECK_TOKEN=$(gen_secret)

PUBLIC_URL=https://$domain
PRIMARY_DOMAIN=$domain
CUSTOMER_DOMAIN=$domain
CUSTOMER_NAME=$display_name
COMPANY_NAME=$display_name
APP_NAME=$display_name AI
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
STRIPE_SECRET_KEY=
STRIPE_PUBLISHABLE_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_ID=
STRIPE_PRODUCT_ID=
STRIPE_CUSTOMER_PORTAL_CONFIGURATION_ID=
STRIPE_CUSTOMER_ID=
STRIPE_SUBSCRIPTION_ID=
BILLING_ENFORCEMENT_ENABLED=false
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
ENVEOF
    chmod 600 "$env_file"
  fi

  # The reverse-proxy configuration this customer's domain needs.
  if [ "$DRY_RUN" != "1" ]; then
    write_proxy_config "$slug" "$domain" "$port"
  else
    printf '\033[2m  would write %s/caddy.conf and %s/nginx.conf\033[0m\n' "$dir" "$dir"
  fi

  # Verify what was just written before telling the operator it is ready.
  if [ "$DRY_RUN" != "1" ]; then
    echo
    cmd_check "$slug" || die "Provisioning wrote a configuration that does not pass its own checks."
    echo
  fi

  c_ok "Provisioned '$slug'."
  echo
  c_info "Next steps:"
  echo "  1. Edit $env_file and fill in SUPPORT_EMAIL, the AI provider key and the Stripe values."
  echo "  2. Install the reverse-proxy config: $dir/caddy.conf (or nginx.conf)."
  echo "  3. Start it:   ./scripts/operator.sh update $slug"
  echo "  4. Check it:   ./scripts/operator.sh status $slug"
  echo
  c_warn "$env_file contains secrets and is excluded from git. Back it up somewhere safe."
}

write_proxy_config() {
  local slug="$1" domain="$2" port="$3"
  local dir; dir="$(deployment_dir "$slug")"

  cat > "$dir/caddy.conf" <<CADDYEOF
# Reverse proxy for $domain -> 127.0.0.1:$port
# Caddy obtains and renews the certificate automatically.
$domain {
    encode gzip

    reverse_proxy 127.0.0.1:$port {
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
CADDYEOF

  cat > "$dir/nginx.conf" <<NGINXEOF
# Reverse proxy for $domain -> 127.0.0.1:$port
server {
    listen 443 ssl http2;
    server_name $domain;

    ssl_certificate     /etc/letsencrypt/live/$domain/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$domain/privkey.pem;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options nosniff always;

    client_max_body_size 3G;

    location / {
        proxy_pass http://127.0.0.1:$port;
        proxy_http_version 1.1;

        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-Host  \$host;

        proxy_set_header Upgrade    \$http_upgrade;
        proxy_set_header Connection "upgrade";

        # Streaming chat: without this, replies arrive all at once.
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 600s;
    }
}

server {
    listen 80;
    server_name $domain;
    return 301 https://\$host\$request_uri;
}
NGINXEOF
  c_info "Wrote reverse-proxy configs to $dir/"
}

# ---------------------------------------------------------------- compose ---
compose_env() {
  local slug="$1"
  export COMPOSE_PROJECT_NAME="$(project_for "$slug")"
  export CUSTOMER_SLUG="$slug"
  export ENV_FILE="$(env_file_for "$slug")"
  export HOST_PORT="$(env_value "$slug" SERVER_PORT_HOST)"
  export CUSTOMER_DOMAIN="$(env_value "$slug" CUSTOMER_DOMAIN)"
  export BACKUP_PATH="$(deployment_dir "$slug")/backups"
  [ -n "$HOST_PORT" ] || die "Deployment '$slug' has no SERVER_PORT_HOST in its env file."
}

compose() {
  local slug="$1"; shift
  compose_env "$slug"
  run docker compose -f "$COMPOSE_FILE" "$@"
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "Docker is not installed on this host."
  docker info >/dev/null 2>&1 || die "The Docker daemon is not reachable."
}

# ------------------------------------------------------------ preflight -----
cmd_check() {
  local slug="$1"
  require_deployment "$slug"
  local env_file; env_file="$(env_file_for "$slug")"
  local problems=0

  c_info "Checking '$slug'"

  local perms; perms="$(stat -c '%a' "$env_file" 2>/dev/null || echo '???')"
  if [ "$perms" = "600" ]; then
    c_ok "  env file permissions: $perms"
  else
    c_err "  env file permissions are $perms; they must be 600"
    problems=$((problems + 1))
  fi

  for key in DEPLOYMENT_ID JWT_SECRET SIG_KEY SIG_SALT; do
    local value; value="$(env_value "$slug" "$key")"
    if [ -z "$value" ]; then
      c_err "  $key is empty"
      problems=$((problems + 1))
    elif [ "${#value}" -lt 24 ]; then
      c_err "  $key is too short to be unguessable"
      problems=$((problems + 1))
    else
      # Length only; the value itself is never printed.
      c_ok "  $key is set (${#value} chars)"
    fi
  done

  local domain port
  domain="$(env_value "$slug" CUSTOMER_DOMAIN)"
  port="$(env_value "$slug" SERVER_PORT_HOST)"
  [ -n "$domain" ] && validate_domain "$domain" && c_ok "  domain: $domain"
  [ -n "$port" ] && validate_port "$port" && c_ok "  host port: $port"

  if [ -z "$(env_value "$slug" STRIPE_SECRET_KEY)" ]; then
    c_warn "  Stripe is not configured yet (billing disabled)"
  fi
  if [ -z "$(env_value "$slug" OPEN_AI_KEY)$(env_value "$slug" ANTHROPIC_API_KEY)" ]; then
    c_warn "  No AI provider key set yet"
  fi

  [ "$problems" -eq 0 ] && c_ok "Configuration checks passed." || \
    die "$problems configuration problem(s) found."
}

# -------------------------------------------------------------- lifecycle ---
cmd_update() {
  local slug="$1"
  require_deployment "$slug"
  require_docker
  cmd_check "$slug"

  c_info "Backing up before updating…"
  cmd_backup "$slug" || c_warn "Backup did not complete; continuing is your call."

  c_info "Building and starting '$slug'…"
  compose "$slug" up -d --build || die "Start failed."

  c_info "Waiting for health…"
  wait_healthy "$slug" || die "'$slug' did not become healthy. Logs: ./scripts/operator.sh logs $slug"
  c_ok "'$slug' is up and healthy."
}

wait_healthy() {
  local slug="$1"
  [ "$DRY_RUN" = "1" ] && return 0
  local port; port="$(env_value "$slug" SERVER_PORT_HOST)"
  for _ in $(seq 1 120); do
    curl -fsS "http://127.0.0.1:$port/api/ping" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

cmd_status() {
  local slug="${1:-}"
  if [ -z "$slug" ]; then cmd_list; return; fi
  require_deployment "$slug"

  local port domain project
  port="$(env_value "$slug" SERVER_PORT_HOST)"
  domain="$(env_value "$slug" CUSTOMER_DOMAIN)"
  project="$(project_for "$slug")"

  echo
  printf '\033[1m%s\033[0m\n' "$slug"
  echo "  domain      : ${domain:-unset}"
  echo "  host port   : ${port:-unset}"
  echo "  project     : $project"
  echo "  state dir   : $(deployment_dir "$slug")"

  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    local running
    running="$(docker compose -p "$project" -f "$COMPOSE_FILE" ps --format '{{.Service}} {{.State}}' 2>/dev/null | head -5)"
    echo "  containers  : ${running:-not running}"
  else
    echo "  containers  : (Docker unavailable)"
  fi

  if [ -n "$port" ] && curl -fsS "http://127.0.0.1:$port/api/ping" >/dev/null 2>&1; then
    printf '  application : \033[32mresponding\033[0m\n'
    local token; token="$(env_value "$slug" HEALTHCHECK_TOKEN)"
    local probe
    probe="$(curl -fsS -H "X-Health-Token: $token" "http://127.0.0.1:$port/api/platform/health/probe" 2>/dev/null)"
    [ -n "$probe" ] && echo "  health      : $probe"
  else
    printf '  application : \033[31mnot responding\033[0m\n'
  fi

  local latest
  latest="$(ls -t "$(deployment_dir "$slug")/backups"/*.tar.gz 2>/dev/null | head -1)"
  echo "  last backup : ${latest:-none}"
  echo
}

cmd_list() {
  [ -d "$STATE_DIR" ] || { c_info "No deployments yet. Provision one with: ./scripts/operator.sh provision <slug> --domain <domain> --port <port>"; return; }
  printf '\033[1m%-20s %-34s %-8s %s\033[0m\n' "CUSTOMER" "DOMAIN" "PORT" "APPLICATION"
  for dir in "$STATE_DIR"/*/; do
    [ -d "$dir" ] || continue
    local slug; slug="$(basename "$dir")"
    local port domain state
    port="$(env_value "$slug" SERVER_PORT_HOST)"
    domain="$(env_value "$slug" CUSTOMER_DOMAIN)"
    if [ -n "$port" ] && curl -fsS "http://127.0.0.1:$port/api/ping" >/dev/null 2>&1; then
      state=$'\033[32mup\033[0m'
    else
      state=$'\033[31mdown\033[0m'
    fi
    printf '%-20s %-34s %-8s %b\n' "$slug" "${domain:-unset}" "${port:-unset}" "$state"
  done
}

cmd_backup() {
  local slug="$1"
  require_deployment "$slug"
  local dir; dir="$(deployment_dir "$slug")"

  # Back up from the running container's volume when Docker is available,
  # otherwise from a local storage path if one is configured.
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    local project; project="$(project_for "$slug")"
    local volume="${project}_platform-storage"
    if docker volume inspect "$volume" >/dev/null 2>&1; then
      local stamp; stamp="$(date -u +%Y%m%dT%H%M%SZ)"
      local archive="$dir/backups/backup-$stamp.tar.gz"
      c_info "Backing up volume $volume -> $archive"
      run mkdir -p "$dir/backups"
      run docker run --rm \
        -v "$volume":/data:ro \
        -v "$dir/backups":/backup \
        alpine:3 sh -c "tar -czf /backup/backup-$stamp.tar.gz -C /data ." \
        || { c_err "Volume backup failed."; return 1; }
      # It contains customer documents and the database.
      [ "$DRY_RUN" = "1" ] || chmod 600 "$archive" 2>/dev/null
      c_ok "Backup written: $archive"
      return 0
    fi
    c_warn "No storage volume for '$slug' yet; nothing to back up."
    return 0
  fi

  # No Docker on this host. A deployment can still be backed up if its storage
  # lives on the host filesystem and the env file says where.
  local host_storage; host_storage="$(env_value "$slug" HOST_STORAGE_DIR)"
  if [ -n "$host_storage" ] && [ -d "$host_storage" ]; then
    c_info "Docker unavailable; backing up host storage $host_storage"
    run env STORAGE_DIR="$host_storage" \
      BACKUP_ENV_FILES="$(env_file_for "$slug")" \
      "$ROOT/scripts/backup.sh" "$dir/backups"
    return $?
  fi
  c_err "Cannot back up '$slug': Docker is unavailable and no HOST_STORAGE_DIR is set in $(env_file_for "$slug")."
  c_err "Start Docker, or add HOST_STORAGE_DIR=<path to this customer's storage> and retry."
  return 1
}

# Restores the newest backup into a THROWAWAY location and checks it is
# readable. It never touches the live deployment.
cmd_restore_test() {
  local slug="$1"
  require_deployment "$slug"
  local dir; dir="$(deployment_dir "$slug")"
  local archive; archive="$(ls -t "$dir/backups"/*.tar.gz 2>/dev/null | head -1)"
  [ -n "$archive" ] || die "No backup to test for '$slug'. Run: ./scripts/operator.sh backup $slug"

  local target; target="$(mktemp -d -t restore-test-XXXXXX)"
  c_info "Restore test for '$slug'"
  c_info "  archive: $archive"
  c_info "  target : $target (throwaway; the live deployment is untouched)"

  if [ "$DRY_RUN" = "1" ]; then
    printf '\033[2m  would extract and verify the archive\033[0m\n'
    rm -rf "$target"
    return 0
  fi

  tar -xzf "$archive" -C "$target" || { rm -rf "$target"; die "Archive could not be extracted."; }

  local problems=0
  if [ -f "$target/anythingllm.db" ]; then
    local size; size="$(stat -c %s "$target/anythingllm.db")"
    if [ "$size" -gt 1024 ]; then
      c_ok "  database present (${size} bytes)"
    else
      c_err "  database file looks empty"; problems=$((problems+1))
    fi
  else
    c_err "  no database in the archive"; problems=$((problems+1))
  fi

  for expected in documents lancedb; do
    [ -d "$target/$expected" ] && c_ok "  $expected present" || c_warn "  $expected not in the archive"
  done

  rm -rf "$target"
  [ "$problems" -eq 0 ] && c_ok "Restore test passed." || die "Restore test found $problems problem(s)."
}

cmd_suspend() {
  local slug="$1"
  require_deployment "$slug"
  require_docker
  c_info "Suspending '$slug' (data is retained; nothing is deleted)…"
  compose "$slug" stop || die "Suspend failed."
  c_ok "'$slug' is suspended. Resume with: ./scripts/operator.sh resume $slug"
}

cmd_resume() {
  local slug="$1"
  require_deployment "$slug"
  require_docker
  c_info "Resuming '$slug'…"
  compose "$slug" start || die "Resume failed."
  wait_healthy "$slug" && c_ok "'$slug' is up." || c_warn "'$slug' started but is not responding yet."
}

cmd_logs() {
  local slug="$1"
  require_deployment "$slug"
  require_docker
  compose "$slug" logs --tail 200 -f
}

# Removes the CONTAINERS for a deployment. Volumes and backups are kept, so no
# customer data is destroyed. Requires typing the slug to confirm.
cmd_remove_containers() {
  local slug="$1"
  require_deployment "$slug"
  require_docker

  c_warn "This stops and removes the CONTAINERS for '$slug'."
  c_warn "Storage volumes, backups and the env file are KEPT. No customer data is deleted."
  printf 'Type the customer slug to confirm: '
  read -r confirmation
  [ "$confirmation" = "$slug" ] || die "Confirmation did not match. Nothing was changed."

  compose "$slug" down || die "Removal failed."
  c_ok "Containers for '$slug' removed. Data volumes and backups are intact."
}

usage() {
  cat <<USAGE
Operator CLI for dedicated customer deployments.

  provision <slug> --domain <domain> --port <port> [--name "Customer Name"]
                        Create a deployment: generate secrets, write the env
                        file (0600) and produce the reverse-proxy config.
  check <slug>          Validate configuration, secrets and file permissions.
  update <slug>         Back up, then build and start; waits for health.
  status [slug]         Show one deployment, or list all when omitted.
  list                  List every deployment on this host.
  backup <slug>         Back up this customer's storage volume.
  restore-test <slug>   Restore the newest backup into a throwaway directory
                        and verify it. The live deployment is untouched.
  suspend <slug>        Stop the containers. Data is retained.
  resume <slug>         Start them again.
  logs <slug>           Follow the logs.
  remove-containers <slug>
                        Stop and remove containers only. Volumes, backups and
                        the env file are kept. Requires typed confirmation.

Global:
  --dry-run             Print what would happen and change nothing.

There is no automatic customer-data deletion command, by design.
USAGE
}

# ------------------------------------------------------------------ main ----
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) ARGS+=("$arg") ;;
  esac
done
set -- "${ARGS[@]:-}"

[ "$DRY_RUN" = "1" ] && c_warn "DRY RUN - nothing will be changed."

COMMAND="${1:-}"; shift || true
case "$COMMAND" in
  provision)          cmd_provision "$@" ;;
  check)              [ -n "${1:-}" ] || die "Usage: operator.sh check <slug>"; cmd_check "$1" ;;
  update)             [ -n "${1:-}" ] || die "Usage: operator.sh update <slug>"; cmd_update "$1" ;;
  status)             cmd_status "${1:-}" ;;
  list)               cmd_list ;;
  backup)             [ -n "${1:-}" ] || die "Usage: operator.sh backup <slug>"; cmd_backup "$1" ;;
  restore-test)       [ -n "${1:-}" ] || die "Usage: operator.sh restore-test <slug>"; cmd_restore_test "$1" ;;
  suspend)            [ -n "${1:-}" ] || die "Usage: operator.sh suspend <slug>"; cmd_suspend "$1" ;;
  resume)             [ -n "${1:-}" ] || die "Usage: operator.sh resume <slug>"; cmd_resume "$1" ;;
  logs)               [ -n "${1:-}" ] || die "Usage: operator.sh logs <slug>"; cmd_logs "$1" ;;
  remove-containers)  [ -n "${1:-}" ] || die "Usage: operator.sh remove-containers <slug>"; cmd_remove_containers "$1" ;;
  ""|help|-h|--help)  usage ;;
  *) die "Unknown command '$COMMAND'. Run: ./scripts/operator.sh help" ;;
esac
