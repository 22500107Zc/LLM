#!/usr/bin/env bash
#
# One command: stand up a DISPOSABLE deployment, run the acceptance and
# document suites against it, save the logs, and tear it down.
#
# Nothing here touches a customer deployment. The environment gets its own
# temporary storage directory, its own generated secrets and its own port, and
# everything is deleted at the end.
#
#   ./scripts/run-disposable-acceptance.sh                 # auto-select mode
#   MODE=docker ./scripts/run-disposable-acceptance.sh     # force containers
#   MODE=local  ./scripts/run-disposable-acceptance.sh     # force local processes
#   KEEP=1      ./scripts/run-disposable-acceptance.sh     # leave it up for inspection
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RESULTS_DIR="${RESULTS_DIR:-$ROOT/test-results/$STAMP}"
WORK_DIR="$(mktemp -d -t platform-acceptance-XXXXXX)"
PORT="${PORT:-$(shuf -i 34000-44000 -n 1 2>/dev/null || echo 34771)}"
BASE_URL="http://localhost:$PORT"
MODE="${MODE:-auto}"
KEEP="${KEEP:-0}"

mkdir -p "$RESULTS_DIR"

log()  { printf '\033[36m[acceptance]\033[0m %s\n' "$*" | tee -a "$RESULTS_DIR/runner.log"; }
warn() { printf '\033[33m[acceptance]\033[0m %s\n' "$*" | tee -a "$RESULTS_DIR/runner.log"; }
err()  { printf '\033[31m[acceptance]\033[0m %s\n' "$*" | tee -a "$RESULTS_DIR/runner.log" >&2; }

SERVER_PID=""
COLLECTOR_PID=""
COMPOSE_PROJECT=""

teardown() {
  local code=$?
  if [ "$KEEP" = "1" ]; then
    warn "KEEP=1 — leaving the environment up at $BASE_URL (storage: $WORK_DIR)"
    return
  fi
  log "Tearing down the disposable environment…"
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  [ -n "$COLLECTOR_PID" ] && kill "$COLLECTOR_PID" 2>/dev/null
  sleep 1
  [ -n "$SERVER_PID" ] && kill -9 "$SERVER_PID" 2>/dev/null
  [ -n "$COLLECTOR_PID" ] && kill -9 "$COLLECTOR_PID" 2>/dev/null
  if [ -n "$COMPOSE_PROJECT" ]; then
    COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT" CUSTOMER_SLUG="$COMPOSE_PROJECT" \
    HOST_PORT="$PORT" ENV_FILE="$WORK_DIR/.env" \
      docker compose -p "$COMPOSE_PROJECT" \
        -f "$ROOT/docker/docker-compose.production.yml" down -v >/dev/null 2>&1
  fi
  # The temporary storage holds only generated fixtures and throwaway secrets.
  rm -rf "$WORK_DIR"
  log "Done. Logs: $RESULTS_DIR"
  exit $code
}
trap teardown EXIT INT TERM

# --- choose a mode ----------------------------------------------------------
docker_available() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

if [ "$MODE" = "auto" ]; then
  if docker_available; then MODE=docker; else MODE=local; fi
fi

if [ "$MODE" = "docker" ] && ! docker_available; then
  err "MODE=docker was requested but the Docker daemon is not reachable."
  exit 2
fi

log "Mode:      $MODE"
log "Base URL:  $BASE_URL"
log "Storage:   $WORK_DIR  (deleted on exit)"
log "Results:   $RESULTS_DIR"

# --- generate throwaway secrets --------------------------------------------
# Written only into the temporary directory, never printed, never committed.
gen() { openssl rand -hex 32; }
HEALTH_TOKEN="$(gen)"
ENV_FILE="$WORK_DIR/.env"

cat > "$ENV_FILE" <<ENVEOF
NODE_ENV=production
SERVER_PORT=$PORT
STORAGE_DIR=$WORK_DIR/storage
COLLECTOR_HOTDIR=$ROOT/collector/hotdir
JWT_SECRET=$(gen)
SIG_KEY=$(gen)
SIG_SALT=$(gen)
DEPLOYMENT_ID=$(gen)
APP_NAME=Disposable Acceptance Deployment
COMPANY_NAME=Acceptance Fixture Co
CUSTOMER_NAME=Acceptance Fixture Co
PRIMARY_DOMAIN=acceptance.example.invalid
SUPPORT_EMAIL=support@acceptance.example.invalid
PUBLIC_URL=$BASE_URL
EMBED_REQUIRE_ALLOWLIST=true
REQUIRE_MULTI_USER_MODE=true
HEALTHCHECK_TOKEN=$HEALTH_TOKEN
DISABLE_TELEMETRY=true
BILLING_ENFORCEMENT_ENABLED=false
PLAN_AMOUNT_CENTS=388888
VECTOR_DB=lancedb
EMBEDDING_ENGINE=native
ENVEOF
chmod 600 "$ENV_FILE"
mkdir -p "$WORK_DIR/storage" "$WORK_DIR/hotdir" "$WORK_DIR/fixtures"

