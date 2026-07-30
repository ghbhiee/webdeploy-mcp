#!/usr/bin/env bash
set -Eeuo pipefail

RELEASE_VERSION="${WEBDEPLOY_VERSION:-v0.1.7}"
REPOSITORY="${WEBDEPLOY_REPOSITORY:-ghbhiee/webdeploy-mcp}"
INSTALL_ROOT="/opt/webdeploy"
DATA_DIR="/var/lib/webdeploy"
CONFIG_DIR="/etc/webdeploy"
DASHBOARD_DOMAIN=""
MCP_DOMAIN=""
MCP_SERVER_NAME=""
PUBLIC_PATH="/webdeploy"
INTERNAL_PORT="3847"
ACME_EMAIL=""
CONFIGURE_NGINX="yes"
CONFIGURE_HTTPS="yes"
AUTO_UPDATE="no"
NON_INTERACTIVE="no"
PLAN_ONLY="no"
MISE_VERSION="v2026.7.16"

usage() {
  cat <<'USAGE'
Usage: sudo bash installer/install.sh [options]
       curl -fsSL .../install.sh | sudo bash -s -- DOMAIN

Quick install:
  DOMAIN                       Use one domain, existing Nginx when present,
                               path /webdeploy, HTTPS, and auto-update

Advanced options:
  --domain HOSTNAME             Dashboard and MCP domain
  --path PATH                   URL path (default: /webdeploy; use / for root)
  --mcp-name NAME               MCP client name (default: derived from domain)
  --install-dir PATH
  --data-dir PATH
  --dashboard-domain HOSTNAME   Dashboard domain override
  --mcp-domain HOSTNAME         MCP domain override
  --port NUMBER
  --acme-email EMAIL
  --no-nginx
  --no-https
  --auto-update
  --non-interactive
  --plan                        Validate and print the plan without changes
USAGE
}

if (($#)) && [[ "$1" != -* ]]; then
  NON_INTERACTIVE="yes"
  AUTO_UPDATE="yes"
  DASHBOARD_DOMAIN="$1"
  MCP_DOMAIN="$1"
  shift
fi

while (($#)); do
  case "$1" in
    --domain) DASHBOARD_DOMAIN="$2"; MCP_DOMAIN="$2"; shift 2 ;;
    --path) PUBLIC_PATH="$2"; shift 2 ;;
    --mcp-name) MCP_SERVER_NAME="$2"; shift 2 ;;
    --install-dir) INSTALL_ROOT="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --dashboard-domain) DASHBOARD_DOMAIN="$2"; shift 2 ;;
    --mcp-domain) MCP_DOMAIN="$2"; shift 2 ;;
    --port) INTERNAL_PORT="$2"; shift 2 ;;
    --admin) echo "--admin is no longer needed; the first registered account becomes administrator."; shift 2 ;;
    --acme-email) ACME_EMAIL="$2"; shift 2 ;;
    --no-nginx) CONFIGURE_NGINX="no"; CONFIGURE_HTTPS="no"; shift ;;
    --no-https) CONFIGURE_HTTPS="no"; shift ;;
    --auto-update) AUTO_UPDATE="yes"; shift ;;
    --non-interactive) NON_INTERACTIVE="yes"; shift ;;
    --plan) PLAN_ONLY="yes"; shift ;;
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
    read -r -p "$text [$default]: " value </dev/tty || {
      echo "Interactive input is unavailable. Pass a domain after the one-line installer." >&2
      exit 2
    }
    value="${value:-$default}"
  fi
  printf -v "$variable" '%s' "$value"
}
prompt_required() {
  local variable="$1" text="$2" value
  value="${!variable:-}"
  if [[ "$NON_INTERACTIVE" == yes ]]; then
    [[ -n "$value" ]] || {
      echo "$text is required in non-interactive mode. Use --domain HOSTNAME." >&2
      exit 2
    }
  else
    while [[ -z "$value" ]]; do
      read -r -p "$text (required): " value </dev/tty || {
        echo "Interactive input is unavailable. Pass a domain after the one-line installer." >&2
        exit 2
      }
    done
  fi
  printf -v "$variable" '%s' "$value"
}
yesno() {
  local variable="$1" text="$2" default="$3" value
  if [[ "$NON_INTERACTIVE" == yes ]]; then value="${!variable:-$default}"
  else
    read -r -p "$text [$default]: " value </dev/tty || {
      echo "Interactive input is unavailable. Pass a domain after the one-line installer." >&2
      exit 2
    }
    value="${value:-$default}"
  fi
  [[ "$value" =~ ^([Yy][Ee][Ss]|[Yy])$ ]] && value=yes || value=no
  printf -v "$variable" '%s' "$value"
}

