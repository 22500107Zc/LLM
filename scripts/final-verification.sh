#!/usr/bin/env bash
#
# Runs every release gate and records the output.
#
#   ./scripts/final-verification.sh
#
# Everything lands in test-results/<UTC timestamp>/ - one log per gate plus a
# summary table. That directory is excluded from Git and from the runtime
# image; it is evidence, not product.
#
# A gate is PASS, FAIL, or BLOCKED. BLOCKED means an external credential or a
# facility this machine does not have (a Docker daemon, a model provider key,
# Stripe test keys). A BLOCKED gate is never reported as passing.
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$ROOT/test-results/$STAMP"
mkdir -p "$OUT"

RESULTS="$OUT/results.tsv"
: > "$RESULTS"

log()  { printf '\033[36m[verify]\033[0m %s\n' "$*"; }
pass() { printf '\033[32mPASS\033[0m    %s\n' "$1"; printf 'PASS\t%s\t%s\n' "$1" "${2:-}" >> "$RESULTS"; }
fail() { printf '\033[31mFAIL\033[0m    %s\n' "$1"; printf 'FAIL\t%s\t%s\n' "$1" "${2:-}" >> "$RESULTS"; }
block(){ printf '\033[33mBLOCKED\033[0m %s — %s\n' "$1" "${2:-}"; printf 'BLOCKED\t%s\t%s\n' "$1" "${2:-}" >> "$RESULTS"; }

# Runs a command, tees it to a log, and records the gate from its exit code.
gate() {
  local name="$1" logfile="$2"; shift 2
  log "$name"
  if "$@" > "$OUT/$logfile" 2>&1; then
    pass "$name" "$logfile"
  else
    fail "$name" "$logfile"
  fi
}

echo "Final verification $STAMP"
echo "Commit: $(git -C "$ROOT" rev-parse HEAD)"
echo "Output: $OUT"
echo

# ---------------------------------------------------------------- tree ------
gate "git diff --check (whitespace)" "git-diff-check.log" \
  git -C "$ROOT" diff --check

# ---------------------------------------------------------------- lint ------
for ws in server frontend collector; do
  gate "$ws lint" "lint-$ws.log" bash -c "cd '$ROOT/$ws' && yarn lint:check"
done

# --------------------------------------------------------------- build ------
gate "frontend production build" "frontend-build.log" \
  bash -c "cd '$ROOT/frontend' && yarn build"

# --------------------------------------------------------------- tests ------
log "unit tests"
if (cd "$ROOT" && npx jest 2>&1) > "$OUT/unit-tests.log"; then
  pass "unit tests" "unit-tests.log"
else
  # The ffmpeg tests need a binary this machine does not ship. They are only
  # excusable if the untouched upstream baseline fails them identically.
  # The only tolerated failures are the ffmpeg ones, and only because the
  # untouched upstream baseline gate below proves they are not ours.
  OTHER="$(grep -oE '● [^›]+ › .*' "$OUT/unit-tests.log" | sort -u | grep -vc 'FFMPEGWrapper' || true)"
  TOTAL_LINE="$(grep -E '^Tests:' "$OUT/unit-tests.log" | tail -1)"
  if [ "${OTHER:-1}" = "0" ]; then
    fail "unit tests — $TOTAL_LINE (ffmpeg only; see the baseline gate)" "unit-tests.log"
  else
    fail "unit tests — $TOTAL_LINE ($OTHER non-ffmpeg failure(s))" "unit-tests.log"
  fi
fi

