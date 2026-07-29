#!/usr/bin/env bash
set -Eeuo pipefail

VERSION="${WEBDEPLOY_VERSION:-v0.1.1}"
REPOSITORY="${WEBDEPLOY_REPOSITORY:-ghbhiee/webdeploy-mcp}"
INSTALL_ROOT="/opt/webdeploy"
DATA_DIR="/var/lib/webdeploy"
CONFIG_DIR="/etc/webdeploy"
DASHBOARD_DOMAIN=""
MCP_DOMAIN=""
INTERNAL_PORT="3847"
ADMIN_IDENTITY=""
ACME_EMAIL=""
CONFIGURE_NGINX="yes"
CONFIGURE_HTTPS="yes"
AUTO_UPDATE="no"
NON_INTERACTIVE="no"
MISE_VERSION="v2026.7.16"

usage() {
  cat <<'USAGE'
Usage: sudo bash installer/install.sh [options]
  --install-dir PATH
  --data-dir PATH
  --dashboard-domain HOSTNAME
  --mcp-domain HOSTNAME
  --port NUMBER
  --admin IDENTITY
  --acme-email EMAIL
  --no-nginx
  --no-https
  --auto-update
  --non-interactive
USAGE
}

while (($#)); do
  case "$1" in
    --install-dir) INSTALL_ROOT="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --dashboard-domain) DASHBOARD_DOMAIN="$2"; shift 2 ;;
    --mcp-domain) MCP_DOMAIN="$2"; shift 2 ;;
    --port) INTERNAL_PORT="$2"; shift 2 ;;
    --admin) ADMIN_IDENTITY="$2"; shift 2 ;;
    --acme-email) ACME_EMAIL="$2"; shift 2 ;;
    --no-nginx) CONFIGURE_NGINX="no"; shift ;;
    --no-https) CONFIGURE_HTTPS="no"; shift ;;
    --auto-update) AUTO_UPDATE="yes"; shift ;;
    --non-interactive) NON_INTERACTIVE="yes"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "Run this installer with sudo." >&2; exit 1; }
[[ -r /etc/os-release ]] || { echo "Unsupported Linux distribution." >&2; exit 1; }
# shellcheck disable=SC1091
source /etc/os-release
case "${ID}:${VERSION_ID}" in
  ubuntu:22.04|ubuntu:24.04|debian:12) ;;
  *) echo "Supported systems: Ubuntu 22.04/24.04 and Debian 12. Found ${ID} ${VERSION_ID}." >&2; exit 1 ;;
esac
[[ "$(uname -m)" =~ ^(x86_64|aarch64)$ ]] || { echo "Supported architectures: x86_64 and arm64." >&2; exit 1; }
if [[ ! "$INTERNAL_PORT" =~ ^[0-9]+$ ]] ||
  ((INTERNAL_PORT < 1024 || INTERNAL_PORT > 65535)); then
  echo "Internal port must be between 1024 and 65535." >&2
  exit 1
fi

prompt() {
  local variable="$1" text="$2" default="$3" value
  if [[ "$NON_INTERACTIVE" == yes ]]; then
    value="${!variable:-$default}"
  else
    read -r -p "$text [$default]: " value
    value="${value:-$default}"
  fi
  printf -v "$variable" '%s' "$value"
}
yesno() {
  local variable="$1" text="$2" default="$3" value
  if [[ "$NON_INTERACTIVE" == yes ]]; then value="${!variable:-$default}"
  else read -r -p "$text [$default]: " value; value="${value:-$default}"; fi
  [[ "$value" =~ ^([Yy][Ee][Ss]|[Yy])$ ]] && value=yes || value=no
  printf -v "$variable" '%s' "$value"
}

