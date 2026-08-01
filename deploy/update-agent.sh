#!/usr/bin/env bash
#
# update-agent.sh -- run deploy.sh when the application asks for it.
#
# WHY THIS EXISTS, RATHER THAN THE API RUNNING deploy.sh ITSELF
#
#   Updating means `git fetch`, `docker compose build`, a database dump and a
#   migration. A container can only do that if it holds the Docker socket, and
#   the Docker socket is root on the host: anything holding it can start a
#   privileged container that mounts `/`. The API is on the internet behind one
#   password, and this host also runs other applications. Handing it the socket
#   would mean one authentication bug costs the whole machine, not one app.
#
#   So the container never acts. It writes a request into a directory it already
#   owns, and this script -- running on the host, from a systemd timer -- decides
#   whether to act on it. The container's privileges do not change at all.
#
#   The request is a trigger, not a parameter. Nothing inside request.json is
#   ever passed to a command: deploy.sh always deploys the head of main, and the
#   file's contents are only recorded for display. That is deliberate, and it is
#   what makes a hostile request.json uninteresting.
#
# Install (once, as root):
#   cp deploy/nexuscentral-update.service /etc/systemd/system/
#   cp deploy/nexuscentral-update.timer   /etc/systemd/system/
#   systemctl daemon-reload
#   systemctl enable --now nexuscentral-update.timer
#
# Variables:
#   NEXUSCENTRAL_APP_DIR      (default /opt/apps/nexuscentral)
#   NEXUSCENTRAL_CONTROL_DIR  (default $NEXUSCENTRAL_APP_DIR/control)
set -uo pipefail

APP_DIR="${NEXUSCENTRAL_APP_DIR:-/opt/apps/nexuscentral}"
CONTROL_DIR="${NEXUSCENTRAL_CONTROL_DIR:-$APP_DIR/control}"

REQUEST="$CONTROL_DIR/request.json"
STATE="$CONTROL_DIR/state.json"
LOG="$CONTROL_DIR/update.log"
LOCK="$CONTROL_DIR/agent.lock"

[[ -d "$CONTROL_DIR" ]] || exit 0
[[ -f "$REQUEST" ]] || exit 0

# Only one run at a time. Without this a timer that fires while a build is still
# going would start a second `docker compose build` over the same tree.
exec 9>"$LOCK"
flock -n 9 || exit 0

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Written with a temporary file and a rename: the API reads this directory on a
# timer, and a partially written state.json would parse as corrupt exactly once,
# at the worst moment.
write_state() {
  local tmp
  tmp="$(mktemp "$CONTROL_DIR/.state.XXXXXX")"
  cat >"$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$STATE"
}

json_escape() { python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'; }

FROM_SHA="$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
STARTED="$(now)"

# Claimed before the work starts, so a crash mid-deploy cannot leave the request
# sitting there to be run again on the next tick.
rm -f "$REQUEST"

write_state <<EOF
{
  "state": "running",
  "startedAt": "$STARTED",
  "finishedAt": null,
  "fromSha": "$FROM_SHA",
  "toSha": null,
  "exitCode": null,
  "message": null
}
EOF

{
  echo "=== $(now) update requested, deploying ==="
} >>"$LOG"

cd "$APP_DIR" || exit 1
./deploy.sh >>"$LOG" 2>&1
EXIT=$?

TO_SHA="$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
FINISHED="$(now)"

if [[ $EXIT -eq 0 ]]; then
  STATE_NAME="succeeded"
  MESSAGE="Deployed ${FROM_SHA} -> ${TO_SHA}."
else
  STATE_NAME="failed"
  # deploy.sh rolls back to the previous commit on a failed migration or health
  # check, so naming the log is more useful than guessing at a cause here.
  MESSAGE="deploy.sh exited ${EXIT}. See ${LOG}."
fi

write_state <<EOF
{
  "state": "$STATE_NAME",
  "startedAt": "$STARTED",
  "finishedAt": "$FINISHED",
  "fromSha": "$FROM_SHA",
  "toSha": "$TO_SHA",
  "exitCode": $EXIT,
  "message": $(printf '%s' "$MESSAGE" | json_escape)
}
EOF

echo "=== $FINISHED $STATE_NAME (exit $EXIT) ===" >>"$LOG"

# Keep the log from growing without bound: this file is bind-mounted into a
# container and read on a timer.
if [[ -f "$LOG" ]] && [[ "$(wc -c <"$LOG")" -gt 1048576 ]]; then
  tail -c 262144 "$LOG" >"$LOG.tmp" && mv -f "$LOG.tmp" "$LOG"
fi

exit "$EXIT"