# ------------------------------------------------ ffmpeg upstream baseline --
log "ffmpeg failures reproduced on the untouched upstream baseline"
BASELINE="$(mktemp -d -t upstream-baseline-XXXXXX)"
if git -C "$ROOT" worktree add -q --detach "$BASELINE" origin/master 2>>"$OUT/ffmpeg-baseline.log"; then
  ln -sfn "$ROOT/collector/node_modules" "$BASELINE/collector/node_modules"
  ln -sfn "$ROOT/server/node_modules" "$BASELINE/server/node_modules"
  (cd "$BASELINE" && npx jest collector/__tests__/utils/WhisperProviders 2>&1) \
    >> "$OUT/ffmpeg-baseline.log"
  # Jest prints each failing test twice (once in the run, once in the summary),
  # so count DISTINCT test names or the two sides never agree.
  count_ffmpeg() {
    grep -oE '● FFMPEGWrapper › .*' "$1" 2>/dev/null | sort -u | wc -l
  }
  OURS="$(count_ffmpeg "$OUT/unit-tests.log")"
  THEIRS="$(count_ffmpeg "$OUT/ffmpeg-baseline.log")"
  {
    echo
    echo "Baseline commit: $(git -C "$BASELINE" rev-parse HEAD) (origin/master, untouched upstream)"
    echo "Distinct FFMPEGWrapper failures in this branch : $OURS"
    echo "Distinct FFMPEGWrapper failures in the baseline: $THEIRS"
    echo
    echo "This branch:"
    grep -oE '● FFMPEGWrapper › .*' "$OUT/unit-tests.log" 2>/dev/null | sort -u | sed 's/^/  /'
    echo "Untouched upstream:"
    grep -oE '● FFMPEGWrapper › .*' "$OUT/ffmpeg-baseline.log" 2>/dev/null | sort -u | sed 's/^/  /'
    echo
    echo "The ffmpeg code and its tests are byte-identical to upstream:"
    git -C "$ROOT" diff --stat origin/master HEAD -- \
      collector/utils/WhisperProviders collector/__tests__/utils/WhisperProviders \
      | tail -1 || echo "  (no differences)"
  } >> "$OUT/ffmpeg-baseline.log"
  if [ "$THEIRS" -gt 0 ] && [ "$OURS" = "$THEIRS" ]; then
    pass "ffmpeg failures are pre-existing (identical on untouched upstream)" "ffmpeg-baseline.log"
  else
    fail "ffmpeg failures are NOT reproduced on upstream ($OURS here, $THEIRS there)" "ffmpeg-baseline.log"
  fi
  git -C "$ROOT" worktree remove --force "$BASELINE" 2>/dev/null
else
  block "ffmpeg upstream baseline" "could not create an upstream worktree"
fi

# ------------------------------------------------ business + stripe tests ---
gate "business logic, billing, Stripe binding and value tests" "business-tests.log" \
  bash -c "cd '$ROOT/server' && npx jest __tests__/business --verbose"

gate "AI quality adversarial grading tests" "grading-tests.log" \
  bash -c "cd '$ROOT/server' && npx jest __tests__/business/answerGrading.test.js --verbose"

# -------------------------------------------------------- Stripe test mode --
if [ -n "${STRIPE_SECRET_KEY:-}" ]; then
  gate "Stripe test-mode lifecycle" "stripe-e2e.log" \
    node "$ROOT/scripts/stripe-test-mode-verification.cjs"
else
  block "Stripe test-mode lifecycle" "STRIPE_SECRET_KEY (test mode) required"
fi

# ------------------------------------------------ production dependency audit
log "production dependency audit"
AUDIT_FAIL=0
for ws in server frontend collector; do
  (cd "$ROOT/$ws" && yarn audit --groups dependencies --json) > "$OUT/audit-$ws.json" 2>/dev/null
  SUMMARY="$(tail -1 "$OUT/audit-$ws.json")"
  CRIT="$(printf '%s' "$SUMMARY" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["vulnerabilities"]["critical"])' 2>/dev/null || echo "?")"
  HIGH="$(printf '%s' "$SUMMARY" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["vulnerabilities"]["high"])' 2>/dev/null || echo "?")"
  echo "$ws: critical=$CRIT high=$HIGH" >> "$OUT/audit-summary.log"
  [ "$CRIT" != "0" ] && AUDIT_FAIL=1
done
cat "$OUT/audit-summary.log"
if [ "$AUDIT_FAIL" = "0" ]; then
  pass "zero critical advisories in production dependencies" "audit-summary.log"
else
  fail "critical advisories remain in production dependencies" "audit-summary.log"
fi

