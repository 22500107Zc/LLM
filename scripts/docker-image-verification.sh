#!/usr/bin/env bash
#
# Builds and boots the ACTUAL production Docker image and verifies a real
# deployment works inside it.
#
#   ./scripts/docker-image-verification.sh
#
# What it checks, in the container, not on the host:
#   1. docker/Dockerfile builds
#   2. the container boots and refuses anonymous access before setup
#   3. first-run owner creation
#   4. the owner can sign in
#   5. a document uploads, parses and embeds
#   6. provider configuration from the env file reaches the application
#   7. the chat route answers (generation needs a provider key; without one it
#      is reported BLOCKED, never passed)
#   8. the health probe reports ready
#   9. data survives a container restart
#
# Everything runs in a throwaway Compose project on a loopback port and is torn
# down at the end, volumes included. It never touches a customer deployment.
#
# Optional:
#   OPEN_AI_KEY=sk-...   also verifies generated answers end to end
#   KEEP=1               leave the environment up for inspection
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
RESULTS_DIR="$ROOT/test-results/docker-$STAMP"
mkdir -p "$RESULTS_DIR"

PASS=0
FAIL=0
BLOCK=0

log()   { printf '\033[36m[docker-verify]\033[0m %s\n' "$*"; }
ok()    { printf '\033[32mPASS\033[0m    %s\n' "$*"; PASS=$((PASS + 1)); }
bad()   { printf '\033[31mFAIL\033[0m    %s\n' "$*"; FAIL=$((FAIL + 1)); }
block() { printf '\033[33mBLOCKED\033[0m %s\n' "$*"; BLOCK=$((BLOCK + 1)); }
die()   { printf '\033[31m[docker-verify]\033[0m %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------- prerequisites ------
if ! command -v docker >/dev/null 2>&1; then
  echo
  echo "BLOCKED: DOCKER HOST REQUIRED"
  echo "  The docker CLI is not installed on this machine."
  echo
  echo "  On a machine with Docker Engine, run:"
  echo "    ./scripts/docker-image-verification.sh"
  echo
  echo "  Nothing was verified. This is not a pass."
  exit 2
fi

if ! docker info >/dev/null 2>&1; then
  echo
  echo "BLOCKED: DOCKER HOST REQUIRED"
  echo "  The docker CLI is present but no daemon is reachable."
  echo "  ($(docker info 2>&1 | head -1))"
  echo
  echo "  On a machine with a running Docker Engine, run:"
  echo "    ./scripts/docker-image-verification.sh"
  echo
  echo "  Nothing was verified. This is not a pass."
  exit 2
fi

# --------------------------------------------------------- environment ------
PROJECT="dockerverify$(date -u +%s)"
WORK_DIR="$(mktemp -d -t docker-verify-XXXXXX)"
ENV_FILE="$WORK_DIR/.env"
PORT="${PORT:-$(( (RANDOM % 10000) + 40000 ))}"
BASE_URL="http://127.0.0.1:$PORT"

compose() {
  COMPOSE_PROJECT_NAME="$PROJECT" \
  CUSTOMER_SLUG="$PROJECT" \
  HOST_PORT="$PORT" \
  ENV_FILE="$ENV_FILE" \
  CUSTOMER_DOMAIN="verify.example.invalid" \
  BACKUP_PATH="$WORK_DIR/backups" \
    docker compose -p "$PROJECT" -f "$ROOT/docker/docker-compose.production.yml" "$@"
}

teardown() {
  local code=$?
  if [ "${KEEP:-0}" = "1" ]; then
    log "KEEP=1 — leaving $PROJECT up at $BASE_URL"
    return
  fi
  log "Tearing down $PROJECT…"
  compose down -v >/dev/null 2>&1
  rm -rf "$WORK_DIR"
  exit $code
}
trap teardown EXIT INT TERM

gen() { openssl rand -hex 32; }
HEALTH_TOKEN="$(gen)"
OWNER_USER="verify-owner"
OWNER_PASSWORD="Tt1!$(openssl rand -base64 24 | tr -d '/+=')"
PROVIDER_MARKER="marker-$(openssl rand -hex 6)"

mkdir -p "$WORK_DIR/backups"
cat > "$ENV_FILE" <<ENVEOF
NODE_ENV=production
SERVER_PORT=3001
JWT_SECRET=$(gen)
SIG_KEY=$(gen)
SIG_SALT=$(gen)
DEPLOYMENT_ID=$(gen)
HEALTHCHECK_TOKEN=$HEALTH_TOKEN
APP_NAME=Docker Verification Deployment
COMPANY_NAME=Docker Verification Co
PRIMARY_DOMAIN=verify.example.invalid
SUPPORT_EMAIL=support@verify.example.invalid
PUBLIC_URL=$BASE_URL
REQUIRE_MULTI_USER_MODE=true
EMBED_REQUIRE_ALLOWLIST=true
DISABLE_TELEMETRY=true
BILLING_ENFORCEMENT_ENABLED=false
PLAN_AMOUNT_CENTS=388888
VECTOR_DB=lancedb
EMBEDDING_ENGINE=native
LLM_PROVIDER=openai
OPEN_AI_KEY=${OPEN_AI_KEY:-}
OPEN_MODEL_PREF=gpt-4o
OPEN_AI_ORGANIZATION=$PROVIDER_MARKER
ENVEOF
chmod 600 "$ENV_FILE"

log "Project : $PROJECT"
log "Base URL: $BASE_URL"
log "Logs    : $RESULTS_DIR"

# ------------------------------------------------------------ 1. build ------
log "Building the production image (this takes a while)…"
if compose build > "$RESULTS_DIR/build.log" 2>&1; then
  ok "docker/Dockerfile builds"
else
  bad "the production image did not build — see $RESULTS_DIR/build.log"
  tail -20 "$RESULTS_DIR/build.log"
  exit 1
fi

# ------------------------------------------------------------- 2. boot ------
log "Starting the container…"
if compose up -d > "$RESULTS_DIR/up.log" 2>&1; then
  ok "the container starts"
else
  bad "the container did not start — see $RESULTS_DIR/up.log"
  exit 1
fi

log "Waiting for it to answer…"
READY=0
for _ in $(seq 1 180); do
  curl -fsS "$BASE_URL/api/ping" >/dev/null 2>&1 && { READY=1; break; }
  sleep 1
done
if [ "$READY" = "1" ]; then
  ok "the application answers inside the container"
else
  bad "the application never answered"
  compose logs --tail 40 > "$RESULTS_DIR/container.log" 2>&1
  tail -20 "$RESULTS_DIR/container.log"
  exit 1
fi

# --------------------------------------- 3. production guard before setup ---
GUARD="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/api/workspaces")"
[ "$GUARD" = "401" ] \
  && ok "anonymous access is refused before setup (HTTP 401)" \
  || bad "anonymous access was NOT refused (HTTP $GUARD)"

