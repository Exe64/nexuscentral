#!/usr/bin/env bash
#
# deploy.sh -- Deploy nexuscentral on the OVH VPS (existing Traefik + GitHub App auth).
#
# Same model as ntnx-docs and ntnx-mastery -- `/opt/apps/[app]/deploy.sh`:
# GitHub App token -> pull -> build -> up -> backup -> migrate -> health -> prune.
#
# Variables (defaults match the VPS layout):
#   NEXUSCENTRAL_APP_DIR  (default /opt/apps/nexuscentral)
#   NEXUSCENTRAL_REPO     (default Exe64/nexuscentral)      <- GitHub repository
#   GH_TOKEN_SCRIPT  (default /opt/security/get_github_token.py -- must print the token)
#
# One-time prerequisites:
#   - create /opt/apps/nexuscentral/.env (see .env.example): DOMAIN,
#     TRAEFIK_CERTRESOLVER, POSTGRES_PASSWORD, and AUTH_PASSWORD for the very
#     first deploy only
#   - the external Traefik network `web_network` must exist
#   - the GitHub App must have access to the nexuscentral repository
#
# Flags:
#   --skip-backup   skip the pre-migration dump (first deploy, or a throwaway host)
#   --no-build      reuse the images already on the host
set -euo pipefail

APP_DIR="${NEXUSCENTRAL_APP_DIR:-/opt/apps/nexuscentral}"
REPO="${NEXUSCENTRAL_REPO:-Exe64/nexuscentral}"
TOKEN_SCRIPT="${GH_TOKEN_SCRIPT:-/opt/security/get_github_token.py}"
COMPOSE=(-f docker-compose.yml -f docker-compose.vps.yml)