# ---------------------------------------------------- compose config check --
log "Docker Compose configuration"
if command -v docker >/dev/null 2>&1; then
  if COMPOSE_PROJECT_NAME=platform-verify CUSTOMER_SLUG=verify HOST_PORT=3999 \
     ENV_FILE="$ROOT/docker/.env.production.example" CUSTOMER_DOMAIN=verify.example.com \
     BACKUP_PATH=/tmp/verify-backups \
     docker compose -f "$ROOT/docker/docker-compose.production.yml" config \
       > "$OUT/compose-config.log" 2>&1; then
    # It must also refuse to resolve when a required variable is absent.
    if env -u HOST_PORT COMPOSE_PROJECT_NAME=platform-verify CUSTOMER_SLUG=verify \
         ENV_FILE="$ROOT/docker/.env.production.example" \
         docker compose -f "$ROOT/docker/docker-compose.production.yml" config \
         >> "$OUT/compose-config.log" 2>&1; then
      fail "Compose resolves without a required variable" "compose-config.log"
    else
      pass "Compose config resolves, and fails loudly when a variable is missing" "compose-config.log"
    fi
  else
    fail "Docker Compose configuration" "compose-config.log"
  fi
else
  block "Docker Compose configuration" "docker CLI not available"
fi

# ----------------------------------------- fresh container boot (needs docker)
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  gate "fresh container boot" "container-boot.log" \
    bash -c "MODE=docker '$ROOT/scripts/run-disposable-acceptance.sh'"
else
  block "fresh container boot" "no Docker daemon on this machine"
fi

# ------------------------------------- live deployment: every runtime gate ---
log "disposable live deployment (acceptance, documents, restart, backup, visual)"
if VISUAL=1 "$ROOT/scripts/run-disposable-acceptance.sh" > "$OUT/disposable.log" 2>&1; then
  RUN_DIR="$(grep -oE "$ROOT/test-results/[0-9TZ]+" "$OUT/disposable.log" | tail -1)"
  [ -n "$RUN_DIR" ] && cp -R "$RUN_DIR" "$OUT/live-run" 2>/dev/null
  # "<passed>/<total> passed" counts as a pass only when the two are equal.
  all_of() {
    local line="$1"
    printf '%s' "$line" | python3 -c '
import re, sys
m = re.search(r"(\d+)/(\d+) passed", sys.stdin.read())
sys.exit(0 if m and m.group(1) == m.group(2) else 1)
'
  }

  ACC_LINE="$(grep -E "^ACCEPTANCE: " "$OUT/disposable.log" | tail -1)"
  all_of "$ACC_LINE" \
    && pass "acceptance suite (live deployment) — $ACC_LINE" "disposable.log" \
    || fail "acceptance suite (live deployment) — ${ACC_LINE:-no result}" "disposable.log"

  DOC_LINE="$(grep -E "^DOCUMENT PIPELINE: " "$OUT/disposable.log" | tail -1)"
  all_of "$DOC_LINE" \
    && pass "document pipeline, PDF/DOCX/PPTX end to end — $DOC_LINE" "disposable.log" \
    || fail "document pipeline — ${DOC_LINE:-no result}" "disposable.log"
  grep -q "PASS restart persistence" "$OUT/disposable.log" \
    && pass "restart persistence" "disposable.log" \
    || fail "restart persistence" "disposable.log"
  grep -q "PASS backup and restore into a clean target" "$OUT/disposable.log" \
    && pass "backup and restore into a clean target" "disposable.log" \
    || fail "backup and restore into a clean target" "disposable.log"
  if grep -q "^VISUAL CHECK:" "$OUT/disposable.log"; then
    VIS="$(grep "^VISUAL CHECK:" "$OUT/disposable.log" | tail -1)"
    all_of "$VIS" \
      && pass "desktop and mobile visual check of 9 pages — $VIS" "disposable.log" \
      || fail "desktop and mobile visual check — $VIS" "disposable.log"
  else
    block "desktop and mobile visual check" "browser or built frontend unavailable"
  fi
  grep -q "BLOCKED: PROVIDER CREDENTIAL REQUIRED" "$OUT/disposable.log" \
    && block "provider-backed answer verification" "model provider API key required" \
    || pass "provider-backed answer verification" "disposable.log"
else
  fail "disposable live deployment" "disposable.log"
fi

