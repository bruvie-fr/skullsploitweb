#!/usr/bin/env bash
# start the skullsploit server.
# uses systemd if installed (preferred for production). otherwise runs node directly
# in the background and writes a pid file.
#
# usage:
#   bash scripts/start.sh           # start in background
#   bash scripts/start.sh --fg      # start in foreground (good for dev)

set -euo pipefail

cd "$(dirname "$0")/.."

PID_FILE=".skullsploit.pid"
LOG_FILE="data/server.log"
FOREGROUND=0
[[ "${1-}" == "--fg" ]] && FOREGROUND=1

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

if [[ ! -f data/devs.json ]] && [[ -n "${SEED_DEV_USERNAME-}" ]]; then
  echo "first run — server will seed owner '${SEED_DEV_USERNAME}' on boot. password is in .env."
fi

# prefer systemd if a unit is installed
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q '^skullsploit.service'; then
  echo "==> starting via systemd"
  sudo systemctl start skullsploit
  sudo systemctl status skullsploit --no-pager
  exit 0
fi

# already running?
if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "skullsploit already running (pid $(cat "$PID_FILE")). use scripts/stop.sh first."
  exit 0
fi

mkdir -p data

if [[ "$FOREGROUND" -eq 1 ]]; then
  echo "==> starting in foreground (Ctrl+C to stop)"
  exec node server.js
fi

echo "==> starting in background"
nohup node server.js >>"$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
sleep 1

if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "started (pid $(cat "$PID_FILE")). logs: $LOG_FILE"
else
  echo "failed to start. last log lines:" >&2
  tail -n 20 "$LOG_FILE" >&2
  rm -f "$PID_FILE"
  exit 1
fi
