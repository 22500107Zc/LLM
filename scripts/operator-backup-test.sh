#!/usr/bin/env bash
# Exercises the corrected backup-before-update gating in isolation, with a
# stubbed docker so no daemon is needed.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$(mktemp -d -t op-test-XXXXXX)"
export PLATFORM_STATE_DIR="$SCRATCH/deployments"
STUB="$SCRATCH/bin"; mkdir -p "$STUB"
PASS=0; FAIL=0
ok()   { printf '\033[32mPASS\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '\033[31mFAIL\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected '$3', got '$2')"; fi; }

# --- docker stub: behaviour driven by files in $SCRATCH --------------------
cat > "$STUB/docker" <<'STUBEOF'
#!/usr/bin/env bash
S="$OP_TEST_SCRATCH"
case "$1" in
  info) exit 0 ;;
  volume)
    # `volume inspect <name>` succeeds only when the fixture says the volume exists.
    [ "$2" = "inspect" ] && { [ -f "$S/volume-exists" ] && exit 0 || exit 1; }
    exit 0 ;;
  run)
    # has_customer_data probes for a non-empty database.
    case "$*" in
      *"[ -s /data/anythingllm.db ]"*)
        [ -f "$S/has-data" ] && exit 0 || exit 1 ;;
      *"cp -a /data/."*)
        # The snapshot step. Fails when the fixture asks it to.
        [ -f "$S/snapshot-fails" ] && { echo "snapshot failed" >&2; exit 1; }
        staging=$(printf '%s\n' "$@" | grep -oE '[^ ]+:/staging' | cut -d: -f1)
        mkdir -p "$staging/payload"
        printf 'SQLite format 3\000' > "$staging/payload/anythingllm.db"
        mkdir -p "$staging/payload/documents" "$staging/payload/lancedb"
        exit 0 ;;
    esac
    exit 0 ;;
  compose)
    echo "compose ${*:2}" >> "$S/compose.log"
    case "$*" in
      *" up "*) [ -f "$S/build-should-not-run" ] && { echo "BUILD RAN" >> "$S/violation.log"; } ;;
    esac
    exit 0 ;;
esac
exit 0
STUBEOF
chmod +x "$STUB/docker"
export OP_TEST_SCRATCH="$SCRATCH"
export PATH="$STUB:$PATH"

cd "$ROOT"
./scripts/operator.sh provision acme --domain acme.example.com --port 3901 >/dev/null 2>&1

echo "=== 1. A brand-new deployment with no data may start without a backup ==="
rm -f "$SCRATCH"/volume-exists "$SCRATCH"/has-data "$SCRATCH"/compose.log
# The stub serves no HTTP, so the health wait is expected to fail at the end.
# What matters here is that the update REACHED the build without a backup.
out="$(./scripts/operator.sh update acme 2>&1)"
printf '%s' "$out" | grep -q "first start, so no backup is needed" \
  && ok "it says why no backup was taken" || bad "no first-start explanation"
grep -q "up -d --build" "$SCRATCH/compose.log" && ok "it proceeded to build and start" || bad "container not started"

echo
echo "=== 2. An existing deployment whose backup FAILS must not update ==="
touch "$SCRATCH/volume-exists" "$SCRATCH/has-data" "$SCRATCH/snapshot-fails"
rm -f "$SCRATCH/compose.log" "$SCRATCH/violation.log"
touch "$SCRATCH/build-should-not-run"
out="$(./scripts/operator.sh update acme 2>&1)"; code=$?
check "update STOPS when the backup fails" "$code" "1"
printf '%s' "$out" | grep -q "stopped before touching anything" \
  && ok "it says the update stopped" || bad "no stop message"
printf '%s' "$out" | grep -q "data is untouched" \
  && ok "it says the data is untouched" || bad "no reassurance message"
[ -f "$SCRATCH/violation.log" ] && bad "IT REBUILT ANYWAY" || ok "no rebuild happened"

echo
echo "=== 3. --skip-backup lets the operator override, explicitly ==="
rm -f "$SCRATCH/compose.log" "$SCRATCH/violation.log" "$SCRATCH/build-should-not-run"
out="$(./scripts/operator.sh update acme --skip-backup 2>&1)"
printf '%s' "$out" | grep -q "WITHOUT a backup" && ok "it warns loudly" || bad "no warning"
grep -q "up -d --build" "$SCRATCH/compose.log" && ok "it proceeded past the failed backup" || bad "did not proceed"

echo
echo "=== 4. A successful backup contains data AND configuration ==="
rm -f "$SCRATCH/snapshot-fails"
./scripts/operator.sh backup acme >/dev/null 2>&1
archive="$(ls -t "$PLATFORM_STATE_DIR/acme/backups"/*.tar.gz 2>/dev/null | head -1)"
if [ -n "$archive" ]; then
  ok "an archive was written"
  contents="$(tar -tzf "$archive")"
  printf '%s' "$contents" | grep -q "anythingllm.db" && ok "database is in the archive" || bad "no database"
  printf '%s' "$contents" | grep -q "config/acme.env" && ok "deployment .env is in the archive" || bad "no .env — the docs promise one"
  printf '%s' "$contents" | grep -q "MANIFEST.json" && ok "manifest is in the archive" || bad "no manifest"
  check "archive is 0600" "$(stat -c %a "$archive")" "600"
  # Consistency: the customer was paused and restarted around the snapshot.
  grep -q "compose .* stop" "$SCRATCH/compose.log" && ok "the customer was paused for consistency" || bad "no quiesce"
  grep -q "compose .* start" "$SCRATCH/compose.log" && ok "the customer was started again" || bad "not restarted"
else
  bad "no archive was written"
fi

echo
echo "=== 5. --online skips the pause and says so in the manifest ==="
rm -f "$SCRATCH/compose.log"
./scripts/operator.sh backup acme --online >/dev/null 2>&1
archive="$(ls -t "$PLATFORM_STATE_DIR/acme/backups"/*.tar.gz | head -1)"
manifest="$(tar -xzOf "$archive" ./MANIFEST.json 2>/dev/null || tar -xzOf "$archive" MANIFEST.json 2>/dev/null)"
printf '%s' "$manifest" | grep -q "online-copy" && ok "manifest records it as an online copy" || bad "manifest does not say online"
grep -q "compose .* stop" "$SCRATCH/compose.log" 2>/dev/null && bad "it paused anyway" || ok "no pause with --online"

echo
echo "=== 6. The live storage is never the restore-test target ==="
out="$(./scripts/operator.sh restore-test acme 2>&1)"
printf '%s' "$out" | grep -q "throwaway" && ok "restore-test targets a throwaway directory" || bad "no throwaway target"

rm -rf "$SCRATCH"
echo
echo "=================================================="
echo "OPERATOR BACKUP/UPDATE: $PASS passed, $FAIL failed"
echo "=================================================="
[ "$FAIL" -eq 0 ]
