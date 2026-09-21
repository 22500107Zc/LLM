#!/usr/bin/env bash
#
# Restores a deployment from an archive produced by scripts/backup.sh.
#
# Usage:
#   scripts/restore.sh <archive.tar.gz> [--force] [--target <storage-dir>]
#
# The restore refuses to overwrite a non-empty storage directory unless
# --force is given, so a mistyped command cannot destroy a live deployment.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCHIVE="${1:-}"
FORCE=0
TARGET="${STORAGE_DIR:-$ROOT/server/storage}"

shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --target) TARGET="$2"; shift 2 ;;
    *) shift ;;
  esac
done

log() { printf '\033[36m[restore]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[restore] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ -n "$ARCHIVE" ] || fail "Usage: scripts/restore.sh <archive.tar.gz> [--force] [--target <dir>]"
[ -f "$ARCHIVE" ] || fail "Archive not found: $ARCHIVE"

STAGING="$(mktemp -d)"
cleanup() { rm -rf "$STAGING"; }
trap cleanup EXIT

log "Archive: $ARCHIVE"
log "Target:  $TARGET"

tar -xzf "$ARCHIVE" -C "$STAGING"

[ -f "$STAGING/MANIFEST.json" ] || fail "This does not look like a platform backup (no MANIFEST.json)."
log "Manifest:"
cat "$STAGING/MANIFEST.json"

# Refuse to clobber a live deployment by accident.
if [ -d "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ] && [ "$FORCE" -ne 1 ]; then
  fail "Target storage directory is not empty. Re-run with --force to overwrite it."
fi

if [ -d "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
  SAFETY="$TARGET.pre-restore.$(date -u +%Y%m%dT%H%M%SZ)"
  log "Moving existing storage aside to $SAFETY"
  mv "$TARGET" "$SAFETY"
fi

mkdir -p "$TARGET"

# ---- database --------------------------------------------------------------
if [ -f "$STAGING/database.sql" ]; then
  [ -n "${DATABASE_URL:-}" ] || fail "This backup holds a PostgreSQL dump; set DATABASE_URL before restoring."
  command -v psql >/dev/null 2>&1 || fail "psql is required to restore PostgreSQL."
  log "Restoring PostgreSQL database…"
  psql "$DATABASE_URL" < "$STAGING/database.sql"
elif [ -f "$STAGING/anythingllm.db" ]; then
  log "Restoring SQLite database…"
  cp "$STAGING/anythingllm.db" "$TARGET/anythingllm.db"
  [ -f "$STAGING/anythingllm.db-wal" ] && cp "$STAGING/anythingllm.db-wal" "$TARGET/"
  [ -f "$STAGING/anythingllm.db-shm" ] && cp "$STAGING/anythingllm.db-shm" "$TARGET/"
fi

# ---- documents, vectors and keys -------------------------------------------
for DIR in documents vector-cache lancedb comkey plugins; do
  if [ -e "$STAGING/$DIR" ]; then
    log "Restoring $DIR…"
    cp -R "$STAGING/$DIR" "$TARGET/$DIR"
  fi
done

# ---- configuration ---------------------------------------------------------
if [ -d "$STAGING/config" ]; then
  log "Configuration files are included in this archive but are NOT applied"
  log "automatically, so a restore cannot silently change a running"
  log "deployment's secrets. Review and copy them yourself:"
  for FILE in "$STAGING/config"/*; do
    cp "$FILE" "$TARGET/restored-$(basename "$FILE")"
    log "  -> $TARGET/restored-$(basename "$FILE")"
  done
fi

# The Prisma SQLite datasource URL is fixed in schema.prisma (it points at
# server/storage), so `migrate deploy` only ever targets the default location.
# Running it against a --target restore would migrate the WRONG database, so
# it is skipped and the operator is told what to do.
DEFAULT_STORAGE="$ROOT/server/storage"
if [ "$(cd "$TARGET" && pwd)" = "$(cd "$DEFAULT_STORAGE" 2>/dev/null && pwd || echo '')" ]; then
  log "Running database migrations…"
  (cd "$ROOT/server" && npx prisma migrate deploy) || \
    log "WARNING: migrations did not complete. Run 'npx prisma migrate deploy' in server/ manually."
else
  log "Restored to a non-default location, so migrations were NOT run."
  log "To bring this data into a live deployment, restore to $DEFAULT_STORAGE"
  log "(or point the deployment's STORAGE_DIR at $TARGET) and then run:"
  log "  cd server && npx prisma migrate deploy"
fi

log "Restore complete. Restart the application to pick up the restored data."