# ------------------------------------------------- 4. first-run owner -------
SETUP="$(curl -sS -o "$WORK_DIR/setup.json" -w '%{http_code}' \
  -X POST "$BASE_URL/api/system/enable-multi-user" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$OWNER_USER\",\"password\":\"$OWNER_PASSWORD\"}")"
if [ "$SETUP" = "200" ] && grep -q '"success":true' "$WORK_DIR/setup.json"; then
  ok "first-run owner account is created"
else
  bad "first-run owner creation failed (HTTP $SETUP)"
fi

# ----------------------------------------------------------- 5. login -------
TOKEN="$(curl -sS -X POST "$BASE_URL/api/request-token" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$OWNER_USER\",\"password\":\"$OWNER_PASSWORD\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token") or "")' 2>/dev/null)"
if [ -n "$TOKEN" ]; then
  ok "the owner can sign in"
else
  bad "sign-in failed"
  exit 1
fi
auth() { curl -sS -H "Authorization: Bearer $TOKEN" "$@"; }

# ------------------------------- 6. provider configuration reaches the app ---
SETTINGS="$(auth "$BASE_URL/api/business/settings")"
if printf '%s' "$SETTINGS" | grep -q "Docker Verification"; then
  ok "the deployment's env file reached the application"
else
  bad "the application did not pick up its env file"
fi