prompt INSTALL_ROOT "Installation directory" "$INSTALL_ROOT"
prompt DATA_DIR "Data directory" "$DATA_DIR"
prompt DASHBOARD_DOMAIN "Dashboard domain" "${DASHBOARD_DOMAIN:-deploy.example.com}"
prompt MCP_DOMAIN "MCP domain" "${MCP_DOMAIN:-$DASHBOARD_DOMAIN}"
prompt INTERNAL_PORT "Internal control-plane port" "$INTERNAL_PORT"
prompt ADMIN_IDENTITY "Initial administrator username or email" "${ADMIN_IDENTITY:-admin}"
yesno CONFIGURE_NGINX "Configure Nginx" "$CONFIGURE_NGINX"
if [[ "$CONFIGURE_NGINX" == yes ]]; then yesno CONFIGURE_HTTPS "Request HTTPS certificates" "$CONFIGURE_HTTPS"; fi
if [[ "$CONFIGURE_HTTPS" == yes ]]; then prompt ACME_EMAIL "ACME email" "${ACME_EMAIL:-admin@$DASHBOARD_DOMAIN}"; fi
yesno AUTO_UPDATE "Enable weekly automatic updates" "$AUTO_UPDATE"

valid_hostname='^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$'
[[ "$DASHBOARD_DOMAIN" =~ $valid_hostname && "$MCP_DOMAIN" =~ $valid_hostname ]] ||
  { echo "Dashboard and MCP domains must be valid fully-qualified hostnames." >&2; exit 1; }

if ss -ltnH "sport = :$INTERNAL_PORT" | grep -q .; then
  echo "Port $INTERNAL_PORT is already in use. Choose another internal port." >&2
  exit 1
fi
if [[ "$CONFIGURE_NGINX" == yes ]] && command -v nginx >/dev/null; then
  for domain in "$DASHBOARD_DOMAIN" "$MCP_DOMAIN"; do
    if grep -RqsE "server_name[[:space:]][^;]*\\b${domain//./\\.}\\b" /etc/nginx 2>/dev/null; then
      echo "Existing Nginx configuration already declares server_name $domain." >&2
      echo "Resolve the conflict or rerun with --no-nginx." >&2
      exit 1
    fi
  done
fi

SOURCE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_DIR="$INSTALL_ROOT/releases/$VERSION"
created_release=no
rollback() {
  local code=$?
  if ((code != 0)); then
    echo "Installation failed; rolling back files created for $VERSION." >&2
    if [[ "$created_release" == yes && -d "$RELEASE_DIR" ]]; then rm -rf -- "$RELEASE_DIR"; fi
  fi
}
trap rollback EXIT

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git gnupg jq openssl build-essential unzip \
  nginx certbot python3-certbot-nginx postgresql postgresql-client

node_major=0
if command -v node >/dev/null; then node_major="$(node -p 'process.versions.node.split(".")[0]')"; fi
if ((node_major < 22)); then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key |
    gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  printf 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main\n' \
    >/etc/apt/sources.list.d/nodesource.list
  apt-get update
  apt-get install -y nodejs
fi
npm install --global pnpm@11.10.0 pm2@7.0.3

if ! command -v mise >/dev/null; then
  arch=x64
  [[ "$(uname -m)" == aarch64 ]] && arch=arm64
  mise_asset="mise-${MISE_VERSION}-linux-${arch}"
  mise_tmp="$(mktemp -d)"
  curl -fsSLo "$mise_tmp/mise" "https://github.com/jdx/mise/releases/download/${MISE_VERSION}/${mise_asset}"
  curl -fsSLo "$mise_tmp/SHA256SUMS" "https://github.com/jdx/mise/releases/download/${MISE_VERSION}/SHASUMS256.txt"
  (cd "$mise_tmp"; grep "  ${mise_asset}$" SHA256SUMS | sed "s/${mise_asset}$/mise/" | sha256sum -c -)
  install -m 0755 "$mise_tmp/mise" /usr/local/bin/mise
  rm -rf -- "$mise_tmp"
fi

install -d -m 0755 "$INSTALL_ROOT/releases" "$DATA_DIR"
install -d -m 0700 "$CONFIG_DIR" "$DATA_DIR/uploads" "$DATA_DIR/pm2"
[[ ! -e "$RELEASE_DIR" ]] || { echo "Release already installed: $RELEASE_DIR" >&2; exit 1; }
mkdir "$RELEASE_DIR"
created_release=yes
cp -a "$SOURCE_ROOT/." "$RELEASE_DIR/"
rm -rf -- "$RELEASE_DIR/node_modules" "$RELEASE_DIR"/apps/*/node_modules "$RELEASE_DIR"/packages/*/node_modules
(
  cd "$RELEASE_DIR"
  pnpm install --frozen-lockfile
  pnpm build
)
ln -sfn "$RELEASE_DIR" "$INSTALL_ROOT/current"

