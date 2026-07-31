#!/usr/bin/env bash
#
# backup-db.sh -- Compressed PostgreSQL dump, with rotation.
#
# Same design as the mtg-collector script: optional AES256 encryption, optional
# off-machine copy, optional dead-man's-switch.
#
# Usage:
#   ./deploy/backup-db.sh                       # a dated dump
#   ./deploy/backup-db.sh --label predeploy-ab12 # tagged, used by deploy.sh
#   ./deploy/backup-db.sh --quiet               # print only the dump path
#
#   Daily, from cron:
#   0 4 * * * /opt/apps/nexuscentral/deploy/backup-db.sh >> /var/log/nexuscentral-backup.log 2>&1
#
# Variables (environment > .env > default):
#   NEXUSCENTRAL_APP_DIR                 (default: the repository this script sits in)
#   NEXUSCENTRAL_BACKUP_DIR              (default <app dir>/backups)
#   NEXUSCENTRAL_BACKUP_KEEP             (default 14) dumps kept
#   NEXUSCENTRAL_BACKUP_PASSPHRASE_FILE  chmod 600 file holding the passphrase
#   NEXUSCENTRAL_BACKUP_PASSPHRASE       passphrase in the clear (prefer the file)
#     -> with either set, the dump is AES256-encrypted (gpg) as .sql.gz.gpg
#   NEXUSCENTRAL_RCLONE_REMOTE           rclone target, e.g. gdrive:nexuscentral-backups
#     -> a dump that only exists on the VPS does not survive losing the VPS
#   NEXUSCENTRAL_HEALTHCHECK_URL         pinged on start/success/failure, so a backup
#                                   that quietly stops running raises an alert
set -euo pipefail

