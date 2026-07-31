#!/usr/bin/env bash
#
# restore-db.sh -- Restore a dump produced by backup-db.sh.
#
# A backup nobody can restore is a backup nobody has. This is the other half.
#
# Usage:
#   ./deploy/restore-db.sh backups/nexuscentral_20260730-210400.sql.gz
#   ./deploy/restore-db.sh backups/nexuscentral_...sql.gz.gpg        # prompts for the passphrase
#   ./deploy/restore-db.sh --check backups/nexuscentral_...sql.gz    # verify only, restore nothing
#
# The restore DROPs and recreates the schema. It asks for confirmation first,
# because there is no undo and the argument is easy to get wrong.
set -euo pipefail

CHECK_ONLY=0
FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) CHECK_ONLY=1; shift ;;
    -*) echo "Unknown option: $1" >&2; exit 2 ;;
    *) FILE="$1"; shift ;;
  esac
done

[[ -n "$FILE" ]] || { echo "Usage: $0 [--check] <dump file>" >&2; exit 2; }
[[ -f "$FILE" ]] || { echo "No such file: $FILE" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${NEXUSCENTRAL_APP_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ENV_FILE="$APP_DIR/.env"

env_get() {
  [ -f "$ENV_FILE" ] || return 0
  local v
  v="$(grep -E "^${1}=" "$ENV_FILE" | tail -n1 | cut -d= -f2-)"
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}

DB_USER="${POSTGRES_USER:-$(env_get POSTGRES_USER)}"; DB_USER="${DB_USER:-nexuscentral}"
DB_NAME="${POSTGRES_DB:-$(env_get POSTGRES_DB)}"; DB_NAME="${DB_NAME:-nexuscentral}"
PASS_FILE="${NEXUSCENTRAL_BACKUP_PASSPHRASE_FILE:-$(env_get NEXUSCENTRAL_BACKUP_PASSPHRASE_FILE)}"

COMPOSE=(-f docker-compose.yml)
[[ -f "$APP_DIR/docker-compose.vps.yml" ]] && COMPOSE+=(-f docker-compose.vps.yml)

cd "$APP_DIR"

# Decrypt if needed, decompress, and hand plain SQL to the caller.
stream() {
  if [[ "$FILE" == *.gpg ]]; then
    if [[ -n "$PASS_FILE" ]]; then
      gpg --batch --quiet --decrypt --passphrase-file "$PASS_FILE" "$FILE"
    else
      gpg --quiet --decrypt "$FILE"
    fi | gunzip
  else
    gunzip -c "$FILE"
  fi
}

# Read the first few KB through a command substitution rather than piping into
# `head` directly: `head` closing the pipe early makes gunzip exit on SIGPIPE,
# and under `pipefail` that reads as a corrupt dump when the file is fine.
HEAD_BYTES="$( { stream 2>/dev/null || true; } | head -c 4096 || true)"

if ! printf '%s' "$HEAD_BYTES" | grep -q 'PostgreSQL database dump'; then
  echo "That file does not look like a pg_dump. Refusing to restore it." >&2
  exit 1
fi

TABLES="$( { stream 2>/dev/null || true; } | grep -c '^CREATE TABLE' || true)"

if [[ "$CHECK_ONLY" == 1 ]]; then
  echo "OK: readable dump, ${TABLES} CREATE TABLE statements."
  exit 0
fi

cat <<EOF
About to restore into the running database:

  file    $FILE
  tables  $TABLES
  target  $DB_NAME (user $DB_USER)

Everything currently in $DB_NAME is dropped and replaced. There is no undo.
EOF

read -r -p "Type the database name to confirm: " CONFIRM
[[ "$CONFIRM" == "$DB_NAME" ]] || { echo "Aborted."; exit 1; }

# The API holds connections and would fight the restore; stop it first.
echo "[restore] Stopping api…"
docker compose "${COMPOSE[@]}" stop api >/dev/null

echo "[restore] Dropping and recreating the schema…"
docker compose "${COMPOSE[@]}" exec -T postgres \
  psql -q -U "$DB_USER" -d "$DB_NAME" \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'

echo "[restore] Loading the dump…"
stream | docker compose "${COMPOSE[@]}" exec -T postgres psql -q -U "$DB_USER" -d "$DB_NAME"

echo "[restore] Starting api…"
docker compose "${COMPOSE[@]}" start api >/dev/null

echo "[restore] Waiting for health…"
for _ in $(seq 1 30); do
  # 127.0.0.1, not localhost -- see the note in deploy.sh.
  if docker compose "${COMPOSE[@]}" exec -T web wget -qO- http://127.0.0.1/api/health 2>/dev/null \
      | grep -q '"status":"ok"'; then
    echo "[restore] ✅ Restored from $FILE"
    exit 0
  fi
  sleep 2
done

echo "[restore] Restored, but the API is not reporting healthy. Check: docker compose logs api" >&2
exit 1
