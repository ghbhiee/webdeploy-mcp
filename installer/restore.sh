#!/usr/bin/env bash
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo "Run with sudo." >&2; exit 1; }
backup="${1:-}"
[[ -f "$backup" ]] || { echo "Usage: sudo restore.sh <backup.tar.gz|database.dump>" >&2; exit 2; }
CONFIG_DIR="${WEBDEPLOY_CONFIG_DIR:-/etc/webdeploy}"
set -a
# shellcheck disable=SC1091
source "$CONFIG_DIR/webdeploy.env"
set +a
read -r -p "This replaces the current database. Type RESTORE to continue: " answer
[[ "$answer" == RESTORE ]] || exit 1
webdeploy stop
if [[ "$backup" == *.tar.gz ]]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf -- "$tmp"' EXIT
  tar -xzf "$backup" -C "$tmp"
  dump="$tmp/database.dump"
else
  dump="$backup"
fi
pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL" "$dump"
webdeploy start
echo "Restore completed."
