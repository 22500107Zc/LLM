#!/usr/bin/env bash
#
# Creates a consistent, restorable backup of a deployment.
#
# What is backed up:
#   - the application database (SQLite file, or a pg_dump for PostgreSQL)
#   - uploaded and parsed documents
#   - vector data
#   - the deployment's configuration (.env), with secrets included, so the
#     archive must be treated as sensitive
#
# What is deliberately excluded: model caches, temp files and hot-directory
# scratch, which are large and rebuild themselves.
#
# Usage:
#   scripts/backup.sh [output-directory]
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORAGE_DIR="${STORAGE_DIR:-$ROOT/server/storage}"
BACKUP_DIR="${1:-${BACKUP_DIR:-$ROOT/backups}}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
STAGING="$(mktemp -d)"
ARCHIVE="$BACKUP_DIR/backup-$TIMESTAMP.tar.gz"

cleanup() { rm -rf "$STAGING"; }
trap cleanup EXIT

log() { printf '\033[36m[backup]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[backup] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ -d "$STORAGE_DIR" ] || fail "Storage directory not found: $STORAGE_DIR"
mkdir -p "$BACKUP_DIR"

log "Storage:  $STORAGE_DIR"
log "Output:   $ARCHIVE"

mkdir -p "$STAGING/payload"

# ---- database -------------------------------------------------------------
if [ -n "${DATABASE_URL:-}" ] && [[ "$DATABASE_URL" == postgres* ]]; then
  command -v pg_dump >/dev/null 2>&1 || fail "pg_dump is required to back up PostgreSQL."
  log "Dumping PostgreSQL database…"
  pg_dump "$DATABASE_URL" > "$STAGING/payload/database.sql"
else
  DB_FILE="$STORAGE_DIR/anythingllm.db"
  if [ -f "$DB_FILE" ]; then
    log "Copying SQLite database…"
    if command -v sqlite3 >/dev/null 2>&1; then
      # `.backup` takes a consistent snapshot even while the server is writing.
      sqlite3 "$DB_FILE" ".backup '$STAGING/payload/anythingllm.db'"
    else
      # Without sqlite3 we still capture the WAL so the copy stays usable.
      cp "$DB_FILE" "$STAGING/payload/anythingllm.db"
      [ -f "$DB_FILE-wal" ] && cp "$DB_FILE-wal" "$STAGING/payload/anythingllm.db-wal"
      [ -f "$DB_FILE-shm" ] && cp "$DB_FILE-shm" "$STAGING/payload/anythingllm.db-shm"
      log "WARNING: sqlite3 not installed - copied the database file directly."
    fi
  else
    log "No SQLite database found; skipping."
  fi
fi

# ---- documents, vectors and configuration ---------------------------------
for DIR in documents vector-cache lancedb; do
  if [ -d "$STORAGE_DIR/$DIR" ]; then
    log "Copying $DIR…"
    cp -R "$STORAGE_DIR/$DIR" "$STAGING/payload/$DIR"
  fi
done

# Encryption keys - without these, stored integration secrets cannot be read
# back after a restore.
for FILE in comkey plugins; do
  [ -e "$STORAGE_DIR/$FILE" ] && cp -R "$STORAGE_DIR/$FILE" "$STAGING/payload/$FILE"
done

for ENV_FILE in "$ROOT/server/.env" "$ROOT/docker/.env"; do
  if [ -f "$ENV_FILE" ]; then
    log "Including configuration: $(basename "$(dirname "$ENV_FILE")")/.env"
    mkdir -p "$STAGING/payload/config"
    cp "$ENV_FILE" "$STAGING/payload/config/$(basename "$(dirname "$ENV_FILE")").env"
  fi
done

# ---- manifest --------------------------------------------------------------
cat > "$STAGING/payload/MANIFEST.json" <<JSON
{
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "storageDir": "$STORAGE_DIR",
  "hostname": "$(hostname)",
  "databaseType": "$([ -n "${DATABASE_URL:-}" ] && [[ "${DATABASE_URL:-}" == postgres* ]] && echo postgresql || echo sqlite)",
  "contents": $(cd "$STAGING/payload" && ls -1 | sed 's/.*/"&"/' | paste -sd, - | sed 's/^/[/;s/$/]/')
}
JSON

log "Creating archive…"
tar -czf "$ARCHIVE" -C "$STAGING/payload" .

# The archive contains .env secrets and customer documents.
chmod 600 "$ARCHIVE"

SIZE="$(du -h "$ARCHIVE" | cut -f1)"
log "Done: $ARCHIVE ($SIZE)"
log "This archive contains credentials and customer data. Store it encrypted."

# Record the backup so the health panel can show when it last ran.
if command -v node >/dev/null 2>&1 && [ -f "$ROOT/server/package.json" ]; then
  (cd "$ROOT/server" && STORAGE_DIR="$STORAGE_DIR" node -e "
    const { PlatformSettings } = require('./business/models/platformSettings');
    PlatformSettings.set(PlatformSettings.KEYS.LAST_BACKUP_AT, new Date().toISOString(), { audit: false })
      .then(() => process.exit(0))
      .catch(() => process.exit(0));
  " >/dev/null 2>&1) || true
fi

echo "$ARCHIVE"