# --- start the environment --------------------------------------------------
if [ "$MODE" = "docker" ]; then
  # A project name of its own, so this throwaway environment can never collide
  # with, or be mistaken for, a customer deployment.
  COMPOSE_PROJECT="acceptance-$(printf '%s' "$STAMP" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9-')"
  log "Building and starting containers (project $COMPOSE_PROJECT)…"
  COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT" CUSTOMER_SLUG="$COMPOSE_PROJECT" \
  HOST_PORT="$PORT" ENV_FILE="$ENV_FILE" CUSTOMER_DOMAIN="acceptance.example.invalid" \
  BACKUP_PATH="$WORK_DIR/backups" \
    docker compose -p "$COMPOSE_PROJECT" \
      -f "$ROOT/docker/docker-compose.production.yml" up -d --build \
      > "$RESULTS_DIR/compose-up.log" 2>&1
  if [ $? -ne 0 ]; then
    err "Container start failed. See $RESULTS_DIR/compose-up.log"
    exit 1
  fi
else
  log "Starting a local disposable server…"
  # The database lives in the temporary storage directory, so the real one is
  # never touched. Prisma's SQLite URL is fixed, so point it at the temp copy.
  ( cd "$ROOT/server" && DATABASE_URL="file:$WORK_DIR/storage/anythingllm.db" \
      npx prisma migrate deploy ) > "$RESULTS_DIR/migrate.log" 2>&1 || \
      warn "migrate deploy reported an issue; see $RESULTS_DIR/migrate.log"
  # Seed the settings rows the application expects on a fresh database.
  ( cd "$ROOT/server" && DATABASE_URL="file:$WORK_DIR/storage/anythingllm.db" \
      node prisma/seed.js ) >> "$RESULTS_DIR/migrate.log" 2>&1 || true

  # Load the generated env without a subshell word-split, so values containing
  # spaces (APP_NAME, COMPANY_NAME) survive intact.
  (
    cd "$ROOT/server"
    set -a
    while IFS='=' read -r key value; do
      case "$key" in ""|\#*) continue ;; esac
      export "$key=$value"
    done < "$ENV_FILE"
    set +a
    export DATABASE_URL="file:$WORK_DIR/storage/anythingllm.db"
    exec node index.js
  ) > "$RESULTS_DIR/server.log" 2>&1 &
  SERVER_PID=$!

  # The collector is started AFTER the server below: it loads the shared
  # signing key at module load, and the server generates that key on boot. A
  # collector started first caches "no key" and silently rejects every upload.
fi

# --- wait for readiness -----------------------------------------------------
log "Waiting for the deployment to answer…"
READY=0
for _ in $(seq 1 120); do
  if curl -fsS "$BASE_URL/api/ping" >/dev/null 2>&1; then READY=1; break; fi
  sleep 1
done
if [ "$READY" != "1" ]; then
  err "The deployment did not become ready. See $RESULTS_DIR/server.log"
  exit 1
fi
log "Deployment is up."

if [ "$MODE" = "local" ]; then
  # A document processor left running from another session would hold the port
  # with a DIFFERENT signing key, so every upload would be rejected with an
  # opaque error. Refuse to run rather than produce a misleading failure.
  if curl -fsS "http://localhost:8888/" >/dev/null 2>&1; then
    err "Port 8888 is already serving a document processor from another session."
    err "Stop it first, or run with MODE=docker for full isolation."
    exit 2
  fi

  # Now that the server has written the shared signing key, start the document
  # processor so it loads the same key.
  mkdir -p "$ROOT/collector/hotdir"
  ( cd "$ROOT/collector" && env NODE_ENV=production \
      STORAGE_DIR="$WORK_DIR/storage" node index.js ) \
      > "$RESULTS_DIR/collector.log" 2>&1 &
  COLLECTOR_PID=$!
  for _ in $(seq 1 60); do
    if curl -fsS "http://localhost:8888/" >/dev/null 2>&1; then break; fi
    sleep 1
  done
  if curl -fsS "http://localhost:8888/" >/dev/null 2>&1; then
    log "Document processor is up."
  else
    warn "Document processor did not start; document tests will report it."
  fi
fi

# --- boot guard check -------------------------------------------------------
# Production mode must refuse anonymous access before setup completes.
GUARD_CODE="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/api/workspaces")"
if [ "$GUARD_CODE" = "401" ]; then
  log "Production auth guard: anonymous access refused (401) — OK"
  echo "PASS production boot guard refuses anonymous access (HTTP 401)" \
    >> "$RESULTS_DIR/boot-guard.log"
else
  err "Production auth guard did NOT refuse anonymous access (HTTP $GUARD_CODE)"
  echo "FAIL production boot guard returned HTTP $GUARD_CODE" \
    >> "$RESULTS_DIR/boot-guard.log"
  OVERALL_FAIL=1