prompt INSTALL_ROOT "Installation directory" "$INSTALL_ROOT"
prompt DATA_DIR "Data directory" "$DATA_DIR"
prompt_required DASHBOARD_DOMAIN "Public Dashboard domain"
prompt MCP_DOMAIN "MCP domain" "${MCP_DOMAIN:-$DASHBOARD_DOMAIN}"
prompt PUBLIC_PATH "Public URL path" "$PUBLIC_PATH"
prompt INTERNAL_PORT "Internal control-plane port" "$INTERNAL_PORT"
yesno CONFIGURE_NGINX "Configure Nginx" "$CONFIGURE_NGINX"
if [[ "$CONFIGURE_NGINX" == yes ]]; then yesno CONFIGURE_HTTPS "Request HTTPS certificates" "$CONFIGURE_HTTPS"; fi
if [[ "$CONFIGURE_HTTPS" == yes ]]; then prompt ACME_EMAIL "ACME email" "${ACME_EMAIL:-admin@$DASHBOARD_DOMAIN}"; fi
yesno AUTO_UPDATE "Enable weekly automatic updates" "$AUTO_UPDATE"

valid_hostname='^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$'
[[ "$DASHBOARD_DOMAIN" =~ $valid_hostname && "$MCP_DOMAIN" =~ $valid_hostname ]] ||
  { echo "Dashboard and MCP domains must be valid fully-qualified hostnames." >&2; exit 1; }
[[ "$PUBLIC_PATH" =~ ^/[A-Za-z0-9._~/-]*$ && "$PUBLIC_PATH" != *".."* ]] ||
  { echo "Public path must be an absolute URL path such as /webdeploy." >&2; exit 1; }
PUBLIC_PATH="/${PUBLIC_PATH#/}"
PUBLIC_PATH="${PUBLIC_PATH%/}"
[[ -n "$PUBLIC_PATH" ]] || PUBLIC_PATH="/"
BASE_PATH="$PUBLIC_PATH"
[[ "$BASE_PATH" == "/" ]] && BASE_PATH=""
PUBLIC_URL="https://$DASHBOARD_DOMAIN$BASE_PATH"
MCP_PUBLIC_URL="https://$MCP_DOMAIN$BASE_PATH"