# The marker proves a provider-specific value crossed into the container
# rather than only the branding. It is read back through the container itself.
CONTAINER="$(compose ps -q platform | head -1)"
if [ -n "$CONTAINER" ] && \
   docker exec "$CONTAINER" printenv OPEN_AI_ORGANIZATION 2>/dev/null | grep -q "$PROVIDER_MARKER"; then
  ok "provider configuration reaches the container's environment"
else
  bad "provider configuration did not reach the container"
fi

# ------------------------------------------------- 7. workspace + upload -----
WS="$(auth -X POST "$BASE_URL/api/workspace/new" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Docker Verification"}' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print((d.get("workspace") or {}).get("slug") or "")' 2>/dev/null)"
[ -n "$WS" ] && ok "a workspace can be created" || bad "workspace creation failed"

FIXTURE="$WORK_DIR/policy.txt"
printf 'Acme Corporation Refund Policy\n\nCustomers may request a refund within 30 days of purchase.\nRefunds are issued to the original payment method.\n' > "$FIXTURE"

UPLOAD="$(auth -X POST "$BASE_URL/api/workspace/$WS/upload" -F "file=@$FIXTURE" 2>/dev/null)"
if printf '%s' "$UPLOAD" | grep -q '"success":[[:space:]]*true'; then
  ok "a document uploads, parses and embeds inside the container"
else
  bad "document upload failed: $(printf '%s' "$UPLOAD" | head -c 160)"
fi

# ------------------------------------------------------------- 8. chat ------
if [ -n "${OPEN_AI_KEY:-}" ]; then
  CHAT="$(auth -X POST "$BASE_URL/api/workspace/$WS/chat" \
    -H 'Content-Type: application/json' \
    -d '{"message":"How long do I have to request a refund?","mode":"query"}' 2>/dev/null)"
  if printf '%s' "$CHAT" | grep -qi "30 days"; then
    ok "the chat route answers from the uploaded document"
  else
    bad "chat did not answer from the document: $(printf '%s' "$CHAT" | head -c 160)"
  fi
else
  block "generated chat answers — no OPEN_AI_KEY, so no provider to answer with"
  echo "        Re-run with: OPEN_AI_KEY=sk-... ./scripts/docker-image-verification.sh"
fi

# ----------------------------------------------------------- 9. health ------
PROBE="$(curl -sS -H "X-Health-Token: $HEALTH_TOKEN" \
  "$BASE_URL/api/platform/health/probe" 2>/dev/null)"
if [ -n "$PROBE" ] && ! printf '%s' "$PROBE" | grep -qi '"\(fail\|unhealthy\)"'; then
  ok "the health probe reports ready"
else
  bad "the health probe did not report ready: $(printf '%s' "$PROBE" | head -c 160)"
fi

# --------------------------------------------- 10. restart persistence ------
BEFORE="$(auth "$BASE_URL/api/workspaces" \
  | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("workspaces") or []))' 2>/dev/null)"

log "Restarting the container…"
compose restart >> "$RESULTS_DIR/up.log" 2>&1
for _ in $(seq 1 180); do
  curl -fsS "$BASE_URL/api/ping" >/dev/null 2>&1 && break
  sleep 1
done

TOKEN="$(curl -sS -X POST "$BASE_URL/api/request-token" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$OWNER_USER\",\"password\":\"$OWNER_PASSWORD\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token") or "")' 2>/dev/null)"
AFTER="$(auth "$BASE_URL/api/workspaces" \
  | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("workspaces") or []))' 2>/dev/null)"

if [ -n "$BEFORE" ] && [ "$BEFORE" = "$AFTER" ] && [ -n "$TOKEN" ]; then
  ok "data and accounts survive a container restart ($BEFORE workspace(s), sign-in still works)"
else
  bad "restart persistence failed (before=$BEFORE after=$AFTER)"
fi

compose logs --tail 200 > "$RESULTS_DIR/container.log" 2>&1

echo
echo "=================================================================="
echo "DOCKER IMAGE VERIFICATION: $PASS passed, $FAIL failed, $BLOCK blocked"
echo "Evidence: $RESULTS_DIR"
echo "=================================================================="
[ "$FAIL" -eq 0 ]