fi

# --- bootstrap one shared administrator -------------------------------------
# Both suites run against the same disposable deployment, so the runner owns
# setup and hands each suite the same throwaway credentials. The password is
# generated here, never printed and never committed.
SEED_USER="disposable-admin"
SEED_PASSWORD="Tt1!$(openssl rand -base64 24 | tr -d '/+=')"

SETUP_CODE="$(curl -sS -o "$WORK_DIR/setup.json" -w '%{http_code}' \
  -X POST "$BASE_URL/api/system/enable-multi-user" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$SEED_USER\",\"password\":\"$SEED_PASSWORD\"}")"
if [ "$SETUP_CODE" = "200" ] && grep -q '"success":true' "$WORK_DIR/setup.json"; then
  log "Bootstrapped the disposable administrator."
else
  err "Could not bootstrap the disposable administrator (HTTP $SETUP_CODE)."
  exit 1
fi

# The guard must now allow authenticated traffic immediately - no stale cache.
GUARD_AFTER="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/api/workspaces")"
if [ "$GUARD_AFTER" = "401" ]; then
  log "Auth guard still refuses anonymous access after setup — OK"
else
  err "Auth guard stopped refusing anonymous access after setup (HTTP $GUARD_AFTER)"
  OVERALL_FAIL=1
fi

# --- run the suites ---------------------------------------------------------
OVERALL_FAIL="${OVERALL_FAIL:-0}"

log "Running the acceptance suite…"
BASE_URL="$BASE_URL" ACCEPTANCE_HEALTH_TOKEN="$HEALTH_TOKEN" \
ACCEPTANCE_EXPECT_APP_NAME="Disposable Acceptance Deployment" \
ACCEPTANCE_SEED_USER="$SEED_USER" ACCEPTANCE_SEED_PASSWORD="$SEED_PASSWORD" \
  node "$ROOT/scripts/acceptance-test.cjs" 2>&1 | tee "$RESULTS_DIR/acceptance.log"
[ "${PIPESTATUS[0]}" -ne 0 ] && OVERALL_FAIL=1

log "Running the document pipeline suite…"
BASE_URL="$BASE_URL" FIXTURE_DIR="$WORK_DIR/fixtures" \
STORAGE_DIR="$WORK_DIR/storage" DATABASE_URL="file:$WORK_DIR/storage/anythingllm.db" \
DOC_TEST_USER="$SEED_USER" DOC_TEST_PASSWORD="$SEED_PASSWORD" \
  node "$ROOT/scripts/document-pipeline-test.cjs" 2>&1 | tee "$RESULTS_DIR/documents.log"
[ "${PIPESTATUS[0]}" -ne 0 ] && OVERALL_FAIL=1

if [ -n "${OPEN_AI_KEY:-}${ANTHROPIC_API_KEY:-}${GEMINI_API_KEY:-}" ]; then
  log "Running provider-backed verification…"
  BASE_URL="$BASE_URL" FIXTURE_DIR="$WORK_DIR/fixtures" \
  STORAGE_DIR="$WORK_DIR/storage" DATABASE_URL="file:$WORK_DIR/storage/anythingllm.db" \
  DOC_TEST_USER="$SEED_USER" DOC_TEST_PASSWORD="$SEED_PASSWORD" \
    node "$ROOT/scripts/provider-verification.cjs" 2>&1 | tee "$RESULTS_DIR/provider.log"
  [ "${PIPESTATUS[0]}" -ne 0 ] && OVERALL_FAIL=1
else
  warn "No model provider key in the environment — skipping provider verification."
  echo "BLOCKED: PROVIDER CREDENTIAL REQUIRED" > "$RESULTS_DIR/provider.log"
fi

# --- summary ----------------------------------------------------------------
{
  echo "# Disposable acceptance run $STAMP"
  echo
  echo "Mode: $MODE"
  echo "Base URL: $BASE_URL"
  echo
  echo "## Acceptance"
  grep -E "^(ACCEPTANCE|[0-9]+ BLOCKED)" "$RESULTS_DIR/acceptance.log" 2>/dev/null | tail -3
  echo
  echo "## Documents"
  grep -E "^DOCUMENT PIPELINE" "$RESULTS_DIR/documents.log" 2>/dev/null | tail -2
  echo
  echo "## Provider verification"
  if grep -q "BLOCKED: PROVIDER CREDENTIAL REQUIRED" "$RESULTS_DIR/provider.log" 2>/dev/null; then
    echo "BLOCKED: PROVIDER CREDENTIAL REQUIRED"
  else
    grep -E "^PROVIDER VERIFICATION" "$RESULTS_DIR/provider.log" 2>/dev/null | tail -2
  fi
} > "$RESULTS_DIR/summary.md"

cat "$RESULTS_DIR/summary.md"

if [ "$OVERALL_FAIL" -ne 0 ]; then
  err "One or more suites failed. See $RESULTS_DIR"
  exit 1
fi
log "All suites passed."
