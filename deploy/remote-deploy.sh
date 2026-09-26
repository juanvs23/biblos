#!/usr/bin/env bash
# Remote deploy script for biblos on coltmandev.dev.
# Streamed to the VPS by GitHub Actions as root:
#   ssh root@coltmandev.dev 'bash -s' < deploy/remote-deploy.sh
#
# CRITICAL: /opt/biblos holds untracked runtime state (the .env with
# BIBLOS_API_KEY and the SQLite DB). Never run `git clean` here;
# fetch + reset --hard leaves untracked files in place.

set -euo pipefail

APP_DIR=/opt/biblos
APP_USER=biblos
HEALTH_URL=http://127.0.0.1:8199/mcp

# git and npm must run as the app user: root triggers git's
# "dubious ownership" safety stop in /opt/biblos.

echo "==> Fetching origin/master"
sudo -u "$APP_USER" -H git -C "$APP_DIR" fetch origin master

echo "==> Resetting working tree to origin/master (untracked files preserved)"
sudo -u "$APP_USER" -H git -C "$APP_DIR" reset --hard origin/master

echo "==> Installing dependencies"
sudo -u "$APP_USER" -H npm --prefix "$APP_DIR" ci

echo "==> Building"
sudo -u "$APP_USER" -H npm --prefix "$APP_DIR" run build

echo "==> Restarting biblos service"
systemctl restart biblos

echo "==> Verifying service is active"
sleep 2
if ! systemctl is-active --quiet biblos; then
  echo "ERROR: biblos is not active after restart" >&2
  systemctl status biblos --no-pager >&2 || true
  exit 1
fi

echo "==> Health check $HEALTH_URL (401 without auth is healthy)"
http_code=""
for attempt in 1 2 3 4 5; do
  # `|| true`: curl exits non-zero on refused/timeout; retry instead of aborting.
  http_code="$(curl -s --max-time 10 -o /dev/null -w "%{http_code}" "$HEALTH_URL" || true)"
  if [ "$http_code" = "200" ] || [ "$http_code" = "401" ]; then
    break
  fi
  echo "    attempt $attempt: endpoint not healthy yet (HTTP ${http_code:-no response})"
  sleep 2
done
if [ "$http_code" != "200" ] && [ "$http_code" != "401" ]; then
  echo "ERROR: health check failed: expected HTTP 200 or 401, got ${http_code:-no response}" >&2
  exit 1
fi
echo "==> Deploy complete (HTTP $http_code)"
