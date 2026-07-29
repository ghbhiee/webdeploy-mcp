#!/usr/bin/env bash
set -Eeuo pipefail
PURGE_DATA=no
ASSUME_YES=no
while (($#)); do
  case "$1" in
    --purge-data) PURGE_DATA=yes ;;
    --yes) ASSUME_YES=yes ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ $EUID -eq 0 ]] || { echo "Run with sudo." >&2; exit 1; }
CONFIG_DIR="${WEBDEPLOY_CONFIG_DIR:-/etc/webdeploy}"
if [[ -f "$CONFIG_DIR/webdeploy.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$CONFIG_DIR/webdeploy.env"
  set +a
fi
INSTALL_ROOT="${WEBDEPLOY_INSTALL_ROOT:-/opt/webdeploy}"
DATA_DIR="${DATA_DIR:-/var/lib/webdeploy}"
if [[ "$ASSUME_YES" != yes ]]; then
  read -r -p "Remove WebDeploy services and application files? [y/N]: " answer
  [[ "$answer" =~ ^[Yy]$ ]] || exit 0
fi
systemctl disable --now webdeploy-worker webdeploy-update.timer webdeploy-pm2 2>/dev/null || true
PM2_HOME="$DATA_DIR/pm2" pm2 delete webdeploy-control 2>/dev/null || true
PM2_HOME="$DATA_DIR/pm2" pm2 save --force 2>/dev/null || true
rm -f /etc/systemd/system/webdeploy-worker.service \
  /etc/systemd/system/webdeploy-update.service /etc/systemd/system/webdeploy-update.timer \
  /etc/systemd/system/webdeploy-pm2.service
if [[ -n "${NGINX_VHOST_FILE:-}" && -f "$INSTALL_ROOT/current/installer/configure-nginx-path.py" ]]; then
  python3 "$INSTALL_ROOT/current/installer/configure-nginx-path.py" \
    --remove-from "$NGINX_VHOST_FILE" \
    --include "${NGINX_SNIPPET_FILE:-/etc/nginx/snippets/webdeploy-control.conf}"
fi
rm -f /etc/nginx/conf.d/webdeploy-control.conf /usr/local/bin/webdeploy \
  /usr/local/libexec/webdeploy-control "${NGINX_SNIPPET_FILE:-/etc/nginx/snippets/webdeploy-control.conf}"
if nginx -t; then
  systemctl reload nginx
fi
systemctl daemon-reload
if [[ -d "$INSTALL_ROOT" && "$INSTALL_ROOT" != / && "$INSTALL_ROOT" != /opt ]]; then
  rm -rf -- "$INSTALL_ROOT"
fi
if [[ "$PURGE_DATA" == yes ]]; then
  [[ "$DATA_DIR" != / && "$DATA_DIR" != /var && "$DATA_DIR" != /var/lib ]] && rm -rf -- "$DATA_DIR"
  [[ "$CONFIG_DIR" != / && "$CONFIG_DIR" != /etc ]] && rm -rf -- "$CONFIG_DIR"
  runuser -u postgres -- dropdb --if-exists webdeploy
  runuser -u postgres -- dropuser --if-exists webdeploy
  echo "Application, configuration, database, and data were permanently removed."
else
  echo "Application removed. Configuration and data were preserved at $CONFIG_DIR and $DATA_DIR."
fi