# -------------------------------------------------------------- searches ----
log "searching for customer-visible upstream branding"
# Some upstream names are load-bearing identifiers, not branding: a database
# filename, a storage key, a model id, a hosted model CDN, a package name, an
# API host. Renaming them would break the product without hiding anything from
# a customer. They are excluded here, and each one is listed in
# FINAL_ACCEPTANCE.md so the exclusion is visible rather than silent.
KEEP='anythingllm\.db|ANYTHING_LLM_RUNTIME|anythingllm-router|anythingllm_authToken|anythingllm_user|anythingllm_completed_questionnaire|hub\.external\.anythingllm\.com|hub\.anythingllm\.com|cdn\.anythingllm\.com|MintplexLabs/|mintplexlabs/piper|Mintplex-Labs/epub2-static|@mintplex-labs/'
{
  grep -rn "AnythingLLM\|Mintplex\|anythingllm\.com" \
    --include="*.js" --include="*.jsx" --include="*.json" --include="*.html" \
    --include="*.css" --include="*.webmanifest" \
    "$ROOT/frontend/src" "$ROOT/frontend/public" "$ROOT/frontend/index.html" \
    "$ROOT/server" "$ROOT/collector" 2>/dev/null \
  | grep -v node_modules | grep -v "/dist/" \
  | grep -v "__tests__" \
  | grep -vE "$KEEP" \
  | grep -vE ':[0-9]+: *(\*|//|#)'
} > "$OUT/branding-search.log" 2>&1
HITS="$(wc -l < "$OUT/branding-search.log")"
if [ "$HITS" = "0" ]; then
  pass "no customer-visible upstream branding in source" "branding-search.log"
else
  fail "$HITS upstream branding reference(s) remain" "branding-search.log"
fi

log "searching for hardcoded developer paths"
# A path inside a comment is documentation, not a hardcoded path, and this
# script necessarily contains the patterns it searches for.
grep -rn "/home/user/\|/Users/\|C:\\\\Users" \
  --include="*.js" --include="*.jsx" --include="*.cjs" --include="*.sh" --include="*.yml" \
  "$ROOT/scripts" "$ROOT/server/business" "$ROOT/docker" "$ROOT/frontend/src" 2>/dev/null \
  | grep -v node_modules \
  | grep -v "final-verification.sh" \
  | grep -vE ':[0-9]+: *(\*|//|#)' > "$OUT/hardcoded-paths.log" 2>&1
PATHS="$(wc -l < "$OUT/hardcoded-paths.log")"
[ "$PATHS" = "0" ] \
  && pass "no hardcoded developer paths" "hardcoded-paths.log" \
  || fail "$PATHS hardcoded developer path(s)" "hardcoded-paths.log"

log "searching for fixed test credentials"
grep -rniE "password\s*[:=]\s*[\"'][^\"'\$][^\"']{3,}[\"']" \
  --include="*.js" --include="*.cjs" --include="*.sh" \
  "$ROOT/scripts" 2>/dev/null \
  | grep -v node_modules | grep -v "SEED_PASSWORD\|DOC_TEST_PASSWORD\|ACCEPTANCE_SEED_PASSWORD" \
  > "$OUT/fixed-credentials.log" 2>&1
CREDS="$(wc -l < "$OUT/fixed-credentials.log")"
[ "$CREDS" = "0" ] \
  && pass "no fixed credentials in the test scripts" "fixed-credentials.log" \
  || fail "$CREDS fixed credential(s) in the test scripts" "fixed-credentials.log"

gate "committed-secret scan (tree and history)" "secret-scan.log" \
  node "$ROOT/scripts/secret-scan.cjs" --history

# --------------------------------------------------------------- summary ----
{
  echo "# Final verification — $STAMP"
  echo
  echo "Commit: \`$(git -C "$ROOT" rev-parse HEAD)\`"
  echo
  echo "| Result | Gate | Evidence |"
  echo "| --- | --- | --- |"
  while IFS=$'\t' read -r status name evidence; do
    echo "| **$status** | $name | \`$evidence\` |"
  done < "$RESULTS"
  echo
  echo "Passed:  $(grep -c '^PASS' "$RESULTS")"
  echo "Failed:  $(grep -c '^FAIL' "$RESULTS")"
  echo "Blocked: $(grep -c '^BLOCKED' "$RESULTS")"
} > "$OUT/summary.md"

echo
cat "$OUT/summary.md"
echo
log "Evidence: $OUT"

[ "$(grep -c '^FAIL' "$RESULTS")" = "0" ]