if [[ -z "$MCP_SERVER_NAME" ]]; then
  mcp_slug="webdeploy-${MCP_DOMAIN,,}${BASE_PATH,,}"
  mcp_slug="${mcp_slug//[^a-z0-9_-]/-}"
  if ((${#mcp_slug} > 64)); then
    mcp_hash="$(printf '%s' "$MCP_DOMAIN" | sha256sum | cut -c1-8)"
    mcp_slug="${mcp_slug:0:55}-$mcp_hash"
  fi
  MCP_SERVER_NAME="$mcp_slug"
fi
[[ "$MCP_SERVER_NAME" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] ||
  { echo "MCP name must match ^[a-z0-9][a-z0-9_-]{0,63}$." >&2; exit 1; }

if [[ "$CONFIGURE_HTTPS" == yes ]]; then
  for domain in "$DASHBOARD_DOMAIN" "$MCP_DOMAIN"; do
    getent ahosts "$domain" >/dev/null 2>&1 || {
      echo "DNS for $domain does not resolve. Create its DNS record, then rerun installation." >&2
      exit 1
    }
  done
fi

if ss -ltnH "sport = :$INTERNAL_PORT" | grep -q .; then
  echo "Port $INTERNAL_PORT is already in use. Choose another internal port." >&2
  exit 1
fi
EXISTING_VHOST="no"
if [[ "$CONFIGURE_NGINX" == yes ]] && command -v nginx >/dev/null &&
  grep -RqsE "server_name[[:space:]][^;]*\\b${DASHBOARD_DOMAIN//./\\.}\\b" \
    /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null; then
  EXISTING_VHOST="yes"
  [[ -n "$BASE_PATH" ]] || {
    echo "The domain already has an Nginx site. Use --path /webdeploy to preserve it." >&2
    exit 1
  }
  [[ "$MCP_DOMAIN" == "$DASHBOARD_DOMAIN" ]] || {
    echo "Path deployment currently requires the Dashboard and MCP to use the same domain." >&2
    exit 1
  }
fi

if [[ "$CONFIGURE_NGINX" == no ]]; then
  nginx_plan="disabled"
elif [[ "$EXISTING_VHOST" == yes ]]; then
  nginx_plan="reuse existing virtual host and add $BASE_PATH"
elif command -v nginx >/dev/null 2>&1; then
  nginx_plan="reuse existing $(nginx -v 2>&1)"
else
  nginx_plan="install"
fi
cat <<PLAN
Installation plan
  Dashboard: $PUBLIC_URL/
  MCP name: $MCP_SERVER_NAME
  MCP URL: $MCP_PUBLIC_URL/mcp
  Nginx: $nginx_plan
  HTTPS: $CONFIGURE_HTTPS
  Auto-update: $AUTO_UPDATE
PLAN
[[ "$PLAN_ONLY" == yes ]] && exit 0

SOURCE_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_DIR="$INSTALL_ROOT/releases/$RELEASE_VERSION"
created_release=no
nginx_vhost_modified=""
nginx_file_created=""
services_started="no"
rollback() {
  local code=$?
  if ((code != 0)); then
    echo "Installation failed; rolling back files created for $RELEASE_VERSION." >&2
    if [[ -n "$nginx_vhost_modified" ]]; then
      python3 "$RELEASE_DIR/installer/configure-nginx-path.py" \
        --remove-from "$nginx_vhost_modified" \
        --include /etc/nginx/snippets/webdeploy-control.conf || true
    fi
    [[ -z "$nginx_file_created" ]] || rm -f -- "$nginx_file_created"
    rm -f /etc/nginx/snippets/webdeploy-control.conf
    if command -v nginx >/dev/null 2>&1 && nginx -t >/dev/null 2>&1; then
      systemctl reload nginx || true
    fi
    if [[ "$services_started" == yes ]]; then
      systemctl disable --now webdeploy-worker webdeploy-pm2 2>/dev/null || true
      PM2_HOME="$DATA_DIR/pm2" pm2 delete webdeploy-control 2>/dev/null || true
      PM2_HOME="$DATA_DIR/pm2" pm2 save --force 2>/dev/null || true
      rm -f /etc/systemd/system/webdeploy-worker.service \
        /etc/systemd/system/webdeploy-pm2.service
      systemctl daemon-reload
    fi
    if [[ "$created_release" == yes && -d "$RELEASE_DIR" ]]; then rm -rf -- "$RELEASE_DIR"; fi
  fi
}
trap rollback EXIT

export DEBIAN_FRONTEND=noninteractive
apt-get update
packages=(ca-certificates curl git gnupg jq openssl build-essential unzip python3 postgresql postgresql-client)
if [[ "$CONFIGURE_NGINX" == yes ]] && ! command -v nginx >/dev/null 2>&1; then
  packages+=(nginx)
fi
if [[ "$CONFIGURE_HTTPS" == yes && "$EXISTING_VHOST" == no ]] &&
  ! command -v certbot >/dev/null 2>&1; then
  packages+=(certbot python3-certbot-nginx)
elif [[ "$CONFIGURE_HTTPS" == yes && "$EXISTING_VHOST" == no ]] &&
  ! certbot plugins 2>/dev/null | grep -qE '(^|[[:space:]])nginx([[:space:]]|$)'; then
  packages+=(python3-certbot-nginx)
fi
apt-get install -y "${packages[@]}"

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
  mise_checksum="$(
    grep -E "  (\\./)?${mise_asset}$" "$mise_tmp/SHA256SUMS" | awk '{print $1}'
  )"
  [[ "$mise_checksum" =~ ^[a-f0-9]{64}$ ]] || {
    echo "Unable to find the mise checksum for $mise_asset." >&2
    exit 1
  }
  (cd "$mise_tmp"; printf '%s  mise\n' "$mise_checksum" | sha256sum -c -)
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
  WEBDEPLOY_BASE_PATH="$BASE_PATH" pnpm build
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
PUBLIC_URL=$PUBLIC_URL
MCP_PUBLIC_URL=$MCP_PUBLIC_URL
MCP_SERVER_NAME=$MCP_SERVER_NAME
WEBDEPLOY_BASE_PATH=$BASE_PATH
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
NGINX_SNIPPET_FILE=/etc/nginx/snippets/webdeploy-control.conf
ENV
chmod 0600 "$CONFIG_DIR/webdeploy.env"

set -a
# shellcheck disable=SC1091
source "$CONFIG_DIR/webdeploy.env"
set +a
(cd "$RELEASE_DIR"; node packages/core/dist/migrate-cli.js)

install -d -m 0755 /usr/local/libexec
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
services_started=yes
PM2_HOME="$DATA_DIR/pm2" pm2 save
sed "s#__DATA_DIR__#$DATA_DIR#g" "$RELEASE_DIR/installer/webdeploy-pm2.service" \
  >/etc/systemd/system/webdeploy-pm2.service
systemctl daemon-reload
systemctl enable webdeploy-pm2

worker_unit=/etc/systemd/system/webdeploy-worker.service
sed -e "s#/etc/webdeploy#$CONFIG_DIR#g" -e "s#/opt/webdeploy#$INSTALL_ROOT#g" \
  -e "s#/var/lib/webdeploy#$DATA_DIR#g" "$RELEASE_DIR/installer/webdeploy-worker.service" >"$worker_unit"
systemctl daemon-reload
systemctl enable --now webdeploy-worker

if [[ "$CONFIGURE_NGINX" == yes ]]; then
  names="$DASHBOARD_DOMAIN"
  [[ "$MCP_DOMAIN" == "$DASHBOARD_DOMAIN" ]] || names="$names $MCP_DOMAIN"
  install -d -m 0755 /etc/nginx/snippets
  nginx_snippet="/etc/nginx/snippets/webdeploy-control.conf"
  if [[ -n "$BASE_PATH" ]]; then
    cat >"$nginx_snippet" <<NGINX
# Managed by WebDeploy MCP installer.
location = $BASE_PATH {
    return 308 $BASE_PATH/;
}
location ^~ $BASE_PATH/ {
    client_max_body_size 100m;
    proxy_pass http://127.0.0.1:$INTERNAL_PORT/;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Forwarded-Host \$host;
    proxy_set_header X-Forwarded-Prefix $BASE_PATH;
}
NGINX
  else
    cat >"$nginx_snippet" <<NGINX
# Managed by WebDeploy MCP installer.
location / {
    client_max_body_size 100m;
    proxy_pass http://127.0.0.1:$INTERNAL_PORT;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Forwarded-Host \$host;
}
NGINX
  fi

  if [[ "$EXISTING_VHOST" == yes ]]; then
    nginx_vhost="$(
      python3 "$RELEASE_DIR/installer/configure-nginx-path.py" \
        --domain "$DASHBOARD_DOMAIN" \
        --path "$BASE_PATH" \
        --include "$nginx_snippet"
    )"
    nginx_vhost_modified="$nginx_vhost"
    printf '\nNGINX_VHOST_FILE=%s\n' "$nginx_vhost" >>"$CONFIG_DIR/webdeploy.env"
  else
    nginx_file="/etc/nginx/conf.d/webdeploy-control.conf"
    nginx_file_created="$nginx_file"
    cat >"$nginx_file" <<NGINX
# Managed by WebDeploy MCP installer.
server {
    listen 80;
    listen [::]:80;
    server_name $names;
    include $nginx_snippet;
}
NGINX
  fi
  nginx -t
  systemctl reload nginx
  if [[ "$CONFIGURE_HTTPS" == yes && "$EXISTING_VHOST" == no ]]; then
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
WEBDEPLOY_ENV_FILE="$CONFIG_DIR/webdeploy.env" webdeploy mcp \
  --output "$CONFIG_DIR/mcp-install.txt" >/dev/null
chmod 0644 "$CONFIG_DIR/mcp-install.txt"
cat <<RESULT

WebDeploy MCP $RELEASE_VERSION installed successfully.

Dashboard: $PUBLIC_URL/
MCP endpoint: $MCP_PUBLIC_URL/mcp
MCP name: $MCP_SERVER_NAME

1. Open the Dashboard and register the first account; it becomes administrator automatically.
2. Later requests can be approved in Dashboard > Administration.
3. CLI approval:   sudo webdeploy auth approve-passkey <request-code>
4. View MCP setup:  webdeploy mcp
5. Save MCP setup:  webdeploy mcp --output mcp-install.txt

Logs:          sudo webdeploy logs
Configuration: $CONFIG_DIR/webdeploy.env
MCP setup file: $CONFIG_DIR/mcp-install.txt
Data:          $DATA_DIR
Update:        sudo webdeploy update
Uninstall:     sudo webdeploy uninstall
RESULT

WEBDEPLOY_ENV_FILE="$CONFIG_DIR/webdeploy.env" webdeploy mcp