if ! id webdeploy >/dev/null 2>&1; then
  useradd --system --user-group --home-dir "$DATA_DIR" --shell /usr/sbin/nologin webdeploy
fi
chown -R webdeploy:webdeploy "$DATA_DIR"
chmod 0700 "$DATA_DIR/pm2" "$DATA_DIR/uploads"

db_password="$(openssl rand -base64 36 | tr -d '/+=' | head -c 40)"
runuser -u postgres -- psql -v ON_ERROR_STOP=1 --set=password="$db_password" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='webdeploy') THEN
    CREATE ROLE webdeploy LOGIN;
  END IF;
END $$;
SELECT format('ALTER ROLE webdeploy PASSWORD %L', :'password') \gexec
SELECT 'CREATE DATABASE webdeploy OWNER webdeploy'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='webdeploy') \gexec
SQL
database_url="postgresql://webdeploy:${db_password}@127.0.0.1:5432/webdeploy"

if [[ ! -f "$CONFIG_DIR/master.key" ]]; then openssl rand -base64 32 >"$CONFIG_DIR/master.key"; fi
chmod 0600 "$CONFIG_DIR/master.key"
if [[ ! -f "$CONFIG_DIR/oidc-jwks.json" ]]; then
  node "$RELEASE_DIR/installer/generate-jwks.mjs" "$CONFIG_DIR/oidc-jwks.json"
fi
chmod 0600 "$CONFIG_DIR/oidc-jwks.json"

cat >"$CONFIG_DIR/webdeploy.env" <<ENV
NODE_ENV=production
HOST=127.0.0.1
PORT=$INTERNAL_PORT
PUBLIC_URL=https://$DASHBOARD_DOMAIN
MCP_PUBLIC_URL=https://$MCP_DOMAIN
DATABASE_URL=$database_url
DATA_DIR=$DATA_DIR
CONFIG_DIR=$CONFIG_DIR
MASTER_KEY_FILE=$CONFIG_DIR/master.key
OIDC_JWKS_FILE=$CONFIG_DIR/oidc-jwks.json
SESSION_COOKIE_NAME=wd_session
SESSION_TTL_SECONDS=43200
OAUTH_ACCESS_TOKEN_TTL_SECONDS=3600
OAUTH_REFRESH_TOKEN_TTL_SECONDS=2592000
TRUST_PROXY=true
LOG_LEVEL=info
MAX_UPLOAD_BYTES=104857600
PORT_RANGE_START=41000
PORT_RANGE_END=41999
RELEASE_RETENTION_DEFAULT=5
ADMIN_SOCKET=/run/webdeploy/admin.sock
NGINX_SITES_DIR=/etc/nginx/conf.d
PM2_HOME=$DATA_DIR/pm2
RUNTIME_MANAGER=mise
WEBDEPLOY_INSTALL_ROOT=$INSTALL_ROOT
WEBDEPLOY_REPOSITORY=$REPOSITORY
ENV
chmod 0600 "$CONFIG_DIR/webdeploy.env"

set -a
# shellcheck disable=SC1091
source "$CONFIG_DIR/webdeploy.env"
set +a
(cd "$RELEASE_DIR"; node packages/core/dist/migrate-cli.js)
BOOTSTRAP_ADMIN_IDENTITY="$ADMIN_IDENTITY" node "$RELEASE_DIR/installer/bootstrap.mjs"

install -m 0755 "$RELEASE_DIR/installer/bin/webdeploy-control" /usr/local/libexec/webdeploy-control
sed -i "s#/etc/webdeploy/webdeploy.env#$CONFIG_DIR/webdeploy.env#g; s#/opt/webdeploy#$INSTALL_ROOT#g" \
  /usr/local/libexec/webdeploy-control
