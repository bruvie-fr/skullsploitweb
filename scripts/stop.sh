#!/usr/bin/env bash
# stop the skullsploit server (systemd if installed, otherwise the backgrounded node process).
#
# usage:
#   bash scripts/stop.sh

set -euo pipefail

cd "$(dirname "$0")/.."

PID_FILE=".skullsploit.pid"

if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q '^skullsploit.service'; then
  echo "==> stopping via systemd"
  sudo systemctl stop skullsploit
  echo "stopped."
  exit 0
fi

if [[ ! -f "$PID_FILE" ]]; then
  echo "no pid file. is skullsploit running?"
  exit 0
fi

PID="$(cat "$PID_FILE")"
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  for i in 1 2 3 4 5; do
    kill -0 "$PID" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$PID" 2>/dev/null; then
    echo "still alive after 5s, sending SIGKILL"
    kill -9 "$PID"
  fi
  echo "stopped (pid $PID)."
else
  echo "process $PID not running, cleaning up pid file."
fi
rm -f "$PID_FILE"
