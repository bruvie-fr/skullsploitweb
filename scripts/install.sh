#!/usr/bin/env bash
# generic install: dependencies + env file. for full VPS setup with HTTPS + systemd,
# use install-ubuntu.sh instead.
#
# usage:
#   bash scripts/install.sh

set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "node not found. install Node.js 18+ first (https://nodejs.org)." >&2
  exit 1
fi

NODE_MAJOR="$(node -v | cut -d. -f1 | tr -d v)"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  echo "node $NODE_MAJOR found, need 18 or newer." >&2
  exit 1
fi

echo "==> installing npm dependencies"
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

if [[ ! -f .env ]]; then
  echo "==> creating .env"
  SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")"
  PASS="$(node -e "console.log(require('crypto').randomBytes(8).toString('hex'))")"
  cat >.env <<EOF
NODE_ENV=production
PORT=3000
SESSION_SECRET=$SECRET
SEED_DEV_USERNAME=admin
SEED_DEV_PASSWORD=$PASS
EOF
  chmod 600 .env
  echo "   .env created. seeded credentials are inside — read it once and store them safely."
else
  echo "==> .env already exists, leaving it alone"
fi

mkdir -p data
chmod 700 data

echo
echo "done. start with: bash scripts/start.sh"