ln -sfn "$INSTALL_ROOT/current/apps/cli/dist/index.js" /usr/local/bin/webdeploy
chmod 0755 "$RELEASE_DIR/apps/cli/dist/index.js"
install -m 0755 "$RELEASE_DIR/installer/update.sh" "$CONFIG_DIR/update.sh"
install -m 0755 "$RELEASE_DIR/installer/uninstall.sh" "$CONFIG_DIR/uninstall.sh"
install -m 0755 "$RELEASE_DIR/installer/restore.sh" "$CONFIG_DIR/restore.sh"

cat >"$CONFIG_DIR/ecosystem.config.cjs" <<PM2
module.exports = {
  apps: [{
    name: "webdeploy-control",
    script: "/usr/local/libexec/webdeploy-control",
    interpreter: "none",
    cwd: "$INSTALL_ROOT/current",
    autorestart: true,
    max_memory_restart: "768M",
    time: true
  }]
};
PM2
chmod 0600 "$CONFIG_DIR/ecosystem.config.cjs"
PM2_HOME="$DATA_DIR/pm2" pm2 start "$CONFIG_DIR/ecosystem.config.cjs"
PM2_HOME="$DATA_DIR/pm2" pm2 save
env PATH="$PATH:/usr/local/bin" PM2_HOME="$DATA_DIR/pm2" pm2 startup systemd -u root --hp /root

worker_unit=/etc/systemd/system/webdeploy-worker.service
sed -e "s#/etc/webdeploy#$CONFIG_DIR#g" -e "s#/opt/webdeploy#$INSTALL_ROOT#g" \
  -e "s#/var/lib/webdeploy#$DATA_DIR#g" "$RELEASE_DIR/installer/webdeploy-worker.service" >"$worker_unit"
systemctl daemon-reload
systemctl enable --now webdeploy-worker

if [[ "$CONFIGURE_NGINX" == yes ]]; then
  names="$DASHBOARD_DOMAIN"
  [[ "$MCP_DOMAIN" == "$DASHBOARD_DOMAIN" ]] || names="$names $MCP_DOMAIN"
  nginx_file="/etc/nginx/conf.d/webdeploy-control.conf"
  cat >"$nginx_file" <<NGINX
# Managed by WebDeploy MCP installer.
server {
    listen 80;
    listen [::]:80;
    server_name $names;
    client_max_body_size 100m;
    location /mcp {
        proxy_pass http://127.0.0.1:$INTERNAL_PORT;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
    location / {
        proxy_pass http://127.0.0.1:$INTERNAL_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX
  nginx -t
  systemctl reload nginx
  if [[ "$CONFIGURE_HTTPS" == yes ]]; then
    cert_args=(-d "$DASHBOARD_DOMAIN")
    [[ "$MCP_DOMAIN" == "$DASHBOARD_DOMAIN" ]] || cert_args+=(-d "$MCP_DOMAIN")
    certbot --nginx --non-interactive --agree-tos --redirect -m "$ACME_EMAIL" "${cert_args[@]}" ||
      echo "HTTPS issuance did not complete. Verify DNS, then rerun: certbot --nginx ${cert_args[*]}"
  fi
fi

if [[ "$AUTO_UPDATE" == yes ]]; then
  install -m 0644 "$RELEASE_DIR/installer/webdeploy-update.service" /etc/systemd/system/
  install -m 0644 "$RELEASE_DIR/installer/webdeploy-update.timer" /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now webdeploy-update.timer
fi

created_release=no
trap - EXIT
cat <<RESULT

WebDeploy MCP $VERSION installed successfully.

Dashboard: https://$DASHBOARD_DOMAIN/
MCP endpoint: https://$MCP_DOMAIN/mcp

1. Open the Dashboard and register a Passkey for: $ADMIN_IDENTITY
2. List requests:  sudo webdeploy auth list-pending
3. Approve it:     sudo webdeploy auth approve-passkey <request-code>
4. Connect Codex:  codex mcp add webdeploy --url https://$MCP_DOMAIN/mcp
5. Authenticate:   codex mcp login webdeploy

Logs:          sudo webdeploy logs
Configuration: $CONFIG_DIR/webdeploy.env
Data:          $DATA_DIR
Update:        sudo webdeploy update
Uninstall:     sudo webdeploy uninstall
RESULT
