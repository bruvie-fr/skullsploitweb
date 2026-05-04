#!/usr/bin/env bash
# skullsploit installer for Ubuntu (22.04 / 24.04).
# installs Node.js, Caddy (for automatic HTTPS), sets up a systemd service,
# and points a domain at the app.
#
# usage:
#   sudo DOMAIN=skullsploit.example.com bash scripts/install-ubuntu.sh
#   sudo DOMAIN=skullsploit.example.com SEED_DEV_USERNAME=root SEED_DEV_PASSWORD='something-strong' bash scripts/install-ubuntu.sh
#
# notes:
#   - run from the repo root (the script expects ./server.js next to it)
#   - DOMAIN must already point to this server's public IP (A record).
#     for DuckDNS: set the A record on duckdns.org first.
#   - Caddy will request a free Let's Encrypt cert automatically. ports 80 + 443 must be open.

set -euo pipefail

if [[ "$EUID" -ne 0 ]]; then
  echo "run this with sudo." >&2
  exit 1
fi

: "${DOMAIN:?set DOMAIN, e.g. DOMAIN=skullsploit.duckdns.org}"

REPO_DIR="$(pwd)"
APP_USER="skullsploit"
NODE_MAJOR=20
ENV_FILE="$REPO_DIR/.env"
SERVICE_FILE="/etc/systemd/system/skullsploit.service"
CADDYFILE="/etc/caddy/Caddyfile"

if [[ ! -f "$REPO_DIR/server.js" ]]; then
  echo "no server.js in $(pwd) — run this from the repo root." >&2
  exit 1
fi

echo "==> updating apt"
apt-get update -y
apt-get install -y curl ca-certificates gnupg ufw

echo "==> installing Node.js $NODE_MAJOR.x"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt $NODE_MAJOR ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi

echo "==> installing Caddy (auto-HTTPS reverse proxy)"
if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo "==> creating service user '$APP_USER'"
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --home "$REPO_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi

echo "==> installing dependencies"
sudo -u "$APP_USER" -H bash -c "cd '$REPO_DIR' && npm ci --omit=dev || npm install --omit=dev"

echo "==> writing $ENV_FILE"
if [[ ! -f "$ENV_FILE" ]]; then
  SESSION_SECRET="$(head -c 48 /dev/urandom | xxd -p -c 96)"
  cat >"$ENV_FILE" <<EOF
NODE_ENV=production
PORT=3000
SESSION_SECRET=$SESSION_SECRET
SEED_DEV_USERNAME=${SEED_DEV_USERNAME:-admin}
SEED_DEV_PASSWORD=${SEED_DEV_PASSWORD:-$(head -c 16 /dev/urandom | xxd -p)}
EOF
  chmod 600 "$ENV_FILE"
  chown "$APP_USER":"$APP_USER" "$ENV_FILE"
  echo "   .env created. seeded dev credentials are inside — read it once and store them safely."
else
  echo "   .env already exists, leaving it alone."
fi

# ensure data dir is owned by the app user
mkdir -p "$REPO_DIR/data"
chown -R "$APP_USER":"$APP_USER" "$REPO_DIR/data"
chmod 700 "$REPO_DIR/data"

echo "==> writing $SERVICE_FILE"
cat >"$SERVICE_FILE" <<EOF
[Unit]
Description=skullsploit
After=network.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$REPO_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node $REPO_DIR/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=$REPO_DIR/data
LimitNOFILE=4096

[Install]
WantedBy=multi-user.target
EOF

echo "==> writing $CADDYFILE"
cat >"$CADDYFILE" <<EOF
{
  email admin@$DOMAIN
}

$DOMAIN {
  encode zstd gzip
  reverse_proxy 127.0.0.1:3000
}
EOF

echo "==> opening firewall (22/80/443)"
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 80/tcp  >/dev/null 2>&1 || true
ufw allow 443/tcp >/dev/null 2>&1 || true
yes | ufw enable >/dev/null 2>&1 || true

echo "==> starting services"
systemctl daemon-reload
systemctl enable --now skullsploit
systemctl reload caddy 2>/dev/null || systemctl restart caddy

sleep 2

echo
echo "done."
echo
echo "site:        https://$DOMAIN"
echo "service:     systemctl status skullsploit"
echo "logs:        journalctl -u skullsploit -f"
echo "caddy logs:  journalctl -u caddy -f"
echo
echo "first time? open $ENV_FILE to see the auto-generated dev login,"
echo "or set SEED_DEV_USERNAME/SEED_DEV_PASSWORD as env vars before running this script."
echo
echo "remember to update the Roblox API_BASE constants:"
echo "  Workspace.MainModule.MainChecker.MainGiver  -> $DOMAIN (https)"
echo "  Workspace.MainModule.MainChecker.Heartbeat  -> $DOMAIN (https)"