LABEL=""
QUIET=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --label) LABEL="${2:?--label needs a value}"; shift 2 ;;
    --quiet) QUIET=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { [[ "$QUIET" == 1 ]] || echo "[backup] $*"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${NEXUSCENTRAL_APP_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ENV_FILE="$APP_DIR/.env"

# Reads a key from .env WITHOUT sourcing it: the file holds bcrypt hashes and
# passwords that `source` would either mangle or execute.
env_get() {
  [ -f "$ENV_FILE" ] || return 0
  local v
  v="$(grep -E "^${1}=" "$ENV_FILE" | tail -n1 | cut -d= -f2-)"
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}

BACKUP_DIR="${NEXUSCENTRAL_BACKUP_DIR:-$(env_get NEXUSCENTRAL_BACKUP_DIR)}"; BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
KEEP="${NEXUSCENTRAL_BACKUP_KEEP:-$(env_get NEXUSCENTRAL_BACKUP_KEEP)}"; KEEP="${KEEP:-14}"
PASS_FILE="${NEXUSCENTRAL_BACKUP_PASSPHRASE_FILE:-$(env_get NEXUSCENTRAL_BACKUP_PASSPHRASE_FILE)}"
PASS="${NEXUSCENTRAL_BACKUP_PASSPHRASE:-$(env_get NEXUSCENTRAL_BACKUP_PASSPHRASE)}"
DB_USER="${POSTGRES_USER:-$(env_get POSTGRES_USER)}"; DB_USER="${DB_USER:-nexuscentral}"
DB_NAME="${POSTGRES_DB:-$(env_get POSTGRES_DB)}"; DB_NAME="${DB_NAME:-nexuscentral}"

# The VPS runs the Traefik overlay; a plain `docker compose` here would not see it.
COMPOSE=(-f docker-compose.yml)
[[ -f "$APP_DIR/docker-compose.vps.yml" ]] && COMPOSE+=(-f docker-compose.vps.yml)

HC="${NEXUSCENTRAL_HEALTHCHECK_URL:-$(env_get NEXUSCENTRAL_HEALTHCHECK_URL)}"
hc_ping() {
  [ -n "$HC" ] && command -v curl >/dev/null 2>&1 \
    && curl -fsS -m 10 --retry 2 -o /dev/null "${HC%/}${1:-}" || true
}
SUCCESS=0
trap '[ "$SUCCESS" = 1 ] || hc_ping /fail' EXIT
hc_ping /start

mkdir -p "$BACKUP_DIR"
cd "$APP_DIR"

ts="$(date +%Y%m%d-%H%M%S)"
name="nexuscentral_${LABEL:+${LABEL}_}${ts}"

ENCRYPT=0
if [ -n "$PASS_FILE" ] || [ -n "$PASS" ]; then
  command -v gpg >/dev/null || { echo "[backup] FAILED: gpg is required for encryption" >&2; exit 1; }
  ENCRYPT=1
fi

if [ "$ENCRYPT" -eq 1 ]; then
  file="$BACKUP_DIR/${name}.sql.gz.gpg"
  say "pg_dump -> gzip -> gpg(AES256) -> $file"
  if [ -n "$PASS_FILE" ]; then
    GPG_PASS=(--passphrase-file "$PASS_FILE")
  else
    GPG_PASS=(--passphrase "$PASS")
  fi
  docker compose "${COMPOSE[@]}" exec -T postgres pg_dump -U "$DB_USER" "$DB_NAME" \
    | gzip \
    | gpg --batch --yes --symmetric --cipher-algo AES256 "${GPG_PASS[@]}" -o "$file"
else
  file="$BACKUP_DIR/${name}.sql.gz"
  say "pg_dump -> gzip -> $file  (NOT encrypted -- set NEXUSCENTRAL_BACKUP_PASSPHRASE_FILE)"
  docker compose "${COMPOSE[@]}" exec -T postgres pg_dump -U "$DB_USER" "$DB_NAME" | gzip > "$file"
fi

# An empty dump is worse than none: it looks like a backup and restores nothing.
if [ ! -s "$file" ]; then
  echo "[backup] FAILED: empty dump" >&2
  rm -f "$file"
  exit 1
fi

# gzip of an empty pg_dump is still ~100 bytes of header, so size alone is not
# proof. Check the dump actually contains a schema.
#
# The first bytes go through a command substitution rather than straight into
# `head`: `head` closing the pipe kills gzip with SIGPIPE, and under `pipefail`
# a perfectly good dump would be deleted as corrupt.
if [ "$ENCRYPT" -eq 0 ]; then
  HEAD_BYTES="$( { gzip -cd "$file" 2>/dev/null || true; } | head -c 4096 || true)"
  if ! printf '%s' "$HEAD_BYTES" | grep -q 'PostgreSQL database dump'; then
    echo "[backup] FAILED: the dump does not look like a pg_dump" >&2
    rm -f "$file"
    exit 1
  fi
fi

# Rotation: keep the KEEP most recent. Pre-deploy dumps rotate with the rest --
# they are a safety net for the deploy in progress, not an archive.
ls -1t "$BACKUP_DIR"/nexuscentral_*.sql.gz* 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f

REMOTE="${NEXUSCENTRAL_RCLONE_REMOTE:-$(env_get NEXUSCENTRAL_RCLONE_REMOTE)}"
if [ -n "$REMOTE" ]; then
  if command -v rclone >/dev/null 2>&1; then
    say "rclone copy -> $REMOTE"
    rclone copy "$file" "$REMOTE"
    rclone delete "$REMOTE" --min-age "${KEEP}d" --include "nexuscentral_*" 2>/dev/null || true
  else
    echo "[backup] NEXUSCENTRAL_RCLONE_REMOTE is set but rclone is missing -- no off-machine copy" >&2
  fi
else
  say "(off-machine copy disabled: NEXUSCENTRAL_RCLONE_REMOTE unset)"
fi

say "OK ($(du -h "$file" | cut -f1)). Restore with:  ./deploy/restore-db.sh $file"

SUCCESS=1
hc_ping

# The path on stdout is the script's return value, so deploy.sh can capture it.
[[ "$QUIET" == 1 ]] && echo "$file"
exit 0