SKIP_BACKUP=0
DO_BUILD=1
for arg in "$@"; do
  case "$arg" in
    --skip-backup) SKIP_BACKUP=1 ;;
    --no-build) DO_BUILD=0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[deploy]\033[0m %s\n' "$*" >&2; exit 1; }

# Reads one key from .env WITHOUT sourcing it: values may contain characters the
# shell would choke on (bcrypt hashes are full of `$` and `/`).
env_get() {
  [ -f "$APP_DIR/.env" ] || return 0
  local v
  v="$(grep -E "^${1}=" "$APP_DIR/.env" | tail -n1 | cut -d= -f2-)"
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}

# 1. Validate .env first, before anything with a side effect.
#
#    .env is untracked, so it reads the same before and after the sync -- and
#    checking it here means a half-filled file fails in a second, rather than
#    after a `reset --hard` has already moved the working tree.
mkdir -p "$APP_DIR"
[[ -f "$APP_DIR/.env" ]] || fail "Missing $APP_DIR/.env. Create it from .env.example before the first deploy."

for key in DOMAIN TRAEFIK_CERTRESOLVER POSTGRES_PASSWORD; do
  [[ -n "$(env_get "$key")" ]] || fail "$key is empty in .env."
done

DOMAIN_VALUE="$(env_get DOMAIN)"
AUTH_PASSWORD_VALUE="$(env_get AUTH_PASSWORD)"

# AUTH_PASSWORD is checked further down, once PostgreSQL is up and the database
# can say for itself whether a credential exists. Inferring it from .env or from
# the presence of a volume would be a guess, and the failure mode of guessing
# wrong is a container that exits on boot with the reason buried in its logs.

# 2. GitHub App token (short-lived, ~10 min)
log "Generating the GitHub App token…"
TOKEN="$(python3 "$TOKEN_SCRIPT")"
REMOTE="https://x-access-token:${TOKEN}@github.com/${REPO}.git"

# 3. Init the repository in place if needed, then sync onto main. `reset --hard`
#    leaves untracked files such as .env alone.
if [[ ! -d "$APP_DIR/.git" ]]; then
  log "Initialising the repository in ${APP_DIR}…"
  git -C "$APP_DIR" init -q
fi

PREV_SHA="$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo none)"

log "Syncing onto main…"
git -C "$APP_DIR" fetch --quiet "$REMOTE" main
git -C "$APP_DIR" reset --quiet --hard FETCH_HEAD
cd "$APP_DIR"

NEW_SHA="$(git rev-parse --short HEAD)"
log "Deploying ${PREV_SHA} -> ${NEW_SHA}"

# Exported so `docker compose` interpolates it into the api service's
# environment. This is what the update check compares against GitHub, and it is
# a runtime variable rather than a build arg on purpose: a build arg would
# invalidate the image layer on every commit, and `--no-build` would then ship
# an image labelled with the previous deployment's sha.
export GIT_SHA="$NEW_SHA"

# The control directory the api container shares with the update agent. Created
# here, owned by the image's `node` user (uid 1000): left to Docker it would be
# created root-owned on first `up`, and the container could not write its
# request. Harmless when in-app updates are not enabled -- an empty directory.
mkdir -p "$APP_DIR/control"
chown 1000:1000 "$APP_DIR/control" 2>/dev/null || true

# 4. PostgreSQL first, before the build.
#
#    Ahead of the build so that the credential check below fails in seconds rather
#    than after three minutes of compiling. Also deliberately not `up -d` for
#    everything: the API seeds the Home dashboard on first boot, and an API that
#    starts before the migration finds no tables, logs the failure and never
#    retries. Migrating before anything else starts is the only ordering where a
#    first deploy comes up seeded.
log "Starting PostgreSQL…"
docker compose "${COMPOSE[@]}" up -d postgres

log "Waiting for PostgreSQL…"
for i in $(seq 1 30); do
  if docker compose "${COMPOSE[@]}" exec -T postgres pg_isready -q; then break; fi
  # A full `if` rather than `[[ … ]] && fail`: under `set -e` the short form is
  # easy to get subtly wrong, and this is the branch that must not be skipped.
  if [[ "$i" == 30 ]]; then fail "PostgreSQL is unreachable."; fi
  sleep 2
done

# 5. Is there a password yet?
#
#    Asked of the database rather than inferred: on a first deploy the table does
#    not exist and psql errors, which counts as "no credential" just the same.
#    The API refuses to serve without one, so catching it here turns a container
#    that exits on boot into one sentence.
PGUSER_VALUE="$(env_get POSTGRES_USER)"
PGDB_VALUE="$(env_get POSTGRES_DB)"
CREDENTIALS="$(docker compose "${COMPOSE[@]}" exec -T postgres \
  psql -tAq -U "${PGUSER_VALUE:-nexuscentral}" -d "${PGDB_VALUE:-nexuscentral}" \
  -c 'SELECT count(*) FROM auth_credential' 2>/dev/null || echo 0)"
CREDENTIALS="${CREDENTIALS//[^0-9]/}"

if [[ "${CREDENTIALS:-0}" == 0 ]]; then
  [[ -n "$AUTH_PASSWORD_VALUE" ]] || fail \
    "No password is stored yet and AUTH_PASSWORD is not set in .env.
   The app stores one on first boot and refuses to serve without it.
   Add AUTH_PASSWORD=<at least 12 characters>, deploy, sign in, then remove it."

  if [[ "${#AUTH_PASSWORD_VALUE}" -lt 12 ]]; then
    fail "AUTH_PASSWORD is shorter than 12 characters; the app will reject it and exit."
  fi

  # Compose expands `$` in .env values when a name follows it, so `hunter$secret`
  # reaches the container as `hunter` and the stored hash is for a password nobody
  # typed. `$2` and `$!` are literal, but the distinction is not worth relying on.
  if [[ "$AUTH_PASSWORD_VALUE" =~ \$[A-Za-z_\{] ]]; then
    fail "AUTH_PASSWORD contains \$ followed by a name, which Compose expands on the way
   to the container -- it would store a shorter password than you wrote.
   Leave AUTH_PASSWORD out entirely and set it after this deploy with:
     docker compose exec -it api node dist/cli/set-password.js"
  fi

  log "First deploy: the password from AUTH_PASSWORD will be stored on boot."
elif [[ -n "$AUTH_PASSWORD_VALUE" ]]; then
  # Not fatal -- the app ignores it once a credential exists. Still worth saying:
  # a password left in .env is a password in every backup of .env.
  log "AUTH_PASSWORD is set but a password is already stored. Remove it from .env."
fi

# 6. Build.
if [[ "$DO_BUILD" == 1 ]]; then
  log "Build…"
  docker compose "${COMPOSE[@]}" build
fi

# 7. Dump before migrating. A migration is the one routine operation that can
#    destroy data, so this runs first and a failure stops the deploy.
DUMP=""
if [[ "$SKIP_BACKUP" == 1 ]]; then
  log "Pre-migration dump skipped (--skip-backup)."
else
  log "Pre-migration dump…"
  DUMP="$(./deploy/backup-db.sh --label "predeploy-${NEW_SHA}" --quiet)" \
    || fail "Backup failed -- not migrating. Fix the backup, or re-run with --skip-backup if you accept the risk."
  log "Dump: ${DUMP}"
fi

# 8. Migrate in a one-shot container, before the API exists. `run --rm` uses the
#    image just built, so the migration and the code that will run against it come
#    from the same commit.
log "Migrating the schema…"
docker compose "${COMPOSE[@]}" run --rm --no-deps api pnpm migrate up

# 9. Now start the application.
log "Starting the application…"
docker compose "${COMPOSE[@]}" up -d --remove-orphans

# 10. Health gate, through the web container -- that is the path Traefik takes, so
#    it proves the SPA host can reach the API, not just that the API is alive.
log "Health check…"
HEALTHY=0
for i in $(seq 1 30); do
  # 127.0.0.1, not localhost: musl resolves localhost to ::1 first and nginx
  # listens on IPv4 only, so the name gives a connection refused that looks like
  # a dead container.
  if docker compose "${COMPOSE[@]}" exec -T web wget -qO- http://127.0.0.1/api/health 2>/dev/null \
      | grep -q '"status":"ok"'; then
    HEALTHY=1
    break
  fi
  sleep 2
done

if [[ "$HEALTHY" != 1 ]]; then
  printf '\033[1;31m[deploy]\033[0m Health check failed after 60s. Recent API logs:\n' >&2
  docker compose "${COMPOSE[@]}" logs --tail 40 api >&2 || true
  cat >&2 <<EOF

Nothing was rolled back automatically. The migration has already run, and
restoring the dump would discard anything written since it was taken -- that is a
decision to make with the logs in front of you, not one to automate.

  Roll back the code only (keeps the new schema):
    git -C "$APP_DIR" reset --hard $PREV_SHA && ./deploy.sh --skip-backup

  Roll back code and database:
    git -C "$APP_DIR" reset --hard $PREV_SHA
    ./deploy/restore-db.sh ${DUMP:-<no dump taken>}
    ./deploy.sh --skip-backup
EOF
  exit 1
fi

# 11. Clean up. Images only -- never volumes, the database lives in one.
docker image prune -f >/dev/null 2>&1 || true

log "✅ Deployed ${NEW_SHA}. https://${DOMAIN_VALUE}"
log "The first boot seeds a Home dashboard; add sources from the Sources page."
